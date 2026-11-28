// Microphones recorded at very different gain. A level track is only comparable with the others when the quiet ones are
// lifted to the level of the loudest, so voice activity, scene planning, silence detection and the mix all see them
// through the same static boost per track.

import { LEVEL_FLOOR_DB } from "./project.js";
import { DEFAULT_VAD, noiseFloorDb } from "./vad.js";

/** Percentile of the frame levels that stands for how loud the track is when its owner talks. */
export const REFERENCE_PERCENTILE = 99;
/** A track whose loud end is not this far (dB) above its noise floor has no speech to measure. */
export const MIN_SPREAD_DB = 20;
/** A track at most this far (dB) under the loudest one is left alone. */
export const MIN_GAP_DB = 10;
/** The largest boost (dB) of one track. */
export const MAX_BOOST_DB = 48;

/** Level of the loud end of a track in dB, or null when the track has no usable speech (silence or noise only). */
export function referenceDb(levels: Int8Array): number | null {
  const top = noiseFloorDb(levels, REFERENCE_PERCENTILE);
  return top - noiseFloorDb(levels, DEFAULT_VAD.floorPercentile) >= MIN_SPREAD_DB ? top : null;
}

/** Static boost in dB of every track, toward the loudest one; 0 for tracks within `MIN_GAP_DB` of it. */
export function boostsDb(tracks: Int8Array[]): number[] {
  const references = tracks.map(referenceDb);
  const known = references.filter((value): value is number => value !== null);
  if (known.length === 0) return references.map(() => 0);
  const loudest = Math.max(...known);
  return references.map((reference) => {
    if (reference === null) return 0;
    const gap = loudest - reference;
    return gap < MIN_GAP_DB ? 0 : Math.min(MAX_BOOST_DB, Math.round(gap * 2) / 2);
  });
}

/** The track `boost` dB louder; frames at the floor stay there, nothing goes above 0 dBFS. */
export function boostLevels(levels: Int8Array, boost: number): Int8Array {
  if (boost <= 0) return levels;
  const out = new Int8Array(levels.length);
  for (let frame = 0; frame < levels.length; frame++) {
    const level = levels[frame] as number;
    out[frame] = level <= LEVEL_FLOOR_DB ? level : Math.min(0, Math.round(level + boost));
  }
  return out;
}
