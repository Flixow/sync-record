// Builds transcript words from a script of lines, for the post-production tests (clips, chapters, publishing).

import type { TranscriptWord } from "../../src/shared/transcript.js";

export interface Line {
  pid: string;
  text: string;
  /** Pause before the line, in ms. 600 */
  gap?: number;
  /** Milliseconds per word. 320 */
  pace?: number;
}

export const SPEAKERS: { A: string; B: string } = { A: "p1-anna", B: "p2-bartek" };

/** Words of the lines one after another from `startMs`; each token of a line is a word with its punctuation attached. */
export function script(lines: Line[], startMs = 1000): { words: TranscriptWord[]; endMs: number } {
  const words: TranscriptWord[] = [];
  let at = startMs;
  for (const line of lines) {
    at += line.gap ?? 600;
    for (const token of line.text.split(/\s+/).filter((part) => part !== "")) {
      const pace = line.pace ?? 320;
      words.push({ t: token, s: at, e: at + pace, src: `${line.pid}-audio-0001`, pid: line.pid });
      at += pace;
    }
  }
  return { words, endMs: at };
}

/** A tiny deterministic generator (mulberry32), so test data does not change between runs. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
