import type { Range } from "../../shared/edl.js";
import { backgroundFfmpeg, computeTiles, tileFfmpeg, type Background, type LayoutSource, type Tile } from "../../shared/layout.js";
import type { Canvas } from "../../shared/safe-area.js";
import { frameMs } from "../../shared/project.js";
import type { ProjectSource } from "../../shared/project.js";
import type { Scene } from "../../shared/scenes.js";
import { videoTimelineFilter } from "./conform.js";

export interface LayoutVideoInput {
  /** Video sources with the ffmpeg input index of their original recording. */
  inputs: { source: ProjectSource; input: number }[];
  canvas: Canvas;
  fps: number;
  /** Scenes on the OUTPUT timeline (after the cuts), ms, tiling [0, programMs]. */
  scenes: Scene[];
  /** Kept ranges of the project timeline, already on the frame grid. */
  kept: Range[];
  totalMs: number;
  background: Background;
}

const sec = (frames: number, fps: number): string => (frames / fps).toFixed(6);

/**
 * The picture of the program: every source conformed to the timeline and cut to the kept ranges once, then split into
 * the scenes, each composed with the shared layout engine (the same tiles the browser preview draws), and joined.
 * Scene edges lie on frames, so the video is exactly `sum of kept frames` long.
 */
export function layoutVideoGraph(input: LayoutVideoInput): { graph: string; label: string } {
  const { fps, canvas } = input;
  const frame = frameMs(fps);
  const lines: string[] = [];
  const byId = new Map(input.inputs.map((item) => [item.source.id, item]));

  // 1. scene boundaries in frames, and which tiles each scene draws
  const bounds: number[] = [0];
  for (const scene of input.scenes) bounds.push(Math.round(scene.e / frame));
  const programFrames = input.kept.reduce((sum, range) => sum + Math.round((range.e - range.s) / frame), 0);
  bounds[bounds.length - 1] = programFrames;
  const composed = input.scenes.map((scene, index) => {
    const sources: LayoutSource[] = scene.sources
      .map((id) => byId.get(id)?.source)
      .filter((source): source is ProjectSource => source !== undefined && source.width !== null && source.height !== null)
      .map((source) => ({ id: source.id, kind: source.kind === "screen" ? "screen" : "camera", width: source.width as number, height: source.height as number }));
    const { tiles, background } = computeTiles({ layout: scene.layout, canvas, sources, ...(scene.fit ? { fit: scene.fit } : {}), background: input.background });
    return { index, a: bounds[index] as number, b: bounds[index + 1] as number, tiles, background };
  }).filter((scene) => scene.b > scene.a);
  if (composed.length === 0) throw new Error("no scenes to render");

  // 2. every used source: conform, cut, then one branch per use (tiles and blurred backgrounds)
  const uses = new Map<string, number>();
  for (const scene of composed) {
    for (const tile of scene.tiles) uses.set(tile.sourceId, (uses.get(tile.sourceId) ?? 0) + 1);
    if (scene.background.kind === "blur" && scene.tiles[0]) uses.set(scene.tiles[0].sourceId, (uses.get(scene.tiles[0].sourceId) ?? 0) + 1);
  }
  const branch = new Map<string, string[]>();
  for (const [id, count] of uses) {
    const item = byId.get(id);
    if (!item) continue;
    const tag = id.replace(/[^A-Za-z0-9]/g, "_");
    lines.push(`[${item.input}:v]${videoTimelineFilter(item.source, fps, [])},tpad=stop_mode=add:stop_duration=${(input.totalMs / 1000).toFixed(6)}:color=black[full_${tag}]`);
    const pieces: string[] = [];
    if (input.kept.length === 1) {
      const range = input.kept[0] as Range;
      lines.push(`[full_${tag}]trim=start_frame=${Math.round(range.s / frame)}:end_frame=${Math.round(range.e / frame)},setpts=PTS-STARTPTS[cut_${tag}]`);
    } else {
      lines.push(`[full_${tag}]split=${input.kept.length}${input.kept.map((_, i) => `[p_${tag}_${i}]`).join("")}`);
      input.kept.forEach((range, i) => {
        lines.push(`[p_${tag}_${i}]trim=start_frame=${Math.round(range.s / frame)}:end_frame=${Math.round(range.e / frame)},setpts=PTS-STARTPTS[q_${tag}_${i}]`);
        pieces.push(`[q_${tag}_${i}]`);
      });
      lines.push(`${pieces.join("")}concat=n=${input.kept.length}:v=1:a=0,setpts=N/(${fps}*TB)[cut_${tag}]`);
    }
    if (count === 1) {
      branch.set(id, [`cut_${tag}`]);
    } else {
      const names = Array.from({ length: count }, (_, i) => `u_${tag}_${i}`);
      lines.push(`[cut_${tag}]split=${count}${names.map((name) => `[${name}]`).join("")}`);
      branch.set(id, names);
    }
  }
  const take = (id: string): string => {
    const list = branch.get(id);
    const name = list?.shift();
    if (!name) throw new Error(`source ${id} has no free branch`);
    return name;
  };

  // 3. scenes
  const labels: string[] = [];
  for (const scene of composed) {
    const n = scene.b - scene.a;
    const tag = `s${scene.index}`;
    let base: string;
    if (scene.background.kind === "blur") {
      const feature = scene.tiles[0] as Tile;
      const bg = backgroundFfmpeg(scene.background, canvas, "x", fps);
      lines.push(`[${take(feature.sourceId)}]trim=start_frame=${scene.a}:end_frame=${scene.b},setpts=PTS-STARTPTS,${bg.chain},format=yuv420p[${tag}_bg]`);
      base = `${tag}_bg`;
    } else {
      const bg = backgroundFfmpeg(scene.background, canvas, "x", fps);
      lines.push(`${bg.chain}:d=${sec(n, fps)},setsar=1,format=yuv420p[${tag}_bg]`);
      base = `${tag}_bg`;
    }
    let current = base;
    [...scene.tiles].sort((x, y) => x.z - y.z).forEach((tile, k) => {
      const f = tileFfmpeg(tile);
      const chain = [`trim=start_frame=${scene.a}:end_frame=${scene.b}`, "setpts=PTS-STARTPTS", f.crop, f.scale, f.pad, "setsar=1"].filter((part) => part !== "");
      lines.push(`[${take(tile.sourceId)}]${chain.join(",")}[${tag}_t${k}]`);
      const out = `${tag}_o${k}`;
      lines.push(`[${current}][${tag}_t${k}]overlay=${f.overlay.x}:${f.overlay.y}:eof_action=pass:repeatlast=0,format=yuv420p[${out}]`);
      current = out;
    });
    labels.push(`[${current}]`);
  }
  lines.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0,setpts=N/(${fps}*TB)[vout]`);
  return { graph: lines.join(";\n"), label: "[vout]" };
}
