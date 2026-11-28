import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "../../shared/project.js";
import type { ThumbnailKind } from "../../shared/publish.js";
import { measureFrom, parseSignalStats, scoreFrames, type FrameMeasure, type ThumbnailPreview, type ThumbnailPreviewsResult } from "../../shared/thumb-score.js";
import { neighbourMoments, previewMoments } from "../../shared/thumb-moments.js";
import { defaultTextSide } from "../../shared/thumb-style.js";
import type { TranscriptFile } from "../../shared/transcript.js";
import type { Config } from "../config.js";
import { CanceledError, ffmpeg } from "./exec.js";
import type { JobContext } from "./jobs.js";
import type { ProjectStore } from "./projects.js";
import { frameContext, PREVIEW_CANVAS, planFrame, statsBranches, withGraphFile, type FrameContext } from "./thumbnail-frame.js";
import { TRANSCRIPT_FILE } from "./transcribe.js";

/** Previews are kept for this many jobs per project; older ones are deleted. */
const KEEP_JOBS = 24;
/** At least this many frames are offered even when most are weak: the user can always pick one. */
const MIN_OFFERED = 3;
/** The program shows a screen at the moment, so the speaker looks at it, not at the camera. */
const SCREEN_WEIGHT = 0.85;

async function transcriptWords(dir: string): Promise<{ words: TranscriptFile["words"]; language: "en" | "pl" }> {
  try {
    const transcript = JSON.parse(await readFile(path.join(dir, TRANSCRIPT_FILE), "utf8")) as TranscriptFile;
    return { words: transcript.words, language: transcript.lang === "pl" ? "pl" : "en" };
  } catch {
    return { words: [], language: "en" };
  }
}

async function pruneOld(dir: string): Promise<void> {
  const base = path.join(dir, "thumbs");
  const names = await readdir(base).catch(() => [] as string[]);
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(base, name)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  for (const old of dated.slice(KEEP_JOBS)) await rm(path.join(base, old.name), { recursive: true, force: true });
}

interface Measured {
  atMs: number;
  file: string;
  measure: FrameMeasure;
  weight: number;
}

/** Renders one candidate frame as a preview JPEG and measures it, in one ffmpeg run; null when no picture was recording or the numbers are missing. */
async function renderPreview(ctx: JobContext, config: Config, fc: FrameContext, kind: ThumbnailKind, atMs: number, file: string, name: string): Promise<Measured | null> {
  const plan = await planFrame(fc, { atMs, kind, canvas: PREVIEW_CANVAS[kind], side: defaultTextSide() });
  if (!plan) return null;
  const dumps = { picture: path.join(fc.dir, "tmp", `${name}-pic.txt`), edges: path.join(fc.dir, "tmp", `${name}-edge.txt`) };
  try {
    const graph = `${plan.graph};\n${statsBranches(plan.label, dumps)}`;
    const quiet = ["-frames:v", "1", "-f", "null", "-"];
    await withGraphFile(fc.dir, `${name}-preview.txt`, graph, (script) =>
      ffmpeg(ctx, { ffmpegPath: config.ffmpegPath, threads: ctx.threads }, [...plan.inputs, "-filter_complex_script", script, "-map", "[pv_a]", "-frames:v", "1", "-q:v", "4", "-update", "1", file, "-map", "[pv_pic]", ...quiet, "-map", "[pv_edge]", ...quiet]),
    );
    const measure = measureFrom(parseSignalStats(await readFile(dumps.picture, "utf8")), parseSignalStats(await readFile(dumps.edges, "utf8")));
    return measure ? { atMs, file, measure, weight: plan.subject?.screenFeatured ? SCREEN_WEIGHT : 1 } : null;
  } finally {
    await rm(dumps.picture, { force: true });
    await rm(dumps.edges, { force: true });
  }
}

/**
 * Candidate frames for a thumbnail as real pictures: up to twelve moments of the recording (the highlights, the best clips,
 * the loudest stretches and the sentences that say the most, each moved to the middle of a spoken word), every one rendered
 * the way the thumbnail will be (the speaker's face, zoomed, no text) at one sixth of the size and scored by ffmpeg alone
 * (brightness, contrast, colour, sharpness). Dark, flat and blurry frames are dropped; the rest are sorted best first. With
 * `around` it renders the moments a few tenths of a second either side of that one instead, in time order and all kept, so a
 * blink can be swapped for the next frame. The eyes and the expression are not measured: the person picking the frame judges them.
 */
export function thumbnailPreviewsHandler(deps: { config: Config; store: ProjectStore }) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const kind: ThumbnailKind = job.params.kind === "short" ? "short" : "video";
    const around = typeof job.params.around === "number" && Number.isFinite(job.params.around) ? Math.round(job.params.around) : null;
    const fc = await frameContext(deps.store, job.sid);
    const { project } = fc;
    const { words, language } = await transcriptWords(fc.dir);
    const levels = fc.tracks.filter((track) => track.kind === "camera" && track.levels.length > 0).map((track) => ({ pid: track.id, levels: track.levels }));
    const moments = around === null ? previewMoments({ durationMs: project.durationMs, highlights: project.highlights.map((highlight) => ({ tMs: highlight.atMs })), words, levels, language }) : neighbourMoments(around, project.durationMs);

    const outDir = path.join(fc.dir, "thumbs", job.id);
    await mkdir(outDir, { recursive: true });
    const frames: Measured[] = [];
    let failure: unknown = null;
    for (const [index, atMs] of moments.entries()) {
      ctx.progress(index / Math.max(1, moments.length), "frame");
      try {
        const frame = await renderPreview(ctx, deps.config, fc, kind, atMs, path.join(outDir, `${String(index).padStart(2, "0")}.jpg`), `${job.id}-${index}`);
        if (frame) frames.push(frame);
      } catch (error) {
        if (error instanceof CanceledError) throw error;
        failure = error;
      }
    }
    if (frames.length === 0 && failure !== null) throw failure;

    const scored = scoreFrames(frames.map((frame) => frame.measure)).map((result, index) => {
      const frame = frames[index] as Measured;
      return { frame, score: result.score * frame.weight, weak: result.reject };
    });
    const strong = scored.filter((item) => item.weak === null);
    const weak = scored.filter((item) => item.weak !== null).sort((a, b) => b.score - a.score);
    const offered = around === null ? [...strong, ...weak.slice(0, Math.max(0, MIN_OFFERED - strong.length))] : scored;
    offered.sort(around === null ? (a, b) => b.score - a.score || a.frame.atMs - b.frame.atMs : (a, b) => a.frame.atMs - b.frame.atMs);
    const kept = new Set(offered.map((item) => item.frame.file));
    for (const frame of frames) if (!kept.has(frame.file)) await rm(frame.file, { force: true });
    await pruneOld(fc.dir);
    const previews: ThumbnailPreview[] = offered.map((item) => ({ atMs: item.frame.atMs, file: path.relative(fc.dir, item.frame.file), score: Math.round(item.score * 100) / 100, weak: item.weak }));
    return { kind, ...(around === null ? {} : { around }), previews } satisfies ThumbnailPreviewsResult;
  };
}
