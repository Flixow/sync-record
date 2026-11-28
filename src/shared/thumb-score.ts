// Scoring of thumbnail candidate frames from what ffmpeg can measure (no model, no face detection): brightness, contrast,
// colour and sharpness. A dark, flat or blurry frame is dropped, the rest are ranked best first. What ffmpeg cannot see (open
// eyes, an expression, where the speaker looks) is left to the person who picks the frame.

import type { ThumbnailKind } from "./publish.js";

/** Per-frame numbers of ffmpeg's `signalstats` filter (8-bit scale) plus the share of edge pixels of the same frame (0..1). */
export interface FrameMeasure {
  /** Mean luma. */
  yAvg: number;
  /** Luma at the 10th and the 90th percentile: their distance is the contrast of the frame. */
  yLow: number;
  yHigh: number;
  /** Mean colour saturation. */
  satAvg: number;
  /** Share of pixels on an edge, from `edgedetect`: a sharp picture has more of them than a blurred one. */
  edge: number;
}

export type RejectReason = "dark" | "bright" | "flat" | "blurry";

export interface FrameScore {
  /** 0..1, higher is better; also set for a rejected frame. */
  score: number;
  reject: RejectReason | null;
}

/** One candidate frame offered by a `thumbnail-previews` job. */
export interface ThumbnailPreview {
  /** Project time of the frame, ms. */
  atMs: number;
  /** Path of the 640x360 JPEG (360x640 for a Short), relative to the project directory. */
  file: string;
  /** 0..1, higher is better. */
  score: number;
  /** Why the frame is a weak pick (dark, flat, blurry), or null. */
  weak: RejectReason | null;
}

/** The result of a `thumbnail-previews` job: the best frames of the recording, or (with `around`) the frames near one moment, in time order. */
export interface ThumbnailPreviewsResult {
  kind: ThumbnailKind;
  around?: number;
  previews: ThumbnailPreview[];
}

export const MIN_LUMA = 40;
export const MAX_LUMA = 220;
/** Frames whose 10th-90th percentile luma range is narrower than this look flat. */
export const MIN_CONTRAST = 35;
/** A frame with less than this share of the median edge share of its candidates is blurred (motion or focus). */
export const BLURRY_SHARE = 0.4;
/** A text block on an area brighter than this (mean luma) gets a dark translucent backing. */
export const BACKING_LUMA = 110;

const IDEAL_LUMA = 120;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Whether a headline on an area of this mean luma needs a dark backing to stay readable. */
export const textBackingNeeded = (areaLuma: number): boolean => areaLuma > BACKING_LUMA;

/**
 * The last frame's values of a `metadata=print` dump: lines such as `lavfi.signalstats.YAVG=104.5`, by key without the
 * `lavfi.signalstats.` prefix. Keys that are not numbers are ignored.
 */
export function parseSignalStats(dump: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of dump.split("\n")) {
    const match = /^lavfi\.signalstats\.([A-Z]+)=(-?[\d.]+(?:e[-+]?\d+)?)$/iu.exec(line.trim());
    if (match) out[match[1] as string] = Number(match[2]);
  }
  return out;
}

/** The measure of a frame from the two dumps ffmpeg wrote: the picture's `signalstats` and the edge map's. Null when a number is missing. */
export function measureFrom(picture: Record<string, number>, edges: Record<string, number>): FrameMeasure | null {
  const { YAVG: yAvg, YLOW: yLow, YHIGH: yHigh, SATAVG: satAvg } = picture;
  const edgeLuma = edges.YAVG;
  if (yAvg === undefined || yLow === undefined || yHigh === undefined || satAvg === undefined || edgeLuma === undefined) return null;
  return { yAvg, yLow, yHigh, satAvg, edge: clamp01(edgeLuma / 255) };
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Scores a set of candidate frames of one recording. Brightness close to mid grey, a wide luma range, colour and sharp edges
 * score high (weights 0.25, 0.30, 0.15, 0.30). Sharpness is judged against the other candidates (their median edge share),
 * because how many edges a picture has depends on the camera and the room. Rejected: too dark, too bright, flat, or much
 * blurrier than the median.
 */
export function scoreFrames(frames: FrameMeasure[]): FrameScore[] {
  const medianEdge = median(frames.map((frame) => frame.edge));
  return frames.map((frame) => {
    const brightness = 1 - Math.min(1, Math.abs(frame.yAvg - IDEAL_LUMA) / IDEAL_LUMA);
    const range = frame.yHigh - frame.yLow;
    const contrast = clamp01((range - MIN_CONTRAST) / 100);
    const colour = clamp01(frame.satAvg / 45);
    const sharpness = medianEdge > 0 ? clamp01(frame.edge / (1.25 * medianEdge)) : 0.5;
    const score = 0.25 * brightness + 0.3 * contrast + 0.15 * colour + 0.3 * sharpness;
    let reject: RejectReason | null = null;
    if (frame.yAvg < MIN_LUMA) reject = "dark";
    else if (frame.yAvg > MAX_LUMA) reject = "bright";
    else if (range < MIN_CONTRAST) reject = "flat";
    else if (medianEdge > 0 && frame.edge < BLURRY_SHARE * medianEdge) reject = "blurry";
    return { score, reject };
  });
}
