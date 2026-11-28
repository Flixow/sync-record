// Which moments of a recording to try as thumbnail frames and whose face to show at each of them. Pure.

import { splitSentences, type Sentence } from "./clips.js";
import type { Lang } from "./lexicon.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS, type ProjectSource } from "./project.js";
import { thumbnailCandidates, summarySentences, type ThumbnailInput } from "./publish.js";
import type { ActivityTrack, Scene } from "./scenes.js";
import type { TranscriptWord } from "./transcript.js";

/** How many frames the previews offer at most. */
export const PREVIEW_LIMIT = 12;
/** Frames this far apart look alike; the previews keep one of them. */
const MIN_SPACING_MS = 2500;
/** A speech moment is looked for this far from a wanted instant at most. */
const SPEECH_REACH_MS = 1500;
const SUMMARY_PICKS = 4;
/** Offsets of the alternatives offered around a chosen frame: a blink is gone within a few tenths of a second. */
export const NEIGHBOUR_OFFSETS_MS: readonly number[] = [-800, -400, 400, 800];

/** The middle of the word spoken at `atMs`, or of the nearest word within reach; `atMs` itself when nobody speaks near it. */
export function midSpeech(words: TranscriptWord[], atMs: number): number {
  let best: TranscriptWord | null = null;
  let bestGap = SPEECH_REACH_MS + 1;
  for (const word of words) {
    const gap = atMs < word.s ? word.s - atMs : atMs >= word.e ? atMs - word.e : 0;
    if (gap < bestGap) {
      best = word;
      bestGap = gap;
    }
  }
  return best ? Math.round((best.s + best.e) / 2) : atMs;
}

export interface MomentInput extends ThumbnailInput {
  language: Lang;
}

/**
 * Up to `limit` moments (ms on the project timeline) to render as candidate frames, most promising first: the moments of
 * `thumbnailCandidates` (highlights, the starts of the best clips, the loudest stretches) moved to the middle of the word
 * spoken there, alternating with the middle of the sentences that say the most about the recording. A speaker mid-sentence
 * has a more alive face than one between words. Moments closer than 2.5 s to a better one are skipped.
 */
export function previewMoments(input: MomentInput, limit = PREVIEW_LIMIT): number[] {
  const base = thumbnailCandidates(input).map((at) => midSpeech(input.words, at));
  const said = summarySentences(splitSentences(input.words), input.language, SUMMARY_PICKS).map((sentence) => midSpeech(input.words, sentenceMiddle(sentence)));
  const lists = [base, said];
  const last = Math.max(0, Math.round(input.durationMs) - 1);
  const out: number[] = [];
  for (let k = 0; out.length < limit && lists.some((list) => k < list.length); k++) {
    for (const list of lists) {
      const at = list[k];
      if (at === undefined || out.length >= limit) continue;
      const clamped = Math.min(last, Math.max(0, Math.round(at)));
      if (out.every((other) => Math.abs(other - clamped) >= MIN_SPACING_MS)) out.push(clamped);
    }
  }
  return out;
}

const sentenceMiddle = (sentence: Sentence): number => {
  const word = sentence.words[Math.floor(sentence.words.length / 2)];
  return word ? (word.s + word.e) / 2 : (sentence.s + sentence.e) / 2;
};

/** Alternatives of a chosen moment inside the same sentence or breath: a few tenths of a second before and after, inside the recording. */
export function neighbourMoments(atMs: number, durationMs: number): number[] {
  const last = Math.max(0, Math.round(durationMs) - 1);
  const out: number[] = [];
  for (const offset of NEIGHBOUR_OFFSETS_MS) {
    const at = Math.round(atMs + offset);
    if (at >= 0 && at <= last && at !== Math.round(atMs) && !out.includes(at)) out.push(at);
  }
  return out;
}

/**
 * What is said at `atMs`: the sentence spoken then (the nearest one when it falls in a pause) and that sentence with the one
 * before and the one after it. Both empty for a recording without speech.
 */
export function sentenceContext(words: TranscriptWord[], atMs: number): { sentence: string; context: string } {
  const sentences = splitSentences(words);
  let index = -1;
  let bestGap = Infinity;
  for (const [at, sentence] of sentences.entries()) {
    const gap = atMs < sentence.s ? sentence.s - atMs : atMs > sentence.e ? atMs - sentence.e : 0;
    if (gap < bestGap) {
      index = at;
      bestGap = gap;
    }
  }
  const current = sentences[index];
  if (!current) return { sentence: "", context: "" };
  return { sentence: current.text, context: sentences.slice(Math.max(0, index - 1), index + 2).map((sentence) => sentence.text).join(" ") };
}

/** The picture a thumbnail frame shows: a person's camera (the one who speaks) or, with no camera running, a screen. */
export interface Subject {
  /** Source id of the picture. */
  id: string;
  kind: "camera" | "screen";
  /** The program shows a screen at that moment, so the speaker is probably looking at it and not at the camera. */
  screenFeatured: boolean;
}

type SubjectSource = Pick<ProjectSource, "id" | "kind" | "hasVideo" | "width" | "height" | "offsetMs" | "timelineDurationMs">;

/** How long around the moment the loudness of the microphones is compared. */
const WINDOW_MS = 800;

function meanLevel(track: ActivityTrack | undefined, atMs: number): number {
  if (!track || track.levels.length === 0) return LEVEL_FLOOR_DB;
  const from = Math.max(0, Math.floor((atMs - WINDOW_MS / 2) / LEVEL_FRAME_MS));
  const to = Math.min(track.levels.length, Math.ceil((atMs + WINDOW_MS / 2) / LEVEL_FRAME_MS));
  if (to <= from) return LEVEL_FLOOR_DB;
  let sum = 0;
  for (let frame = from; frame < to; frame++) sum += track.levels[frame] as number;
  return sum / (to - from);
}

/**
 * Whose picture a thumbnail frame at `atMs` shows: the camera, recording at that moment, whose microphone is loudest around
 * it (the active speaker; with equal levels the one the scene plan features first). With no camera running, the screen the
 * scene features, then any screen. Null when no picture was recording.
 */
export function subjectAt(input: { sources: SubjectSource[]; tracks: ActivityTrack[]; scene: Scene | null; atMs: number }): Subject | null {
  const { atMs, scene } = input;
  const recording = input.sources.filter((source) => source.hasVideo && Boolean(source.width) && Boolean(source.height) && source.offsetMs <= atMs && atMs < source.offsetMs + source.timelineDurationMs);
  const screens = new Set(recording.filter((source) => source.kind === "screen").map((source) => source.id));
  const screenFeatured = scene !== null && screens.has(scene.sources[0] ?? "");
  const featured = (id: string): number => {
    const index = scene?.sources.indexOf(id) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const cameras = recording.filter((source) => source.kind === "camera");
  if (cameras.length > 0) {
    const ranked = cameras
      .map((source) => ({ id: source.id, level: meanLevel(input.tracks.find((track) => track.id === source.id), atMs), order: featured(source.id) }))
      .sort((a, b) => b.level - a.level || a.order - b.order);
    const top = ranked[0];
    if (top) return { id: top.id, kind: "camera", screenFeatured };
  }
  const screen = recording.filter((source) => source.kind === "screen").sort((a, b) => featured(a.id) - featured(b.id))[0];
  return screen ? { id: screen.id, kind: "screen", screenFeatured } : null;
}
