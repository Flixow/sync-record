import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectSource } from "../../shared/project.js";
import { frameMs } from "../../shared/project.js";
import { overlayTextLayout, thumbnailSpec, type ThumbnailKind } from "../../shared/publish.js";
import { sceneAt } from "../../shared/scenes.js";
import type { Config } from "../config.js";
import { addExport } from "./exports.js";
import { ffmpeg } from "./exec.js";
import type { JobContext } from "./jobs.js";
import { layoutSources, resolveScenes } from "./layout-plan.js";
import type { ProjectStore } from "./projects.js";
import { FONTS_DIR } from "./render.js";
import { layoutVideoGraph } from "./render-layout.js";
import { readScenes } from "./scenes-store.js";
import type { JobRecord } from "../../shared/project.js";

const FPS = 30;
/** Decoding starts this long before the wanted frame: the keyframe the seek lands on is further back than that. */
const LEAD_MS = 4000;

/** `ffmpeg drawtext` value escaping (the text goes through a file, so only the path needs it). */
const escapePath = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;

/**
 * Thumbnail: one frame of the program (the scene plan's layout at that instant, at full size) as a JPEG, with an
 * optional text plate. The recordings are seeked, not decoded from the start, so it takes seconds on a long recording.
 */
export function thumbnailHandler(deps: { config: Config; store: ProjectStore }) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const kind: ThumbnailKind = job.params.kind === "short" ? "short" : "video";
    const spec = thumbnailSpec(kind);
    const canvas = { width: spec.width, height: spec.height };
    const project = await deps.store.require(job.sid);
    const dir = deps.store.dir(job.sid);
    const at = Number(job.params.atMs);
    if (!Number.isFinite(at) || at < 0 || at > project.durationMs) throw new Error("atMs is outside the recording");
    const text = typeof job.params.text === "string" ? job.params.text.trim().slice(0, 140) : "";

    const scenes = await resolveScenes(project, dir, (await readScenes(dir)).plan);
    const scene = sceneAt(scenes, at) ?? scenes[0];
    if (!scene) throw new Error("this project has no video");
    const sources = layoutSources(project);
    const used = project.sources.filter((source) => source.hasVideo && scene.sources.includes(source.id) && sources.some((item) => item.id === source.id));
    const t0 = Math.max(0, at - LEAD_MS);
    const frame = frameMs(FPS);
    const rel = Math.round((at - t0) / frame) * frame;
    const inputs: string[] = [];
    const args: string[] = [];
    const videoInputs: { source: ProjectSource; input: number }[] = [];
    for (const source of used) {
      // seek the original to the instant t0 and describe it as a source whose timeline starts there
      const media = Math.max(0, ((t0 - source.offsetMs) / 1000) * source.rate);
      const offset = Math.max(0, source.offsetMs - t0);
      const file = await deps.store.localSource(job.sid, source.sourceKey, source.id);
      inputs.push(file);
      args.push("-ss", media.toFixed(3), "-i", file);
      videoInputs.push({ source: { ...source, offsetMs: offset }, input: inputs.length - 1 });
    }
    if (videoInputs.length === 0) throw new Error("no picture source at that moment");
    const aspectScene = { s: 0, e: frame, layout: scene.layout, sources: scene.sources, ...(scene.fit ? { fit: scene.fit } : {}) };
    const saved = await readScenes(dir);
    const background = saved.rev === 0 && kind === "short" ? ({ kind: "blur", sigma: 40 } as const) : saved.background;
    const video = layoutVideoGraph({ inputs: videoInputs, canvas, fps: FPS, scenes: [aspectScene], kept: [{ s: rel, e: rel + frame }], totalMs: rel + 2000, background });
    let graph = video.graph;
    let label = video.label;
    const cleanup: string[] = [];
    if (text) {
      const layout = overlayTextLayout(text, canvas);
      const pad = Math.round(layout.fontSize * 0.3);
      const parts = [`drawbox=x=${layout.box.x}:y=${layout.box.y}:w=${layout.box.w}:h=${layout.box.h}:color=black@0.62:t=fill`];
      for (let i = 0; i < layout.lines.length; i++) {
        const file = path.join(dir, "tmp", `${job.id}-line${i}.txt`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, layout.lines[i] as string);
        cleanup.push(file);
        parts.push(`drawtext=fontfile=${escapePath(path.join(FONTS_DIR, "NotoSans-Bold.ttf"))}:textfile=${escapePath(file)}:fontsize=${layout.fontSize}:fontcolor=white:x=${layout.box.x + pad}:y=${Math.round(layout.box.y + pad + i * layout.fontSize * 1.15)}`);
      }
      graph += `;\n${label}${parts.join(",")}[vtxt]`;
      label = "[vtxt]";
    }
    const script = path.join(dir, "tmp", `${job.id}-thumb.txt`);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, graph);
    cleanup.push(script);
    const outDir = path.join(dir, "exports", job.id);
    await mkdir(outDir, { recursive: true });
    const out = path.join(outDir, `thumbnail-${kind}.jpg`);
    ctx.progress(0.1, "frame");
    try {
      await ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: 1, onProgress: () => undefined }, [...args, "-filter_complex_script", script, "-map", label, "-frames:v", "1", "-q:v", "2", "-update", "1", out]);
    } finally {
      for (const file of cleanup) await rm(file, { force: true });
    }
    const info = await stat(out);
    if (info.size > spec.maxBytes) throw new Error("the thumbnail is larger than the allowed size");
    await addExport(dir, { id: job.id, preset: `thumbnail-${kind}`, file: path.join("exports", job.id, `thumbnail-${kind}.jpg`), bytes: info.size, durationMs: 0, createdAtMs: Date.now(), loudnessLufs: null, edlRev: 0 });
    return { file: path.join("exports", job.id, `thumbnail-${kind}.jpg`), bytes: info.size, width: spec.width, height: spec.height };
  };
}
