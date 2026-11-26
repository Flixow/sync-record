// Transcript model, bleed de-duplication, cues and the text formats (SRT, WebVTT, plain text).

import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "./project.js";

export const TRANSCRIPT_SCHEMA_VERSION = 1;

export interface TranscriptWord {
  /** The word as the engine wrote it, with its punctuation. */
  t: string;
  /** Start and end on the project timeline, in ms. */
  s: number;
  e: number;
  /** The source (audio track) the word was heard on, and its participant. */
  src: string;
  pid: string;
}

export interface TranscriptSpeaker {
  pid: string;
  name: string;
}

export interface TranscriptFile {
  schemaVersion: number;
  lang: string;
  engine: string;
  model: string;
  createdAtMs: number;
  speakers: TranscriptSpeaker[];
  words: TranscriptWord[];
  /** Words removed because the same word was louder on another track at the same time (speaker bleed). */
  bleedDropped: number;
  stats: { engineWallSec: number; speechSec: number; audioSec: number };
}

/** Letters and digits only, lower case: the form in which two engines' spellings of a word are compared. */
export function wordKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function sentenceEnd(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text.trim());
}

/** Mean level (dBFS) of a level track over [startMs, endMs). */
export function meanLevelDb(levels: Int8Array, startMs: number, endMs: number): number {
  const from = Math.max(0, Math.floor(startMs / LEVEL_FRAME_MS));
  const to = Math.min(levels.length, Math.max(from + 1, Math.ceil(endMs / LEVEL_FRAME_MS)));
  if (to <= from) return LEVEL_FLOOR_DB;
  let sum = 0;
  for (let frame = from; frame < to; frame++) sum += levels[frame] ?? LEVEL_FLOOR_DB;
  return sum / (to - from);
}

export interface DedupeOptions {
  /** Two words count as the same utterance when their starts are at most this far apart, in ms. */
  windowMs: number;
  /** The louder copy wins only when it is at least this much louder (dB); closer than that is real crosstalk and both stay. */
  marginDb: number;
}

export const DEFAULT_DEDUPE: DedupeOptions = { windowMs: 400, marginDb: 3 };

/**
 * Speaker bleed puts a quiet copy of a word on the other microphones. When the same word (ignoring case and
 * punctuation) appears on two tracks at the same time, the copy on the louder track is kept.
 * `levelOf` returns the level track of a source, or null when unknown.
 */
export function dedupeBleed(words: TranscriptWord[], levelOf: (src: string) => Int8Array | null, options: DedupeOptions = DEFAULT_DEDUPE): { words: TranscriptWord[]; dropped: number } {
  const sorted = [...words].sort((a, b) => a.s - b.s || a.e - b.e);
  const drop = new Set<TranscriptWord>();
  const loudness = new Map<TranscriptWord, number>();
  const level = (word: TranscriptWord): number => {
    let value = loudness.get(word);
    if (value === undefined) {
      const track = levelOf(word.src);
      value = track ? meanLevelDb(track, word.s, word.e) : LEVEL_FLOOR_DB;
      loudness.set(word, value);
    }
    return value;
  };
  for (let i = 0; i < sorted.length; i++) {
    const word = sorted[i];
    if (!word || drop.has(word)) continue;
    const key = wordKey(word.t);
    if (key === "") continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j];
      if (!other) break;
      if (other.s - word.s > options.windowMs) break;
      if (other.src === word.src || drop.has(other) || wordKey(other.t) !== key) continue;
      const difference = level(word) - level(other);
      if (Math.abs(difference) < options.marginDb) continue;
      drop.add(difference > 0 ? other : word);
      if (difference < 0) break;
    }
  }
  return { words: sorted.filter((word) => !drop.has(word)), dropped: drop.size };
}

/** Share of words that still have the same word on another track within `windowMs` (after de-duplication this should be near zero). */
export function duplicateRate(words: TranscriptWord[], windowMs = 400): number {
  const sorted = [...words].sort((a, b) => a.s - b.s);
  let duplicates = 0;
  for (let i = 0; i < sorted.length; i++) {
    const word = sorted[i];
    if (!word) continue;
    const key = wordKey(word.t);
    let found = false;
    for (let j = i - 1; j >= 0 && !found; j--) {
      const other = sorted[j];
      if (!other || word.s - other.s > windowMs) break;
      found = other.src !== word.src && wordKey(other.t) === key;
    }
    for (let j = i + 1; j < sorted.length && !found; j++) {
      const other = sorted[j];
      if (!other || other.s - word.s > windowMs) break;
      found = other.src !== word.src && wordKey(other.t) === key;
    }
    if (found) duplicates += 1;
  }
  return sorted.length === 0 ? 0 : duplicates / sorted.length;
}

// ---- cues and text formats ----------------------------------------------------------------------------------------

export interface Cue {
  startMs: number;
  endMs: number;
  speaker: string;
  /** One or two lines. */
  lines: string[];
}

export interface CueOptions {
  maxLineChars: number;
  maxLines: number;
  maxDurationMs: number;
  /** A pause between two words longer than this starts a new cue. */
  pauseMs: number;
}

export const DEFAULT_CUES: CueOptions = { maxLineChars: 42, maxLines: 2, maxDurationMs: 6000, pauseMs: 800 };

/** Breaks text into at most `maxLines` lines of at most `maxChars`, as evenly as the words allow. Null when it does not fit. */
export function wrapLines(words: string[], maxChars: number, maxLines: number): string[] | null {
  const text = words.join(" ");
  if (text.length <= maxChars) return [text];
  if (maxLines < 2) return null;
  let best: string[] | null = null;
  let bestWorst = Infinity;
  for (let split = 1; split < words.length; split++) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    if (first.length > maxChars || second.length > maxChars) continue;
    const worst = Math.max(first.length, second.length);
    if (worst < bestWorst) {
      bestWorst = worst;
      best = [first, second];
    }
  }
  return best;
}

/** The shortest a cue stays on screen when neighbouring cues are trimmed or moved. */
const MIN_CUE_MS = 100;

/** Groups words (already on the time axis of the output) into cues: one speaker per cue, sentence and pause aware. */
export function buildCues(words: TranscriptWord[], nameOf: (pid: string) => string, options: CueOptions = DEFAULT_CUES): Cue[] {
  const cues: Cue[] = [];
  let current: TranscriptWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) {
      const lines = wrapLines(current.map((word) => word.t), options.maxLineChars, options.maxLines) ?? [current.map((word) => word.t).join(" ")];
      cues.push({ startMs: first.s, endMs: Math.max(last.e, first.s + 200), speaker: nameOf(first.pid), lines });
    }
    current = [];
  };
  for (const word of [...words].sort((a, b) => a.s - b.s)) {
    const previous = current[current.length - 1];
    if (previous) {
      const joined = [...current, word].map((item) => item.t);
      const fits = wrapLines(joined, options.maxLineChars, options.maxLines) !== null;
      const longEnough = previous.e - (current[0]?.s ?? previous.e) > options.maxDurationMs * 0.4;
      if (previous.pid !== word.pid || word.s - previous.e > options.pauseMs || word.e - (current[0]?.s ?? word.s) > options.maxDurationMs || !fits || (sentenceEnd(previous.t) && longEnough)) flush();
    }
    current.push(word);
  }
  flush();
  // A cue never overlaps the next one: the earlier cue is cut at the start of the next. When the two start within the
  // minimum length of each other (two speakers saying the same thing together), the later cue moves back instead, so
  // that every cue keeps a positive length and starts are still ascending.
  for (let i = 0; i + 1 < cues.length; i++) {
    const a = cues[i];
    const b = cues[i + 1];
    if (!a || !b || a.endMs <= b.startMs) continue;
    if (b.startMs >= a.startMs + MIN_CUE_MS) {
      a.endMs = b.startMs;
    } else {
      a.endMs = a.startMs + MIN_CUE_MS;
      b.startMs = a.endMs;
      b.endMs = Math.max(b.endMs, b.startMs + MIN_CUE_MS);
    }
  }
  return cues;
}

const pad = (value: number, size: number): string => String(value).padStart(size, "0");

export function timestamp(ms: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(total % 1000, 3)}`;
}

function cueText(cue: Cue, withSpeaker: boolean, previousSpeaker: string | null): string[] {
  if (!withSpeaker || cue.speaker === previousSpeaker) return cue.lines;
  const [first, ...rest] = cue.lines;
  return [`${cue.speaker}: ${first ?? ""}`, ...rest];
}

export function toSrt(cues: Cue[], withSpeaker = false): string {
  let previous: string | null = null;
  return (
    cues
      .map((cue, index) => {
        const lines = cueText(cue, withSpeaker, previous);
        previous = cue.speaker;
        return `${index + 1}\n${timestamp(cue.startMs, ",")} --> ${timestamp(cue.endMs, ",")}\n${lines.join("\n")}\n`;
      })
      .join("\n") || ""
  );
}

export function toVtt(cues: Cue[], withSpeaker = false): string {
  const body = cues
    .map((cue) => {
      const lines = cue.lines.map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
      const text = withSpeaker ? `<v ${cue.speaker.replace(/[<>&\n]/g, " ")}>${lines.join("\n")}` : lines.join("\n");
      return `${timestamp(cue.startMs, ".")} --> ${timestamp(cue.endMs, ".")}\n${text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Plain text: one paragraph per speaker turn, with the time of the turn. */
export function toTxt(words: TranscriptWord[], nameOf: (pid: string) => string, pauseMs = 2500): string {
  const turns: { pid: string; startMs: number; text: string[] }[] = [];
  let lastEnd = 0;
  for (const word of [...words].sort((a, b) => a.s - b.s)) {
    const turn = turns[turns.length - 1];
    if (!turn || turn.pid !== word.pid || word.s - lastEnd > pauseMs) turns.push({ pid: word.pid, startMs: word.s, text: [word.t] });
    else turn.text.push(word.t);
    lastEnd = word.e;
  }
  return turns.map((turn) => `[${timestamp(turn.startMs, ".").slice(0, 8)}] ${nameOf(turn.pid)}: ${turn.text.join(" ")}`).join("\n\n") + "\n";
}

/** Indices of words containing the query (case and punctuation ignored); a query of several words matches the phrase. */
export function searchWords(words: { t: string }[], query: string): number[] {
  const parts = query.trim().split(/\s+/).map(wordKey).filter((part) => part !== "");
  if (parts.length === 0) return [];
  const keys = words.map((word) => wordKey(word.t));
  const hits: number[] = [];
  for (let i = 0; i + parts.length <= keys.length; i++) {
    let match = true;
    for (let k = 0; k < parts.length && match; k++) {
      const key = keys[i + k] ?? "";
      match = k === parts.length - 1 ? key.includes(parts[k] ?? "") : key === parts[k];
    }
    if (match) hits.push(i);
  }
  return hits;
}

// ---- validation (used by tests and by the export step before it answers) -------------------------------------------

const SRT_TIME = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})$/;
const VTT_TIME = /^(\d{2,}:)?(\d{2}):(\d{2})\.(\d{3}) --> (\d{2,}:)?(\d{2}):(\d{2})\.(\d{3})/;

const clock = (parts: string[]): number => (Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000 + Number(parts[3]);

/** Problems found in SRT text; empty when it is valid (numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line, ascending times). */
export function validateSrt(text: string): string[] {
  const problems: string[] = [];
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  let previousEnd = -1;
  blocks.forEach((block, index) => {
    const lines = block.split("\n");
    if (lines[0] !== String(index + 1)) problems.push(`cue ${index + 1}: wrong index "${lines[0]}"`);
    const match = SRT_TIME.exec(lines[1] ?? "");
    if (!match) {
      problems.push(`cue ${index + 1}: bad time line "${lines[1]}"`);
      return;
    }
    const start = clock([match[1] ?? "0", match[2] ?? "0", match[3] ?? "0", match[4] ?? "0"]);
    const end = clock([match[5] ?? "0", match[6] ?? "0", match[7] ?? "0", match[8] ?? "0"]);
    if (end <= start) problems.push(`cue ${index + 1}: ends before it starts`);
    if (start < previousEnd) problems.push(`cue ${index + 1}: starts before the previous cue ended`);
    previousEnd = end;
    if (lines.slice(2).join("").trim() === "") problems.push(`cue ${index + 1}: no text`);
  });
  return problems;
}

/** Problems found in WebVTT text; empty when it is valid. */
export function validateVtt(text: string): string[] {
  const problems: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("WEBVTT")) problems.push("missing WEBVTT header");
  const blocks = normalized.split(/\n\n+/).slice(1).filter((block) => block.trim() !== "");
  let previousStart = -1;
  blocks.forEach((block, index) => {
    const lines = block.split("\n");
    const timeLine = lines.find((line) => line.includes("-->")) ?? "";
    const match = VTT_TIME.exec(timeLine);
    if (!match) {
      problems.push(`cue ${index + 1}: bad time line "${timeLine}"`);
      return;
    }
    const start = clock([(match[1] ?? "00:").replace(":", ""), match[2] ?? "0", match[3] ?? "0", match[4] ?? "0"]);
    const end = clock([(match[5] ?? "00:").replace(":", ""), match[6] ?? "0", match[7] ?? "0", match[8] ?? "0"]);
    if (end <= start) problems.push(`cue ${index + 1}: ends before it starts`);
    if (start < previousStart) problems.push(`cue ${index + 1}: starts before the previous cue`);
    previousStart = start;
  });
  return problems;
}
