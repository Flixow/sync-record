// One frame of a thumbnail: which picture to show at an instant, composed and polished as a filter graph, for the 640x360
// previews and for the full-size picture alike. Everything runs in ffmpeg on the server; no frame is sent anywhere.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Background } from "../../shared/layout.js";
import { frameMs, type ProjectFile, type ProjectSource } from "../../shared/project.js";
import type { ThumbnailKind } from "../../shared/publish.js";
import type { Canvas } from "../../shared/safe-area.js";
import { sceneAt, type ActivityTrack, type Scene } from "../../shared/scenes.js";
import { subjectAt, type Subject } from "../../shared/thumb-moments.js";
import { thumbnailFraming, type ThumbnailSide } from "../../shared/thumb-style.js";
import { activityTracks, cardsOf, layoutSources, resolveScenes } from "./layout-plan.js";
import type { ProjectStore } from "./projects.js";
import { escapePath, layoutVideoGraph } from "./render-layout.js";
import { readScenes, type ScenesFile } from "./scenes-store.js";

const FPS = 30;
/** Decoding starts this long before the wanted frame: the keyframe the seek lands on is further back than that. */
const LEAD_MS = 4000;

/** The size of the previews and of the measurement pass: a thumbnail at one sixth of its size. */
export const PREVIEW_CANVAS: Record<ThumbnailKind, Canvas> = { video: { width: 640, height: 360 }, short: { width: 360, height: 640 } };

/** What a thumbnail job knows about the project: the scene plan, who is active when, and the saved background. */
export interface FrameContext {
  sid: string;
  store: ProjectStore;
  project: ProjectFile;
  dir: string;
  saved: ScenesFile;
  scenes: Scene[];
  tracks: ActivityTrack[];
}

export async function frameContext(store: ProjectStore, sid: string): Promise<FrameContext> {
  const project = await store.require(sid);
  const dir = store.dir(sid);
  const saved = await readScenes(dir);
  return { sid, store, project, dir, saved, scenes: await resolveScenes(project, dir, saved.plan), tracks: await activityTracks(project, dir) };
}

export interface FrameRequest {
  atMs: number;
  kind: ThumbnailKind;
  /** The size of the picture; the graph's output has exactly this size. */
  canvas: Canvas;
  /** The side the headline takes: the face is placed on the other one. */
  side: ThumbnailSide;
}

export interface FramePlan {
  /** ffmpeg input arguments: a seek and a file per used source. */
  inputs: string[];
  /** The filter graph; the picture, before any text, is the output `label`. */
  graph: string;
  label: string;
  /** The subject, null when the scene was drawn as the program shows it (no picture source of its own). */
  subject: Subject | null;
  /** A person's camera: zoomed, punched up and vignetted. */
  camera: boolean;
}

const oddBetween = (n: number, low: number, high: number): number => {
  const odd = n % 2 === 0 ? n + 1 : n;
  return Math.min(high, Math.max(low, odd));
};

/** A mild punch for a webcam picture: a little contrast and saturation, light sharpening (its kernel grows with the picture), a subtle vignette. */
function polishFilters(canvas: Canvas): string[] {
  const size = oddBetween(Math.round(Math.min(canvas.width, canvas.height) / 360) + 3, 5, 13);
  return ["eq=contrast=1.08:saturation=1.25", `unsharp=${size}:${size}:0.7:${size}:${size}:0`, "vignette=angle=PI/3.4"];
}

/**
 * The picture at an instant: the face of whoever speaks (their camera alone, enlarged onto the speaker and placed opposite the
 * headline), or the screen when no camera runs; with nothing of its own to show, the scene as the program draws it. Null when
 * no picture source was recording then. The recordings are seeked, not decoded from the start, so it takes a moment on a long one.
 */
export async function planFrame(ctx: FrameContext, request: FrameRequest): Promise<FramePlan | null> {
  const { project } = ctx;
  const at = request.atMs;
  const scene = sceneAt(ctx.scenes, at) ?? ctx.scenes[0];
  if (!scene) return null;
  const subject = subjectAt({ sources: project.sources, tracks: ctx.tracks, scene, atMs: at });
  const camera = subject?.kind === "camera";
  const frame = frameMs(FPS);
  const shown: Scene = { s: 0, e: frame, layout: subject ? "solo" : scene.layout, sources: subject ? [subject.id] : scene.sources, ...(!subject && scene.fit ? { fit: scene.fit } : {}) };
  const listed = layoutSources(project);
  const used = project.sources.filter((source) => source.hasVideo && shown.sources.includes(source.id) && listed.some((item) => item.id === source.id));

  const t0 = Math.max(0, at - LEAD_MS);
  const rel = Math.round((at - t0) / frame) * frame;
  const inputs: string[] = [];
  const videoInputs: { source: ProjectSource; input: number }[] = [];
  for (const source of used) {
    // seek the original to the instant t0 and describe it as a source whose timeline starts there
    const media = Math.max(0, ((t0 - source.offsetMs) / 1000) * source.rate);
    const file = await ctx.store.localSource(ctx.sid, source.sourceKey, source.id);
    inputs.push("-ss", media.toFixed(3), "-i", file);
    videoInputs.push({ source: { ...source, offsetMs: Math.max(0, source.offsetMs - t0) }, input: videoInputs.length });
  }
  const cards = subject ? [] : cardsOf(project).filter((card) => shown.sources.includes(card.id)).map((card) => ({ id: card.id, name: card.name }));
  if (videoInputs.length === 0 && cards.length === 0) return null;

  const background: Background = ctx.saved.rev === 0 && request.kind === "short" ? { kind: "blur", sigma: 40 } : ctx.saved.background;
  const framing = camera ? thumbnailFraming(request.canvas, request.kind, request.side) : { compose: request.canvas, crop: null };
  const video = layoutVideoGraph({ inputs: videoInputs, cards, canvas: framing.compose, fps: FPS, scenes: [shown], kept: [{ s: rel, e: rel + frame }], totalMs: rel + 2000, background });
  if (!camera) return { inputs, graph: video.graph, label: video.label, subject, camera: false };
  const chain = [...(framing.crop ? [`crop=${framing.crop.w}:${framing.crop.h}:${framing.crop.x}:${framing.crop.y}`] : []), ...polishFilters(request.canvas)];
  return { inputs, graph: `${video.graph};\n${video.label}${chain.join(",")}[pol]`, label: "[pol]", subject, camera: true };
}

/** Writes a filter graph to a file under the project's `tmp`, runs `use` with its path and removes it afterwards. */
export async function withGraphFile<T>(dir: string, name: string, graph: string, use: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(dir, "tmp", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, graph);
  try {
    return await use(file);
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * The branches that measure a picture, for `signalstats` dumps written to `files`: the picture's own numbers and those of its
 * edge map. Outputs `[pv_a]` (the picture, unchanged) and the two measuring branches `[pv_pic]` and `[pv_edge]`, which go to a null muxer.
 */
export function statsBranches(label: string, files: { picture: string; edges: string }): string {
  return [
    `${label}split=3[pv_a][pv_b][pv_c]`,
    `[pv_b]signalstats,metadata=mode=print:file=${escapePath(files.picture)}[pv_pic]`,
    `[pv_c]edgedetect=low=0.1:high=0.4,format=yuv420p,signalstats,metadata=mode=print:file=${escapePath(files.edges)}[pv_edge]`,
  ].join(";\n");
}
