import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Range } from "../../shared/edl.js";
import { backgroundFfmpeg, CARD_SIZE, computeTiles, DEFAULT_BACKGROUND, initialsOf, tileFfmpeg, type Background, type LayoutSource, type Tile } from "../../shared/layout.js";
import type { Canvas } from "../../shared/safe-area.js";
import { frameMs } from "../../shared/project.js";
import type { ProjectSource } from "../../shared/project.js";
import type { Scene } from "../../shared/scenes.js";
import { videoTimelineFilter } from "./conform.js";

/** A name card the scenes may show: the source id and the name of the participant who has no camera. */
export interface CardInput {
  id: string;
  name: string;
}

export interface LayoutVideoInput {
  /** Video sources with the ffmpeg input index of their original recording. */
  inputs: { source: ProjectSource; input: number }[];
  /** Name cards of the participants without a camera: generated at the size of their tile, no input. */
  cards?: CardInput[];
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

/** The bundled fonts (captions, thumbnails, name cards); `assets/` sits next to `src/` and `dist/` in a checkout and in the image. */
export const FONTS_DIR = fileURLToPath(new URL("../../../assets/fonts", import.meta.url));

/** A value of a filter option, quoted for a filter graph (the quote, the colon and the backslash escaped). */
export const escapePath = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;

const CARD_BACKGROUND = "0x1c2433";
const CARD_AVATAR = "0x4f7df3";
const CARD_FONT = "NotoSans-Bold.ttf";

/** A name safe to put inside a quoted drawtext value: letters, digits and a few separators, never a quote, colon, comma or backslash. */
const plainText = (name: string): string => name.replace(/[^\p{L}\p{N} ._()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * The filter chain of a name card: a flat panel with a round avatar (the initials) and the name under it, as `w`x`h`
 * pixels for `frames` frames. The avatar is built from one frame and repeated, so the equation runs once.
 * Returns the lines of a graph that ends in `[label]`.
 */
export function cardGraph(label: string, name: string, w: number, h: number, frames: number, fps: number): string[] {
  const short = Math.min(w, h);
  const avatar = Math.max(2, Math.floor((short * 0.34) / 2) * 2);
  const shift = Math.round(short * 0.06);
  const initials = plainText(initialsOf(name)) || "?";
  const shown = plainText(name);
  const font = escapePath(path.join(FONTS_DIR, CARD_FONT));
  const radius = avatar / 2;
  const lines = [
    `color=c=${CARD_BACKGROUND}:s=${w}x${h}:r=${fps}:d=${sec(frames, fps)},format=yuv420p[${label}_bg]`,
    `color=c=${CARD_AVATAR}:s=${avatar}x${avatar}:r=${fps}:d=${sec(1, fps)},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lte(hypot(X-${radius - 0.5},Y-${radius - 0.5}),${radius}),255,0)',loop=loop=-1:size=1:start=0[${label}_av]`,
  ];
  const text = (value: string, size: number, y: string): string => `drawtext=fontfile=${font}:text='${value}':expansion=none:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=${y}`;
  const chain = [
    `[${label}_bg][${label}_av]overlay=x=(W-w)/2:y=(H-h)/2-${shift}:shortest=1`,
    text(initials, Math.round(avatar * 0.42), `(h-text_h)/2-${shift}`),
    ...(shown === "" ? [] : [text(shown, Math.max(12, Math.round(short * 0.06)), `(h+${avatar})/2-${shift}+${Math.round(short * 0.05)}`)]),
    "setsar=1",
  ];
  lines.push(`${chain.join(",")}[${label}]`);
  return lines;
}

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
  const cardNames = new Map((input.cards ?? []).map((card) => [card.id, card.name]));

  // 1. scene boundaries in frames, and which tiles each scene draws
  const bounds: number[] = [0];
  for (const scene of input.scenes) bounds.push(Math.round(scene.e / frame));
  const programFrames = input.kept.reduce((sum, range) => sum + Math.round((range.e - range.s) / frame), 0);
  bounds[bounds.length - 1] = programFrames;
  const composed = input.scenes.map((scene, index) => {
    const sources: LayoutSource[] = scene.sources.flatMap((id): LayoutSource[] => {
      if (cardNames.has(id)) return [{ id, kind: "card", width: CARD_SIZE.width, height: CARD_SIZE.height }];
      const source = byId.get(id)?.source;
      if (!source || source.width === null || source.height === null) return [];
      return [{ id: source.id, kind: source.kind === "screen" ? "screen" : "camera", width: source.width, height: source.height }];
    });
    const placed = computeTiles({ layout: scene.layout, canvas, sources, ...(scene.fit ? { fit: scene.fit } : {}), background: input.background });
    const { tiles } = placed;
    // a blurred background is a blurred picture of the featured source: a card has none, so the plain background stays (as in the preview)
    const background = placed.background.kind === "blur" && cardNames.has(tiles[0]?.sourceId ?? "") ? DEFAULT_BACKGROUND : placed.background;
    return { index, a: bounds[index] as number, b: bounds[index + 1] as number, tiles, background };
  }).filter((scene) => scene.b > scene.a);
  if (composed.length === 0) throw new Error("no scenes to render");

  // 2. every used source: conform, cut, then one branch per use (tiles and blurred backgrounds)
  const uses = new Map<string, number>();
  for (const scene of composed) {
    for (const tile of scene.tiles) if (!cardNames.has(tile.sourceId)) uses.set(tile.sourceId, (uses.get(tile.sourceId) ?? 0) + 1);
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
      if (cardNames.has(tile.sourceId)) lines.push(...cardGraph(`${tag}_t${k}`, cardNames.get(tile.sourceId) as string, tile.w, tile.h, n, fps));
      else lines.push(`[${take(tile.sourceId)}]${chain.join(",")}[${tag}_t${k}]`);
      const out = `${tag}_o${k}`;
      lines.push(`[${current}][${tag}_t${k}]overlay=${f.overlay.x}:${f.overlay.y}:eof_action=pass:repeatlast=0,format=yuv420p[${out}]`);
      current = out;
    });
    labels.push(`[${current}]`);
  }
  lines.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0,setpts=N/(${fps}*TB)[vout]`);
  return { graph: lines.join(";\n"), label: "[vout]" };
}
