// Voice activity from the level track (RMS in dBFS per 20 ms frame). No model: a per-track noise floor plus a margin,
// which is reliable for close microphones, and a cross-track dominance test that drops speaker bleed.

import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "./project.js";

export interface VadOptions {
  /** A frame is speech when it is this far (dB) above the track's noise floor. */
  marginDb: number;
  /** ...and above this absolute level. */
  minLevelDb: number;
  /** Percentile of frame levels taken as the noise floor (0..100). */
  floorPercentile: number;
  /** Gaps shorter than this between speech frames are bridged. */
  bridgeMs: number;
  /** Segments shorter than this are dropped. */
  minMs: number;
  /** Each segment is widened by this much on both sides. */
  padMs: number;
  /** Segments longer than this are split at the quietest frame near the end. */
  maxSegmentMs: number;
  /**
   * When another track is at least this much louder (dB) in a frame, the frame is bleed from that speaker and is not
   * speech on this track. Null turns the test off.
   */
  dominanceDb: number | null;
}

export const DEFAULT_VAD: VadOptions = {
  marginDb: 12,
  minLevelDb: -50,
  floorPercentile: 10,
  bridgeMs: 500,
  minMs: 250,
  padMs: 150,
  maxSegmentMs: 25_000,
  dominanceDb: 10,
};

export interface Segment {
  startMs: number;
  endMs: number;
}

export function noiseFloorDb(levels: ArrayLike<number>, percentile: number): number {
  if (levels.length === 0) return LEVEL_FLOOR_DB;
  const sorted = Float64Array.from(levels as ArrayLike<number>).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((percentile / 100) * sorted.length)));
  return sorted[index] ?? LEVEL_FLOOR_DB;
}

/** Per-frame speech flags of one track; `others` are the level tracks of the other participants. */
export function speechFrames(levels: Int8Array, options: VadOptions = DEFAULT_VAD, others: Int8Array[] = []): Uint8Array {
  const threshold = Math.max(noiseFloorDb(levels, options.floorPercentile) + options.marginDb, options.minLevelDb);
  const flags = new Uint8Array(levels.length);
  const dominance = options.dominanceDb;
  for (let frame = 0; frame < levels.length; frame++) {
    const level = levels[frame] ?? LEVEL_FLOOR_DB;
    if (level <= threshold) continue;
    if (dominance !== null && others.some((other) => (other[frame] ?? LEVEL_FLOOR_DB) >= level + dominance)) continue;
    flags[frame] = 1;
  }
  return flags;
}

/** Speech segments (ms) of one track. */
export function detectSpeech(levels: Int8Array, options: VadOptions = DEFAULT_VAD, others: Int8Array[] = []): Segment[] {
  const flags = speechFrames(levels, options, others);
  const runs: [number, number][] = [];
  let start = -1;
  for (let frame = 0; frame <= flags.length; frame++) {
    const on = frame < flags.length && flags[frame] === 1;
    if (on && start < 0) start = frame;
    if (!on && start >= 0) {
      runs.push([start, frame]);
      start = -1;
    }
  }
  const bridge = options.bridgeMs / LEVEL_FRAME_MS;
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] < bridge) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  const total = levels.length * LEVEL_FRAME_MS;
  const segments: Segment[] = [];
  for (const [from, to] of merged) {
    if ((to - from) * LEVEL_FRAME_MS < options.minMs) continue;
    segments.push({ startMs: Math.max(0, from * LEVEL_FRAME_MS - options.padMs), endMs: Math.min(total, to * LEVEL_FRAME_MS + options.padMs) });
  }
  return splitLong(segments, levels, options.maxSegmentMs);
}

/** Splits segments longer than `maxMs` at the quietest frame between 60% and 100% of the limit. */
export function splitLong(segments: Segment[], levels: Int8Array, maxMs: number): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    let start = segment.startMs;
    while (segment.endMs - start > maxMs) {
      const from = Math.floor((start + maxMs * 0.6) / LEVEL_FRAME_MS);
      const to = Math.floor((start + maxMs) / LEVEL_FRAME_MS);
      let cut = from;
      for (let frame = from; frame < to; frame++) if ((levels[frame] ?? 0) < (levels[cut] ?? 0)) cut = frame;
      out.push({ startMs: start, endMs: cut * LEVEL_FRAME_MS });
      start = cut * LEVEL_FRAME_MS;
    }
    out.push({ startMs: start, endMs: segment.endMs });
  }
  return out;
}

export interface ChunkPart {
  /** The piece of the track, in ms. */
  startMs: number;
  endMs: number;
  /** Where the piece starts inside the packed chunk, in ms. */
  atMs: number;
}

export interface Chunk {
  parts: ChunkPart[];
  /** Length of the packed audio in ms. */
  lengthMs: number;
}

/** Packs speech segments into chunks of at most `limitMs`, separated by `padMs` of silence (speech engines take about 30 s at a time). */
export function packChunks(segments: Segment[], limitMs = 28_000, padMs = 600): Chunk[] {
  const chunks: Chunk[] = [];
  let parts: ChunkPart[] = [];
  let length = 0;
  for (const segment of segments) {
    const duration = segment.endMs - segment.startMs;
    if (parts.length > 0 && length + padMs + duration > limitMs) {
      chunks.push({ parts, lengthMs: length });
      parts = [];
      length = 0;
    }
    const at = parts.length > 0 ? length + padMs : 0;
    parts.push({ startMs: segment.startMs, endMs: segment.endMs, atMs: at });
    length = at + duration;
  }
  if (parts.length > 0) chunks.push({ parts, lengthMs: length });
  return chunks;
}

/** Maps a time inside a packed chunk back to the track. Times in the silence between parts land on the nearest part. */
export function chunkTimeToTrack(chunk: Chunk, chunkMs: number): number {
  let best = chunk.parts[0];
  for (const part of chunk.parts) if (chunkMs >= part.atMs - 300) best = part;
  if (!best) return chunkMs;
  return Math.min(best.endMs, Math.max(best.startMs, best.startMs + (chunkMs - best.atMs)));
}
