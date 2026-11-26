import { execFile } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CONFORM_SAMPLE_RATE, LEVEL_FLOOR_DB, LEVEL_FRAME_MS, PEAKS_PER_SECOND, PROXY_HEIGHT, frameMs, type JobRecord, type ProjectFile, type ProjectSource } from "../../shared/project.js";
import type { Config } from "../config.js";
import { ffmpeg, runTool } from "./exec.js";
import type { JobContext } from "./jobs.js";
import type { ProjectStore } from "./projects.js";

const run = promisify(execFile);

/** Sample rate the drift correction resamples through: asetrate takes an integer, so a high rate keeps its error below 3 ppm. */
const DRIFT_PIVOT_RATE = 384_000;

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

async function durationOf(ffprobePath: string, file: string): Promise<number> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

/**
 * Where a video file ends on its own timeline. The container's duration counts from the first frame, which sits one
 * frame after zero when the start offset rounds up to the next frame (the proxy then starts with an empty edit, not
 * with a frame), so the duration alone is up to a frame short of the position the last frame ends at.
 */
export async function timelineEndOf(ffprobePath: string, file: string): Promise<number> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=start_time,duration", "-of", "default=nw=1", file]);
  const value = (key: string): number => Number(new RegExp(`^${key}=(.+)$`, "m").exec(stdout)?.[1] ?? "NaN");
  return value("start_time") + value("duration");
}

/** The audio filter that puts a source on the project timeline: drift correction, start offset, padding to the project length. */
export function audioConformFilter(source: Pick<ProjectSource, "rate" | "driftApplied" | "offsetMs">, projectDurationSec: number): string {
  // Browsers drop an audio packet now and then: the file's timestamps then run ahead of its samples. Filling the gaps
  // with silence keeps the samples on the clock, so the padding and the trim below land on the project length.
  const chain: string[] = ["asetpts=PTS-STARTPTS", "aresample=async=1000:first_pts=0"];
  if (source.driftApplied) {
    chain.push(`aresample=${DRIFT_PIVOT_RATE}`, `asetrate=${Math.round(DRIFT_PIVOT_RATE * source.rate)}`, `aresample=${CONFORM_SAMPLE_RATE}`);
  }
  if (source.offsetMs > 0) chain.push(`adelay=${source.offsetMs.toFixed(3)}ms:all=1`);
  chain.push(`apad=whole_dur=${projectDurationSec.toFixed(6)}`, `atrim=end=${projectDurationSec.toFixed(6)}`);
  return chain.join(",");
}

/**
 * The video filter chain that puts a source on the project timeline at a constant frame rate: the start offset and
 * the drift correction, then `finish` (the scaling for the proxy or for an export).
 */
export function videoTimelineFilter(source: Pick<ProjectSource, "rate" | "offsetMs">, fps: number, finish: string[]): string {
  // The start offset is split: whole frames become black frames in front, the remainder shifts the timestamps before
  // the frame rate conversion, which then rounds to the nearest frame. The start is therefore off by at most half a frame.
  const padFrames = Math.floor(source.offsetMs / frameMs(fps) + 1e-6);
  const remainderSec = Math.max(0, source.offsetMs - padFrames * frameMs(fps)) / 1000;
  const chain = [`setpts=(PTS-STARTPTS)/${source.rate.toFixed(9)}+${remainderSec.toFixed(6)}/TB`, `fps=${fps}`, ...finish];
  if (padFrames > 0) chain.push(`tpad=start_duration=${(padFrames / fps).toFixed(6)}:color=black`);
  chain.push("setsar=1", "format=yuv420p");
  return chain.join(",");
}

/** The video filter that makes a constant-frame-rate proxy on the project timeline. */
export function videoProxyFilter(source: Pick<ProjectSource, "rate" | "offsetMs">, fps: number): string {
  return videoTimelineFilter(source, fps, [`scale=-2:${PROXY_HEIGHT}:flags=bilinear`]);
}

/**
 * How far a video proxy may end from the end of its source on the timeline, in frames: the start rounds to the nearest
 * frame, the frame rate conversion ends the last frame up to half a frame off, and the source's own duration (the
 * container's estimate for a variable-frame-rate recording) is itself good to about a frame.
 */
const VIDEO_END_TOLERANCE_FRAMES = 2;

export interface ConformCheck {
  file: string;
  expectedSec: number;
  actualSec: number;
  inTolerance: boolean;
}

export interface ConformDeps {
  config: Config;
  store: ProjectStore;
  cpus: number;
}

/**
 * One pass over the conformed audio that writes the waveform peaks (the largest absolute sample of every 10 ms, one
 * unsigned byte) and the level track (RMS of every 20 ms in dBFS, one signed byte) that voice activity detection,
 * silence trimming and speaker switching read.
 */
async function writeAnalysis(ctx: JobContext, deps: ConformDeps, flac: string, peaksOut: string, levelsOut: string): Promise<void> {
  const peakWindow = CONFORM_SAMPLE_RATE / PEAKS_PER_SECOND;
  const levelWindow = (CONFORM_SAMPLE_RATE * LEVEL_FRAME_MS) / 1000;
  const peaks: number[] = [];
  const levels: number[] = [];
  let leftover: Buffer = Buffer.alloc(0);
  let peak = 0;
  let peakCount = 0;
  let squares = 0;
  let levelCount = 0;
  const level = (): number => Math.max(LEVEL_FLOOR_DB, Math.min(0, Math.round(10 * Math.log10(squares / levelCount / 32768 ** 2 + 1e-12))));
  const consume = (chunk: Buffer): void => {
    const data = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
    const whole = data.length - (data.length % 2);
    for (let offset = 0; offset < whole; offset += 2) {
      const sample = data.readInt16LE(offset);
      const value = Math.abs(sample);
      if (value > peak) peak = value;
      squares += sample * sample;
      peakCount += 1;
      levelCount += 1;
      if (peakCount === peakWindow) {
        peaks.push(Math.min(255, Math.round((peak / 32768) * 255)));
        peak = 0;
        peakCount = 0;
      }
      if (levelCount === levelWindow) {
        levels.push(level());
        squares = 0;
        levelCount = 0;
      }
    }
    leftover = data.subarray(whole);
  };
  await runTool(ctx, deps.config.ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", flac, "-ac", "1", "-ar", String(CONFORM_SAMPLE_RATE), "-f", "s16le", "-"], { onStdout: consume });
  if (peakCount > 0) peaks.push(Math.min(255, Math.round((peak / 32768) * 255)));
  if (levelCount > 0) levels.push(level());
  await writeAtomic(peaksOut, Uint8Array.from(peaks));
  await writeAtomic(levelsOut, Int8Array.from(levels));
}

async function writeAtomic(file: string, data: Uint8Array | Int8Array): Promise<void> {
  const temp = `${file}.part`;
  await writeFile(temp, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  await rename(temp, file);
}

/**
 * Conform: puts every source on the shared timeline. Audio becomes a mono FLAC that starts at project time 0
 * (offset applied, drift corrected, padded to the project length); video becomes a 480p constant-frame-rate
 * proxy; one mixed audio proxy serves the browser player. Every step skips outputs that already exist, so a job
 * that was interrupted continues where it stopped.
 */
export function conformHandler(deps: ConformDeps) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    const sid = job.sid;
    const dir = deps.store.dir(sid);
    await deps.store.update(sid, (project) => {
      project.conform = { status: "running", atMs: Date.now(), error: null, wallMs: null };
    });
    try {
      const project = await deps.store.require(sid);
      const projectSec = project.durationMs / 1000;
      const weights = project.sources.map((source) => source.mediaDurationSec * ((source.hasVideo ? 6 : 0) + (source.hasAudio ? 1 : 0)));
      const total = weights.reduce((sum, weight) => sum + weight, 0) + projectSec * 0.5 || 1;
      let doneWeight = 0;
      const checks: ConformCheck[] = [];
      const frameSec = 1 / project.fps;

      for (const [index, source] of project.sources.entries()) {
        const local = await deps.store.localSource(sid, source.sourceKey, source.id);
        const weight = weights[index] ?? 0;
        const audioShare = source.hasAudio ? 1 / (source.hasVideo ? 7 : 1) : 0;
        const stageProgress = (fraction: number, share: number, base: number): void => ctx.progress((doneWeight + base * weight + fraction * share * weight) / total, `${source.participantName} ${source.kind}`);

        if (source.hasAudio) {
          const audioFile = path.join("conformed", `${source.id}.flac`);
          const peaksFile = path.join("peaks", `${source.id}.bin`);
          const levelsFile = path.join("levels", `${source.id}.bin`);
          const absolute = path.join(dir, audioFile);
          if (!(await exists(absolute))) {
            await mkdir(path.dirname(absolute), { recursive: true });
            const temp = path.join(dir, "conformed", `${source.id}.part.flac`);
            await ffmpeg(
              ctx,
              { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: source.mediaDurationSec, onProgress: (fraction) => stageProgress(fraction, audioShare, 0) },
              ["-i", local, "-map", "0:a:0", "-vn", "-af", audioConformFilter(source, projectSec), "-ac", "1", "-ar", String(CONFORM_SAMPLE_RATE), "-c:a", "flac", "-compression_level", "5", "-threads", String(ctx.threads), temp],
            );
            await rename(temp, absolute);
          }
          const peaksAbsolute = path.join(dir, peaksFile);
          const levelsAbsolute = path.join(dir, levelsFile);
          if (!(await exists(peaksAbsolute)) || !(await exists(levelsAbsolute))) {
            await mkdir(path.dirname(peaksAbsolute), { recursive: true });
            await mkdir(path.dirname(levelsAbsolute), { recursive: true });
            await writeAnalysis(ctx, deps, absolute, peaksAbsolute, levelsAbsolute);
          }
          const actual = await durationOf(deps.config.ffprobePath, absolute);
          checks.push({ file: audioFile, expectedSec: projectSec, actualSec: actual, inTolerance: Math.abs(actual - projectSec) <= frameSec });
          await deps.store.update(sid, (draft) => {
            const target = draft.sources.find((candidate) => candidate.id === source.id);
            if (target) target.audio = { file: audioFile, peaks: peaksFile, levels: levelsFile };
          });
        }

        if (source.hasVideo) {
          const videoFile = path.join("proxies", `${source.id}.mp4`);
          const absolute = path.join(dir, videoFile);
          if (!(await exists(absolute))) {
            await mkdir(path.dirname(absolute), { recursive: true });
            const temp = path.join(dir, "proxies", `${source.id}.part.mp4`);
            await ffmpeg(
              ctx,
              { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: source.mediaDurationSec, onProgress: (fraction) => stageProgress(fraction, 1 - audioShare, audioShare) },
              [
                "-i", local, "-map", "0:v:0", "-an", "-vf", videoProxyFilter(source, project.fps),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", String(project.fps), "-threads", String(ctx.threads),
                "-movflags", "+faststart", "-f", "mp4", temp,
              ],
            );
            await rename(temp, absolute);
          }
          const expected = (source.offsetMs + source.timelineDurationMs) / 1000;
          const actual = await timelineEndOf(deps.config.ffprobePath, absolute);
          checks.push({ file: videoFile, expectedSec: expected, actualSec: actual, inTolerance: Math.abs(actual - expected) <= VIDEO_END_TOLERANCE_FRAMES * frameSec });
          await deps.store.update(sid, (draft) => {
            const target = draft.sources.find((candidate) => candidate.id === source.id);
            if (target) target.video = { file: videoFile, width: Math.round(((source.width ?? 16) / (source.height ?? 9)) * PROXY_HEIGHT / 2) * 2, height: PROXY_HEIGHT, fps: project.fps };
          });
        }
        doneWeight += weight;
      }

      const mix = await buildMix(ctx, deps, await deps.store.require(sid), dir, (fraction) => ctx.progress((doneWeight + fraction * projectSec * 0.5) / total, "mix"));
      if (mix) checks.push(mix);
      const late = checks.filter((check) => !check.inTolerance);
      if (late.length > 0) {
        throw new Error(`duration check failed: ${late.map((check) => `${check.file} expected ${check.expectedSec.toFixed(3)} s, got ${check.actualSec.toFixed(3)} s`).join("; ")}`);
      }
      const wallMs = Date.now() - startedAt;
      await deps.store.update(sid, (draft) => {
        draft.conform = { status: "done", atMs: Date.now(), error: null, wallMs };
      });
      return { wallMs, checks };
    } catch (error) {
      await deps.store.update(sid, (draft) => {
        draft.conform = { status: "failed", atMs: Date.now(), error: error instanceof Error ? error.message.slice(0, 300) : "conform failed", wallMs: null };
      }).catch(() => undefined);
      throw error;
    }
  };
}

/** One mixed audio file for the browser player. Returns the duration check, or null when no source has audio. */
async function buildMix(ctx: JobContext, deps: ConformDeps, project: ProjectFile, dir: string, onProgress: (fraction: number) => void): Promise<ConformCheck | null> {
  const inputs = project.sources.filter((source) => source.audio !== null);
  if (inputs.length === 0) return null;
  const file = path.join("proxies", "mix.m4a");
  const absolute = path.join(dir, file);
  const projectSec = project.durationMs / 1000;
  if (!(await exists(absolute))) {
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = path.join(dir, "proxies", "mix.part.m4a");
    const args: string[] = [];
    for (const source of inputs) args.push("-i", path.join(dir, source.audio?.file ?? ""));
    const labels = inputs.map((_, index) => `[${index}:a]`).join("");
    const filter = inputs.length === 1 ? "[0:a]alimiter=limit=0.95[out]" : `${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest,alimiter=limit=0.95[out]`;
    await ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: projectSec, onProgress }, [
      ...args, "-filter_complex", filter, "-map", "[out]", "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-threads", String(ctx.threads), "-movflags", "+faststart", "-f", "mp4", temp,
    ]);
    await rename(temp, absolute);
  }
  await deps.store.update(project.id, (draft) => {
    draft.mixProxy = file;
  });
  const actual = await durationOf(deps.config.ffprobePath, absolute);
  // AAC pads its last frame: allow the encoder delay on top of one video frame.
  return { file, expectedSec: projectSec, actualSec: actual, inTolerance: Math.abs(actual - projectSec) <= 1 / project.fps + 0.05 };
}
