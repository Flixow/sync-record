// The layout engine: where every source picture goes on the output canvas. One geometry, two consumers: the browser
// preview positions <video> elements with `tileCss`, the renderer chains the filters of `tileFfmpeg`. Both are derived
// from the same `Tile`, so they cannot diverge.
//
// How a tile maps to both consumers (the source picture is `src`, the tile box is x,y,w,h on the canvas):
//   fill (cover and crop)   Tile.crop is the region of the source that is shown: it has the aspect ratio of the tile
//                           (to within the even-pixel rounding) and is centred on the focus point.
//                           ffmpeg:  crop=cw:ch:cx:cy,scale=w:h            overlay at x,y
//                           CSS:     object-fit: cover; object-position: cx/(sw-cw) cy/(sh-ch) in percent
//                           (cover scales the source until it covers the box and the position slides the visible
//                           window over the slack, which is the same window as the crop).
//   fit  (contain)         the whole source is shown, scaled to the largest even size that fits in the tile box and
//                           centred in it (on an even pixel); the rest of the box shows the background.
//                           The contained size is computed here, so no filter has to guess the rounding, and the
//                           preview element is placed exactly where the render puts the picture.
//                           ffmpeg:  scale=cw:ch                           overlay at the centred offset
//                           CSS:     the box of that picture, object-fit: contain
// Every coordinate on the canvas is an even integer (yuv420p), so is every crop. In the preview and in the render a
// tile box and a contained picture are the same rectangle; a fill crop differs by at most 3 source pixels (the CSS
// window has the tile's exact aspect ratio, the crop is rounded to even sizes, an odd source size loses a pixel).

import { safeArea, type Canvas, type Rect } from "./safe-area.js";

export type LayoutId = "solo" | "side-by-side" | "grid" | "speaker-thumbs" | "screen-camera";
export const LAYOUT_IDS: readonly LayoutId[] = ["solo", "side-by-side", "grid", "speaker-thumbs", "screen-camera"];

/** fill = cover and crop, fit = contain with the background showing around. */
export type Fit = "fill" | "fit";

export type Background =
  /** A flat colour, `#rrggbb`. */
  | { kind: "color"; color: string }
  /** A blurred copy of a source picture, scaled to cover the canvas. `sigma` is in pixels of a canvas whose short edge is 1080; smaller canvases scale it down. */
  | { kind: "blur"; sigma: number };

export type Aspect = "16:9" | "9:16" | "1:1";

/** The canvases of the three output aspects, at full size. */
export const CANVASES: Record<Aspect, Canvas> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/** Reference size of `Background.sigma`: the short edge of every full-size canvas. */
const SIGMA_REFERENCE_EDGE = 1080;

export const DEFAULT_BACKGROUND: Background = { kind: "color", color: "#0d0f12" };

/** How many sources each layout shows (more are ignored). */
export const LAYOUT_CAPACITY: Record<LayoutId, number> = { solo: 1, "side-by-side": 2, grid: 4, "speaker-thumbs": 4, "screen-camera": 2 };

const evenDown = (n: number): number => Math.floor(n / 2) * 2;
const evenNear = (n: number): number => Math.round(n / 2) * 2;
const evenUp = (n: number): number => Math.ceil(n / 2) * 2;

/**
 * The canvas of an aspect with its long edge scaled to `longEdge` (default: the full size), both sides even. The
 * preview uses a smaller canvas, for example `canvasFor("16:9", 640)` is 640x360.
 */
export function canvasFor(aspect: Aspect, longEdge?: number): Canvas {
  const full = CANVASES[aspect];
  if (longEdge === undefined) return { ...full };
  if (!Number.isFinite(longEdge) || longEdge < 2) throw new RangeError(`canvasFor: bad long edge ${longEdge}`);
  const scale = longEdge / Math.max(full.width, full.height);
  return { width: Math.max(2, evenNear(full.width * scale)), height: Math.max(2, evenNear(full.height * scale)) };
}

/**
 * The size of a source picture and what it shows. A "card" stands for a participant who recorded a microphone and no
 * camera: it has no recording to crop, the preview draws a name card and the renderer generates one at the size of the
 * tile (so its text stays sharp on any canvas). A card is a speaker like a camera and takes part in every layout.
 */
export interface LayoutSource {
  id: string;
  kind: "camera" | "screen" | "card";
  width: number;
  height: number;
}

/** Prefix of the source id of the name card of a participant who has a microphone and no camera: `card-<participant id>` (a valid scene override id, see ID_PATTERN). */
export const CARD_PREFIX = "card-";
/** The nominal picture size of a card (16:9); the tile it fills decides the real one. */
export const CARD_SIZE = { width: 1280, height: 720 } as const;

export const cardSourceId = (participantId: string): string => `${CARD_PREFIX}${participantId}`;

/** The participant a card id stands for, or null when `id` is not a card id. */
export const cardParticipantId = (id: string): string | null => (id.startsWith(CARD_PREFIX) && id.length > CARD_PREFIX.length ? id.slice(CARD_PREFIX.length) : null);

/** Up to two capital letters for the avatar of a name card: the first letters of the first and last word ("Michał Rowiński" gives "MR"). */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const letters = [words[0], words.length > 1 ? words[words.length - 1] : undefined].flatMap((word) => (word ? [Array.from(word)[0] as string] : []));
  return letters.length === 0 ? "?" : letters.join("").toLocaleUpperCase();
}

export interface Tile {
  sourceId: string;
  /** The tile box on the canvas, in canvas pixels; all even integers. */
  x: number;
  y: number;
  w: number;
  h: number;
  fit: Fit;
  /** Region of the source shown, in source pixels, all even. For "fill" it is the cover crop around the focus point; for "fit" it is the whole source. */
  crop: Rect;
  /** Size of the source picture (`LayoutSource.width/height`): the preview needs it to turn the crop into `object-position`. */
  sourceSize: { w: number; h: number };
  /** Draw order, lowest first. Only a picture-in-picture differs from 0. */
  z: number;
}

export interface LayoutInput {
  layout: LayoutId;
  canvas: Canvas;
  /** Ordered: the first is the featured source (the active speaker, or the screen). */
  sources: LayoutSource[];
  /** Default: "fill" for camera tiles, "fit" for screen tiles. */
  fit?: Fit;
  /** Space between tiles in canvas pixels (default about 1.2% of the short edge). */
  gap?: number;
  background?: Background;
  /** Per source id, the point (0..1 of the source picture) the crop centres on. Default: the centre, a face in a camera picture sits in its upper third. */
  focus?: Record<string, { x: number; y: number }>;
}

/** Where a face usually is in a webcam picture, when the caller does not know: centred, in the upper third. */
export const DEFAULT_CAMERA_FOCUS = { x: 0.5, y: 1 / 3 };
const CENTER = { x: 0.5, y: 0.5 };

/**
 * The layout that is actually drawn when `count` sources are available: a layout that needs more pictures than there
 * are degrades to a smaller one (grid -> side by side -> solo).
 */
export function effectiveLayout(layout: LayoutId, count: number): LayoutId {
  if (count <= 1) return "solo";
  if (layout === "grid" && count === 2) return "side-by-side";
  return layout;
}

export const defaultGap = (canvas: Canvas): number => evenNear(Math.min(canvas.width, canvas.height) * 0.012);

function validate(input: LayoutInput): void {
  if (!(input.canvas.width >= 2 && input.canvas.height >= 2)) throw new RangeError("computeTiles: the canvas is empty");
  for (const source of input.sources) {
    if (!(source.width >= 2 && source.height >= 2) || !Number.isFinite(source.width) || !Number.isFinite(source.height)) {
      throw new RangeError(`computeTiles: source ${source.id} has no picture size`);
    }
  }
}

/** The area the pictures use: the whole canvas, on vertical video the part clear of the platform's interface (inset to even pixels). */
function frameOf(canvas: Canvas): Rect {
  const width = evenDown(canvas.width);
  const height = evenDown(canvas.height);
  if (canvas.height <= canvas.width) return { x: 0, y: 0, w: width, h: height };
  const safe = safeArea({ width, height });
  const x = evenUp(safe.x);
  const y = evenUp(safe.y);
  return { x, y, w: evenDown(safe.x + safe.w) - x, h: evenDown(safe.y + safe.h) - y };
}

interface Box {
  source: LayoutSource;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const box = (source: LayoutSource, x: number, y: number, w: number, h: number, z = 0): Box => ({ source, x, y, w: Math.max(2, w), h: Math.max(2, h), z });

/** Offset that centres `len` in [start, start + outer) on an even pixel. */
const centred = (start: number, outer: number, len: number): number => start + evenDown(Math.max(0, outer - len) / 2);

/** Which layout is drawn and with which sources, given what is available. */
function pick(layout: LayoutId, sources: LayoutSource[]): { layout: LayoutId; picked: LayoutSource[] } {
  if (layout === "screen-camera") {
    const screen = sources.find((source) => source.kind === "screen");
    const camera = sources.find((source) => source.kind !== "screen");
    if (screen && camera) return { layout, picked: [screen, camera] };
    if (screen) return { layout: "solo", picked: [screen] };
    // no screen to feature: show the cameras next to each other
    const count = Math.min(sources.length, LAYOUT_CAPACITY.grid);
    return { layout: effectiveLayout("grid", count), picked: sources.slice(0, count) };
  }
  const count = Math.min(sources.length, LAYOUT_CAPACITY[layout]);
  return { layout: effectiveLayout(layout, count), picked: sources.slice(0, count) };
}

function boxes(layout: LayoutId, picked: LayoutSource[], canvas: Canvas, gap: number): Box[] {
  const frame = frameOf(canvas);
  const portrait = canvas.height > canvas.width;
  const [first, second, third, fourth] = picked;
  if (!first) return [];
  switch (layout) {
    case "solo":
      return [box(first, frame.x, frame.y, frame.w, frame.h)];
    case "side-by-side": {
      if (!second) return [box(first, frame.x, frame.y, frame.w, frame.h)];
      if (portrait) {
        const h = evenDown((frame.h - gap) / 2);
        const y = centred(frame.y, frame.h, 2 * h + gap);
        return [box(first, frame.x, y, frame.w, h), box(second, frame.x, y + h + gap, frame.w, h)];
      }
      const w = evenDown((frame.w - gap) / 2);
      const x = centred(frame.x, frame.w, 2 * w + gap);
      return [box(first, x, frame.y, w, frame.h), box(second, x + w + gap, frame.y, w, frame.h)];
    }
    case "grid": {
      const w = evenDown((frame.w - gap) / 2);
      const h = evenDown((frame.h - gap) / 2);
      const x = centred(frame.x, frame.w, 2 * w + gap);
      const y = centred(frame.y, frame.h, 2 * h + gap);
      const out = [box(first, x, y, w, h)];
      if (second) out.push(box(second, x + w + gap, y, w, h));
      // three pictures: two over one, the last centred under the pair
      if (third) out.push(box(third, fourth ? x : x + evenDown((w + gap) / 2), y + h + gap, w, h));
      if (fourth) out.push(box(fourth, x + w + gap, y + h + gap, w, h));
      return out;
    }
    case "speaker-thumbs": {
      const others = picked.slice(1);
      if (others.length === 0) return [box(first, frame.x, frame.y, frame.w, frame.h)];
      let thumbH = evenNear(frame.h * (portrait ? 0.14 : 0.22));
      let thumbW = evenNear((thumbH * 16) / 9);
      const widest = evenDown((frame.w - (others.length - 1) * gap) / others.length);
      if (thumbW > widest) {
        thumbW = widest;
        thumbH = evenNear((thumbW * 9) / 16);
      }
      const stripW = others.length * thumbW + (others.length - 1) * gap;
      const stripX = centred(frame.x, frame.w, stripW);
      const stripY = frame.y + frame.h - thumbH;
      return [
        box(first, frame.x, frame.y, frame.w, stripY - gap - frame.y),
        ...others.map((source, index) => box(source, stripX + index * (thumbW + gap), stripY, thumbW, thumbH)),
      ];
    }
    case "screen-camera": {
      if (!second) return [box(first, frame.x, frame.y, frame.w, frame.h)];
      if (portrait) {
        // the screen on top at its natural height (within limits), the camera fills the rest
        const natural = (frame.w * first.height) / first.width;
        const screenH = evenNear(Math.min(frame.h * 0.55, Math.max(frame.h * 0.3, natural)));
        return [box(first, frame.x, frame.y, frame.w, screenH), box(second, frame.x, frame.y + screenH + gap, frame.w, frame.h - screenH - gap)];
      }
      const pipW = evenNear(frame.w * (frame.w === frame.h ? 0.3 : 0.25));
      const pipH = evenNear((pipW * 9) / 16);
      const margin = evenNear(Math.min(frame.w, frame.h) * 0.03);
      return [box(first, frame.x, frame.y, frame.w, frame.h), box(second, frame.x + frame.w - margin - pipW, frame.y + frame.h - margin - pipH, pipW, pipH, 1)];
    }
  }
}

/** The part of a (sw x sh) source that covers a (w x h) box, centred on the focus point and kept inside the picture. Even numbers. */
function fillCrop(sw: number, sh: number, w: number, h: number, focus: { x: number; y: number }): Rect {
  const aspect = w / h;
  let cw = sw;
  let ch = sh;
  if (sw / sh > aspect) cw = Math.min(sw, Math.max(2, evenNear(sh * aspect)));
  else ch = Math.min(sh, Math.max(2, evenNear(sw / aspect)));
  const place = (centre: number, size: number, total: number): number => evenDown(Math.min(total - size, Math.max(0, centre - size / 2)));
  return { x: place(focus.x * sw, cw, sw), y: place(focus.y * sh, ch, sh), w: cw, h: ch };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));

/** The largest even size that fits a (sw x sh) picture in a (w x h) box without distortion. */
export function containSize(sw: number, sh: number, w: number, h: number): { w: number; h: number } {
  const scale = Math.min(w / sw, h / sh);
  return { w: Math.max(2, Math.min(w, evenNear(sw * scale))), h: Math.max(2, Math.min(h, evenNear(sh * scale))) };
}

/** Tiles in draw order (lowest z first, the featured source first among equals) and the background to put under them. */
export function computeTiles(input: LayoutInput): { tiles: Tile[]; background: Background } {
  validate(input);
  const background = input.background ?? DEFAULT_BACKGROUND;
  const gap = input.gap === undefined ? defaultGap(input.canvas) : Math.max(0, evenNear(input.gap));
  const { layout, picked } = pick(input.layout, input.sources);
  const tiles = boxes(layout, picked, input.canvas, gap).map((placed): Tile => {
    const source = placed.source;
    // a card has no recording behind it: it is drawn at exactly the size of its box, so nothing is cropped or letterboxed
    if (source.kind === "card") {
      return { sourceId: source.id, x: placed.x, y: placed.y, w: placed.w, h: placed.h, fit: "fill", crop: { x: 0, y: 0, w: placed.w, h: placed.h }, sourceSize: { w: placed.w, h: placed.h }, z: placed.z };
    }
    const fit: Fit = input.fit ?? (source.kind === "screen" ? "fit" : "fill");
    const sw = evenDown(source.width);
    const sh = evenDown(source.height);
    const given = input.focus?.[source.id];
    const focus = given ? { x: clamp01(given.x), y: clamp01(given.y) } : source.kind === "camera" ? DEFAULT_CAMERA_FOCUS : CENTER;
    const crop = fit === "fill" ? fillCrop(sw, sh, placed.w, placed.h, focus) : { x: 0, y: 0, w: sw, h: sh };
    return { sourceId: source.id, x: placed.x, y: placed.y, w: placed.w, h: placed.h, fit, crop, sourceSize: { w: source.width, h: source.height }, z: placed.z };
  });
  return { tiles: tiles.map((tile, index) => ({ tile, index })).sort((a, b) => a.tile.z - b.tile.z || a.index - b.index).map((entry) => entry.tile), background };
}

// ---- preview (CSS) ------------------------------------------------------------------------------------------------------

export interface TileCss {
  left: string;
  top: string;
  width: string;
  height: string;
  objectFit: "cover" | "contain";
  objectPosition: string;
}

/** `value` as a percent with 5 decimals (0.001 px on a 1920 px canvas), without trailing zeros. */
const percent = (value: number): string => `${Number(value.toFixed(5))}%`;

/**
 * Style of the preview's <video> element for a tile, in percent of a container that has the canvas's aspect ratio. A
 * "fill" tile is the tile box with `object-fit: cover`; a "fit" tile is the rectangle of the contained picture.
 */
export function tileCss(tile: Tile, canvas: Canvas): TileCss {
  const rectCss = (area: Rect): Pick<TileCss, "left" | "top" | "width" | "height"> => ({
    left: percent((area.x / canvas.width) * 100),
    top: percent((area.y / canvas.height) * 100),
    width: percent((area.w / canvas.width) * 100),
    height: percent((area.h / canvas.height) * 100),
  });
  if (tile.fit === "fit") return { ...rectCss(containedRect(tile)), objectFit: "contain", objectPosition: "50% 50%" };
  const slackX = tile.sourceSize.w - tile.crop.w;
  const slackY = tile.sourceSize.h - tile.crop.h;
  const positionX = slackX > 0 ? (tile.crop.x / slackX) * 100 : 50;
  const positionY = slackY > 0 ? (tile.crop.y / slackY) * 100 : 50;
  return { ...rectCss(tile), objectFit: "cover", objectPosition: `${percent(positionX)} ${percent(positionY)}` };
}

/** Where a "fit" tile's picture lies on the canvas: the largest even size that fits the box, centred on an even pixel. */
function containedRect(tile: Tile): Rect {
  const size = containSize(tile.crop.w, tile.crop.h, tile.w, tile.h);
  return { x: tile.x + evenDown((tile.w - size.w) / 2), y: tile.y + evenDown((tile.h - size.h) / 2), w: size.w, h: size.h };
}

// ---- render (ffmpeg) ----------------------------------------------------------------------------------------------------

export interface TileFfmpeg {
  /** `crop=w:h:x:y` on the source picture, or "" when the whole picture is used. */
  crop: string;
  /** `scale=w:h` to the exact size the picture has on the canvas. */
  scale: string;
  /** "" unless a pad colour was asked for: then `pad=w:h:x:y:color=0xrrggbb`, which makes the picture an opaque box of the tile's size. */
  pad: string;
  /** Where the filtered picture goes on the canvas: the tile's corner, or the centred offset of a contained picture without pad. Even. */
  overlay: { x: number; y: number };
}

const hex = (color: string): string => `0x${color.replace(/^#/, "").toLowerCase()}`;

/**
 * Filters of a tile, to chain as `[src]<crop>,<scale>[,<pad>][tile]` (skipping empty strings) and overlay on the
 * background at `overlay`. With `padColor` a contained picture is padded to the tile box (an opaque letterbox) and
 * overlaid at the tile's corner; without it the letterbox stays transparent to the background.
 */
export function tileFfmpeg(tile: Tile, padColor?: string): TileFfmpeg {
  const { crop, sourceSize } = tile;
  const wholePicture = crop.x === 0 && crop.y === 0 && crop.w === sourceSize.w && crop.h === sourceSize.h;
  const cropFilter = wholePicture ? "" : `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  if (tile.fit === "fill") return { crop: cropFilter, scale: `scale=${tile.w}:${tile.h}:flags=lanczos`, pad: "", overlay: { x: tile.x, y: tile.y } };
  const picture = containedRect(tile);
  const scale = `scale=${picture.w}:${picture.h}:flags=lanczos`;
  if (padColor === undefined) return { crop: cropFilter, scale, pad: "", overlay: { x: picture.x, y: picture.y } };
  return { crop: cropFilter, scale, pad: `pad=${tile.w}:${tile.h}:${picture.x - tile.x}:${picture.y - tile.y}:color=${hex(padColor)}`, overlay: { x: tile.x, y: tile.y } };
}

/** The blur sigma in pixels of this canvas. */
export const blurSigma = (sigma: number, canvas: Canvas): number => (Math.max(0, sigma) * Math.min(canvas.width, canvas.height)) / SIGMA_REFERENCE_EDGE;

export interface BackgroundFfmpeg {
  /** The filter-graph label (without brackets) the chain reads, or null when the chain makes its own picture. */
  input: string | null;
  /** Filter chain: `color=...` (a source, no input) or `scale,crop,gblur...` on `input`. Write it as `[input]chain[bg]` (or `chain[bg]`). */
  chain: string;
}

/**
 * The picture under the tiles. A colour is a `color` source of the canvas size (`fps` adds the frame rate); a blur is
 * the picture `sourceLabel` scaled to cover the canvas, cropped to it and blurred. A strong blur runs on a quarter-size
 * copy (it is as good as invisible after the blur and 16 times cheaper), then scales back up.
 */
export function backgroundFfmpeg(background: Background, canvas: Canvas, sourceLabel: string, fps?: number): BackgroundFfmpeg {
  const width = evenDown(canvas.width);
  const height = evenDown(canvas.height);
  if (background.kind === "color") return { input: null, chain: `color=c=${hex(background.color)}:s=${width}x${height}${fps === undefined ? "" : `:r=${fps}`}` };
  const sigma = blurSigma(background.sigma, canvas);
  if (sigma < 12) {
    return { input: sourceLabel, chain: `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma.toFixed(2)}` };
  }
  const smallW = evenUp(width / 4);
  const smallH = evenUp(height / 4);
  return {
    input: sourceLabel,
    chain: `scale=${smallW}:${smallH}:force_original_aspect_ratio=increase,crop=${smallW}:${smallH},gblur=sigma=${(sigma / 4).toFixed(2)}:steps=2,scale=${width}:${height}:flags=bicubic`,
  };
}

export interface BackgroundCss {
  backgroundColor: string;
  /** Blur in px of a container that is exactly `canvas.width` x `canvas.height` px (scale the container, not this number). 0 for a colour. */
  blurPx: number;
}

/** The preview of the background: the colour, or a dark base plus a copy of the source picture (object-fit: cover, filter: blur(blurPx)). */
export function backgroundCss(background: Background, canvas: Canvas): BackgroundCss {
  if (background.kind === "color") return { backgroundColor: background.color.toLowerCase(), blurPx: 0 };
  return { backgroundColor: DEFAULT_BACKGROUND.kind === "color" ? DEFAULT_BACKGROUND.color : "#000000", blurPx: Number(blurSigma(background.sigma, canvas).toFixed(2)) };
}
