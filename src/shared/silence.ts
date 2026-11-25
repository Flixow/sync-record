// Silence between speakers, found on the level tracks of every microphone. A silence is a stretch in which nobody
// speaks; the cut leaves a short natural gap and never touches the speech around it.

import { speechFrames, DEFAULT_VAD, type VadOptions } from "./vad.js";
import { LEVEL_FRAME_MS } from "./project.js";
import type { Range } from "./edl.js";

export interface SilenceOptions {
  /** Only silences at least this long are reported. */
  minSilenceMs: number;
  /** How much of a removed silence stays, split evenly before and after the cut. */
  keepMs: number;
  /** Never cut closer than this to speech on either side. */
  edgeMs: number;
  vad: VadOptions;
}

export const DEFAULT_SILENCE: SilenceOptions = {
  minSilenceMs: 700,
  keepMs: 300,
  edgeMs: 120,
  vad: { ...DEFAULT_VAD, bridgeMs: 0, minMs: 0, padMs: 0 },
};

export interface Silence {
  /** The whole silent stretch. */
  startMs: number;
  endMs: number;
  /** What would be removed from it. */
  cut: Range;
}

/** Speech flags of the union of all tracks, one per level frame. Each track has its own noise floor and the cross-track bleed test. */
export function speechUnion(levels: Int8Array[], vad: VadOptions): Uint8Array {
  const length = levels.reduce((max, track) => Math.max(max, track.length), 0);
  const union = new Uint8Array(length);
  levels.forEach((track, index) => {
    const others = levels.filter((_, other) => other !== index);
    const flags = speechFrames(track, vad, others);
    for (let frame = 0; frame < flags.length; frame++) if (flags[frame] === 1) union[frame] = 1;
  });
  return union;
}

/** Silences of at least `minSilenceMs` with the range to cut from each. `totalMs` bounds the trailing silence. */
export function detectSilences(levels: Int8Array[], totalMs: number, options: SilenceOptions = DEFAULT_SILENCE): Silence[] {
  const union = speechUnion(levels, options.vad);
  const frames = Math.max(union.length, Math.ceil(totalMs / LEVEL_FRAME_MS));
  const silences: Silence[] = [];
  const half = Math.max(options.edgeMs, options.keepMs / 2);
  let start = -1;
  for (let frame = 0; frame <= frames; frame++) {
    const quiet = frame < frames && union[frame] !== 1;
    if (quiet && start < 0) start = frame;
    if (!quiet && start >= 0) {
      const from = start * LEVEL_FRAME_MS;
      const to = Math.min(frame * LEVEL_FRAME_MS, totalMs);
      start = -1;
      if (to - from < options.minSilenceMs) continue;
      // at the very start and end of the recording only one side borders speech
      const leading = from === 0;
      const trailing = to >= totalMs;
      const cutStart = leading ? from : from + half;
      const cutEnd = trailing ? to : to - half;
      if (cutEnd - cutStart >= LEVEL_FRAME_MS) silences.push({ startMs: from, endMs: to, cut: { s: cutStart, e: cutEnd } });
    }
  }
  return silences;
}
