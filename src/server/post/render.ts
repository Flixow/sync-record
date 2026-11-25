import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TranscriptFile } from "../../shared/transcript.js";
import { captionFilter, captionSidecars, captionStyleById, layoutCaptions, toAss } from "../../shared/captions.js";
import { complement, keptRanges, normalize, type Edl, type Range } from "../../shared/edl.js";
import type { Background } from "../../shared/layout.js";
import { remapScenes, type Scene } from "../../shared/scenes.js";
import { gopFrames, presetAspect, presetById, type AudioPreset, type Preset, type VideoPreset } from "../../shared/presets.js";
import type { JobRecord, ProjectFile, ProjectSource } from "../../shared/project.js";
import { frameMs } from "../../shared/project.js";
import type { Config } from "../config.js";
import { TRANSCRIPT_FILE } from "./transcribe.js";
import { readEdl } from "./edl-store.js";
import { cleanInputsGraph, DEFAULT_CLEAN, prepareClean, type CleanOptions, type CleanTrack } from "./audio-clean.js";
import { layoutSources, resolveScenes } from "./layout-plan.js";
import { layoutVideoGraph } from "./render-layout.js";
import { readScenes } from "./scenes-store.js";
import { addExport } from "./exports.js";
import { ffmpeg, runTool, type ToolContext } from "./exec.js";
import type { JobContext } from "./jobs.js";
import type { ProjectStore } from "./projects.js";
import { FADE_MS } from "./render-audio.js";

/** The bundled caption fonts; `assets/` sits next to `src/` and `dist/` in a checkout and in the image. */
export const FONTS_DIR = fileURLToPath(new URL("../../../assets/fonts", import.meta.url));

export interface RenderDeps {
  config: Config;
  store: ProjectStore;
}

/** `{s, e}` in ms on the project timeline, or null when the whole recording is rendered. */
export function parseRenderRange(value: unknown, durationMs: number): Range | null {
  if (value === undefined || value === null) return null;
  const range = value as Partial<Range>;
  if (typeof range.s !== "number" || typeof range.e !== "number" || !Number.isFinite(range.s) || !Number.isFinite(range.e) || range.s < 0 || range.e <= range.s) throw new Error("invalid range");
  return { s: Math.round(range.s), e: Math.min(durationMs, Math.round(range.e)) };
}

export interface Loudness {
  lufs: number;
  truePeakDb: number;
}

/** Kept ranges snapped to the frame grid of `fps`, so audio and video are cut at the same instants. */
export function snapRanges(kept: Range[], fps: number): Range[] {
  const frame = frameMs(fps);
  const out: Range[] = [];
  for (const range of kept) {
    const s = Math.round(range.s / frame) * frame;
    const e = Math.round(range.e / frame) * frame;
    if (e - s < frame / 2) continue;
    const last = out[out.length - 1];
    if (last && s <= last.e) last.e = Math.max(last.e, e);
    else out.push({ s, e });
  }
  return out;
}

const sec = (ms: number): string => (ms / 1000).toFixed(6);

/**
 * Audio of the program: every conformed track mixed, cut to the kept ranges with a short fade on every join, as
 * stereo. Returns the graph text and the label of its output.
 */
export function audioProgramGraph(inputs: number, kept: Range[], totalMs: number, fadeMs = FADE_MS, wired?: { lines: string[]; labels: string[] }): { graph: string; label: string } {
  const lines: string[] = [...(wired?.lines ?? [])];
  const pads = wired?.labels ?? Array.from({ length: inputs }, (_, i) => `[${i}:a]`);
  const mix = inputs === 1 ? `${pads[0]}alimiter=limit=0.95[mix]` : `${pads.join("")}amix=inputs=${inputs}:normalize=0:duration=longest,alimiter=limit=0.95[mix]`;
  lines.push(mix);
  if (kept.length === 1) {
    lines.push(`[mix]atrim=start=${sec((kept[0] as Range).s)}:end=${sec((kept[0] as Range).e)},asetpts=PTS-STARTPTS[cat]`);
  } else {
    lines.push(`[mix]asplit=${kept.length}${kept.map((_, i) => `[s${i}]`).join("")}`);
    kept.forEach((range, i) => {
      const length = range.e - range.s;
      const fade = Math.min(fadeMs, length / 2);
      const f = [`atrim=start=${sec(range.s)}:end=${sec(range.e)}`, "asetpts=PTS-STARTPTS"];
      if (fade > 0 && range.s > 0) f.push(`afade=t=in:st=0:d=${sec(fade)}`);
      if (fade > 0 && range.e < totalMs) f.push(`afade=t=out:st=${sec(length - fade)}:d=${sec(fade)}`);
      lines.push(`[s${i}]${f.join(",")}[k${i}]`);
    });
    lines.push(`${kept.map((_, i) => `[k${i}]`).join("")}concat=n=${kept.length}:v=0:a=1[cat]`);
  }
  lines.push("[cat]pan=stereo|c0=c0|c1=c0[stereo]");
  return { graph: lines.join(";\n"), label: "[stereo]" };
}

/** x264 + AAC settings for an upload to YouTube: High profile, 4:2:0, 2 B-frames, closed GOP of half a second, moov first, no edit list. */
export function videoEncodeArgs(preset: VideoPreset, threads: number, x264Preset: string): string[] {
  const gop = gopFrames(preset.fps);
  return [
    "-c:v", "libx264", "-preset", x264Preset, "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-b:v", String(preset.videoBitrate), "-maxrate", String(Math.round(preset.videoBitrate * 1.25)), "-bufsize", String(preset.videoBitrate * 2),
    "-bf", "2", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-flags", "+cgop",
    "-x264-params", `open-gop=0:bframes=2:keyint=${gop}:min-keyint=${gop}`,
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", String(preset.audioBitrate), "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart+negative_cts_offsets", "-use_editlist", "0", "-threads", String(threads), "-f", "mp4",
  ];
}

export interface Measured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** First loudnorm pass: measures the program audio without writing it. */
/** An ffmpeg input: its file and the options that go right before it. */
export interface RenderInput {
  file: string;
  args?: string[];
}

const inputArgs = (inputs: RenderInput[]): string[] => inputs.flatMap((input) => [...(input.args ?? []), "-i", input.file]);

async function measureLoudness(ctx: JobContext, deps: RenderDeps, dir: string, inputs: RenderInput[], graph: string, label: string, target: Loudness): Promise<Measured> {
  const script = path.join(dir, "tmp", `${ctx.jobId}-measure.txt`);
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, `${graph};\n${label}loudnorm=I=${target.lufs}:TP=${target.truePeakDb}:LRA=11:print_format=json[out]`);
  try {
    const { stderr } = await runTool(ctx, deps.config.ffmpegPath, ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", ...inputArgs(inputs), "-filter_complex_script", script, "-map", "[out]", "-f", "null", "-"]);
    const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
    if (!json) throw new Error("loudness measurement produced no result");
    return JSON.parse(json) as Measured;
  } finally {
    await rm(script, { force: true });
  }
}

export const loudnormFilter = (target: Loudness, measured: Measured): string =>
  `loudnorm=I=${target.lufs}:TP=${target.truePeakDb}:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,aresample=48000`;

function audioEncodeArgs(preset: AudioPreset): string[] {
  return preset.codec === "mp3"
    ? ["-c:a", "libmp3lame", "-b:a", String(preset.bitrate), "-ar", "48000", "-f", "mp3"]
    : ["-c:a", "pcm_s16le", "-ar", "48000", "-f", "wav"];
}

/**
 * Scenes of the program on the output timeline. A render that names one source shows only that picture; otherwise the
 * saved scene plan decides (automatic active-speaker switching plus the manual overrides).
 */
export async function programScenes(project: ProjectFile, dir: string, kept: Range[], wanted: unknown): Promise<Scene[]> {
  let scenes: Scene[];
  if (typeof wanted === "string") {
    if (!layoutSources(project).some((source) => source.id === wanted)) throw new Error("that source has no video");
    scenes = [{ s: 0, e: project.durationMs, layout: "solo", sources: [wanted] }];
  } else {
    scenes = await resolveScenes(project, dir, (await readScenes(dir)).plan);
  }
  if (scenes.length === 0) throw new Error("this project has no video: pick an audio preset");
  return remapScenes(scenes, { removed: complement(kept, 0, project.durationMs) });
}

/**
 * Export: cuts the edit into the program, normalises the loudness (two passes) and encodes one file per preset into
 * `exports/<job id>/`. Audio comes from the conformed tracks, video from the original recording conformed at full size.
 */
export function renderHandler(deps: RenderDeps) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    const preset: Preset | null = presetById(String(job.params.preset ?? ""));
    if (!preset) throw new Error("unknown preset");
    const project = await deps.store.require(job.sid);
    const dir = deps.store.dir(job.sid);
    const audioSources = project.sources.filter((source) => source.audio !== null);
    if (audioSources.length === 0) throw new Error("no conformed audio: run the conform job first");
    const edl: Edl & { rev: number } = await readEdl(dir);
    const fps = preset.kind === "video" ? preset.fps : 30;
    // A clip renders only its range of the (cut) recording.
    const range = parseRenderRange(job.params.range, project.durationMs);
    const effective: Edl = range ? { removed: normalize([...edl.removed, { s: 0, e: range.s }, { s: range.e, e: project.durationMs }], project.durationMs) } : edl;
    const kept = snapRanges(keptRanges(effective, project.durationMs), fps);
    if (kept.length === 0) throw new Error("everything is removed");
    const keptMs = kept.reduce((sum, range) => sum + (range.e - range.s), 0);
    const target: Loudness = {
      lufs: typeof job.params.lufs === "number" ? job.params.lufs : deps.config.post.loudnessLufs,
      truePeakDb: typeof job.params.truePeakDb === "number" ? job.params.truePeakDb : deps.config.post.truePeakDb,
    };
    const loudnessOn = job.params.normalize !== false;

    const inputs: RenderInput[] = audioSources.map((source) => ({ file: path.join(dir, source.audio?.file ?? "") }));
    const cleanOptions = parseClean(job.params.clean, deps.config);
    const cleanDir = path.join(dir, "tmp", `${job.id}-clean`);
    let wired: { lines: string[]; labels: string[] } | undefined;
    if (cleanOptions) {
      // microphones only: the sound of a shared screen stays in the mix as it is
      const mics = audioSources.map((source, index) => ({ source, index })).filter(({ source }) => source.kind !== "screen");
      const tracks: CleanTrack[] = [];
      for (const { source } of mics) {
        const levels = await readFile(path.join(dir, source.audio?.levels ?? ""));
        tracks.push({ id: source.id, file: path.join(dir, source.audio?.file ?? ""), levels: new Int8Array(levels.buffer, levels.byteOffset, levels.byteLength) });
      }
      await mkdir(cleanDir, { recursive: true });
      const prepared = await prepareClean(cleanOptions, tracks, cleanDir);
      const first = inputs.length;
      prepared.extraInputs.forEach((file, i) => inputs.push({ file, args: prepared.inputArgs[i] ?? [] }));
      const cleaned = cleanInputsGraph(prepared, mics.map(({ index }) => index), first);
      const labels = audioSources.map((_, index) => `[${index}:a]`);
      mics.forEach(({ index }, k) => { labels[index] = cleaned.labels[k] as string; });
      wired = { lines: cleaned.lines, labels };
    }
    const audio = audioProgramGraph(audioSources.length, kept, project.durationMs, undefined, wired);
    let measured: Measured | null = null;
    ctx.progress(0.01, "loudness");
    if (loudnessOn) measured = await measureLoudness(ctx, deps, dir, inputs, audio.graph, audio.label, target);
    // a silent program has nothing to normalise (loudnorm measures -inf and refuses it)
    if (measured && !(Number(measured.input_i) > -70)) measured = null;
    ctx.progress(0.1, "encode");

    const outDir = path.join(dir, "exports", job.id);
    await mkdir(outDir, { recursive: true });
    const clipTag = typeof job.params.clip === "string" && /^[a-z0-9-]{1,64}$/.test(job.params.clip) ? `-${job.params.clip}` : "";
    const base = `export-${preset.id}${clipTag}.${preset.extension}`;
    const temp = path.join(outDir, `part-${base}`);
    let graph = audio.graph;
    // The AAC encoder adds 1024 samples of priming silence. With no edit list to skip them, the audio is advanced by
    // that much (and padded at the end), so decoded audio and video line up.
    const advance = preset.kind === "video" ? ",atrim=start_sample=1024,asetpts=PTS-STARTPTS,apad=pad_len=1024" : "";
    const aLabel = `${audio.label}${measured ? loudnormFilter(target, measured) : "anull"}${advance}[aout]`;
    graph += `;\n${aLabel}`;
    let args: string[];
    let videoLabel: string;
    const cleanup: string[] = [];
    const removed = complement(kept, 0, project.durationMs);
    if (preset.kind === "video") {
      const scenes = await programScenes(project, dir, kept, job.params.source);
      const used = new Set(scenes.flatMap((scene) => scene.sources));
      const videoInputs: { source: ProjectSource; input: number }[] = [];
      for (const source of project.sources.filter((item) => item.hasVideo && used.has(item.id))) {
        inputs.push({ file: await deps.store.localSource(job.sid, source.sourceKey, source.id) });
        videoInputs.push({ source, input: inputs.length - 1 });
      }
      const saved = await readScenes(dir);
      const aspect = presetAspect(preset);
      const background: Background = saved.rev === 0 && aspect !== "16:9" ? { kind: "blur", sigma: 40 } : saved.background;
      const video = layoutVideoGraph({ inputs: videoInputs, canvas: { width: preset.width, height: preset.height }, fps: preset.fps, scenes, kept, totalMs: project.durationMs, background });
      graph += `;\n${video.graph}`;
      videoLabel = video.label;
      const captionsParam = job.params.captions;
      if (captionsParam !== undefined && captionsParam !== null && captionsParam !== false) {
        const styleId = typeof captionsParam === "object" && captionsParam !== null && typeof (captionsParam as Record<string, unknown>).style === "string" ? String((captionsParam as Record<string, unknown>).style) : "clean";
        const style = captionStyleById(styleId);
        if (!style) throw new Error(`unknown caption style ${styleId}`);
        const transcript = await readTranscript(dir);
        const canvas = { width: preset.width, height: preset.height };
        const events = layoutCaptions(transcript.words, canvas, style, { removed });
        const ass = path.join(dir, "tmp", `${job.id}-captions.ass`);
        await writeFile(ass, toAss(events, canvas, style));
        graph += `;\n${videoLabel}${captionFilter(ass, FONTS_DIR)}[vcap]`;
        videoLabel = "[vcap]";
        cleanup.push(ass);
      }
      const x264Preset = typeof job.params.x264Preset === "string" && /^[a-z]+$/.test(job.params.x264Preset) ? job.params.x264Preset : "veryfast";
      args = ["-map", videoLabel, "-map", "[aout]", ...videoEncodeArgs(preset, ctx.threads, x264Preset), "-t", sec(keptMs), temp];
    } else {
      args = ["-map", "[aout]", ...audioEncodeArgs(preset), temp];
    }
    const script = path.join(dir, "tmp", `${job.id}-render.txt`);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, graph);
    try {
      await ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: keptMs / 1000, onProgress: (fraction) => ctx.progress(0.1 + 0.88 * fraction, "encode") }, [...inputArgs(inputs), "-filter_complex_script", script, ...args]);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    } finally {
      await rm(script, { force: true });
      for (const file of cleanup) await rm(file, { force: true });
      await rm(cleanDir, { recursive: true, force: true });
    }
    const finalPath = path.join(outDir, base);
    await rename(temp, finalPath);
    const info = await stat(finalPath);
    if (job.params.captions !== undefined && job.params.captions !== false && preset.kind === "video" && job.params.sidecars !== false) {
      const transcript = await readTranscript(dir);
      const names = new Map(transcript.speakers.map((speaker) => [speaker.pid, speaker.name]));
      const sidecars = captionSidecars(transcript.words, { removed, speakers: true, nameOf: (pid) => names.get(pid) ?? pid });
      await writeFile(path.join(outDir, `export-${preset.id}${clipTag}.srt`), sidecars.srt);
      await writeFile(path.join(outDir, `export-${preset.id}${clipTag}.vtt`), sidecars.vtt);
    }
    await addExport(dir, { id: job.id, preset: preset.id, file: path.join("exports", job.id, base), bytes: info.size, durationMs: Math.round(keptMs), createdAtMs: Date.now(), loudnessLufs: loudnessOn ? target.lufs : null, edlRev: edl.rev });
    if (deps.config.post.retention === "keep-exports") await deps.store.dropIntermediates(job.sid, "proxies").catch(() => undefined);
    return { file: path.join("exports", job.id, base), bytes: info.size, keptMs, wallMs: Date.now() - startedAt, measured };
  };
}

/** The cleanup options of a render request, or null when nothing is switched on. The denoiser model lives in the models directory. */
export function parseClean(value: unknown, config: Config): CleanOptions | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const options: CleanOptions = {
    ...DEFAULT_CLEAN,
    level: o.level === true,
    bleedGate: o.bleedGate === true,
    denoise: o.denoise === true,
    ...(typeof o.bleedGateDb === "number" ? { bleedGateDb: o.bleedGateDb } : {}),
    rnnoiseModel: path.join(config.post.modelsDir, "rnnoise", "bd.rnnn"),
  };
  return options.level || options.bleedGate || options.denoise ? options : null;
}

async function readTranscript(dir: string): Promise<TranscriptFile> {
  try {
    return JSON.parse(await readFile(path.join(dir, TRANSCRIPT_FILE), "utf8")) as TranscriptFile;
  } catch {
    throw new Error("captions need a transcript: run the transcript job first");
  }
}

export type { ToolContext };
