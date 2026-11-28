// Publishing helpers: template-based titles, description and tags from the transcript, and thumbnail candidates and layout.
// Pure and model-free; src/server/post/llm.ts can improve the wording when a local model is configured.

import { textUnits } from "./captions.js";
import { formatChapters, topKeywords, type Chapter } from "./chapters.js";
import { splitSentences, suggestClips, type Sentence } from "./clips.js";
import { capitalize, isBackchannel, joinWords, startsWithConnective, termsOf, trimTo, type Lang } from "./lexicon.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "./project.js";
import { safeArea, type Canvas, type Rect } from "./safe-area.js";
import type { TranscriptWord } from "./transcript.js";

export const TITLE_MAX_CHARS = 100;
export const TITLE_VARIANTS = 3;
/** YouTube: a description holds up to 5000 characters, the tags up to 500 in all. */
export const DESCRIPTION_MAX_CHARS = 5000;
export const TAGS_MAX_CHARS = 500;
export const TAG_MAX_CHARS = 30;
const SUMMARY_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 700;

export interface DraftInput {
  words: TranscriptWord[];
  chapters: Chapter[];
  /** Names of the speakers, in the order they should be listed. */
  speakers: string[];
  language: Lang;
  /** The name of the recording or show, when there is one. */
  name?: string;
}

export interface PublishDraft {
  /** Three different titles, each at most 100 characters. */
  titles: string[];
  /** A short summary taken from the transcript, the chapter list and the speakers. */
  description: string;
  tags: string[];
}

const LABEL: Record<Lang, { chapters: string; speakers: string; and: string; on: string; fallback: string; full: string; highlights: string }> = {
  en: { chapters: "Chapters:", speakers: "Speakers:", and: "and", on: "on", fallback: "Recording", full: "full conversation", highlights: "highlights" },
  pl: { chapters: "Rozdziały:", speakers: "Rozmówcy:", and: "i", on: "o", fallback: "Nagranie", full: "pełna rozmowa", highlights: "najciekawsze momenty" },
};

/** "a, b and c" (Polish: "a, b i c"). */
function listPhrase(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${LABEL[lang].and} ${items[items.length - 1]}`;
}

/**
 * The sentences that say the most about the recording: the ones with the most frequent content terms (per distinct term, so
 * a long sentence has no advantage), complete, 8-35 words, not a reaction and not a continuation, spread out (a sentence that
 * mostly repeats the terms of an earlier pick is skipped), returned in the order they were said.
 */
export function summarySentences(sentences: Sentence[], lang: Lang, count = SUMMARY_SENTENCES, maxChars = SUMMARY_MAX_CHARS): Sentence[] {
  const termsOfSentence = sentences.map((sentence) => termsOf(sentence.text, lang));
  const frequency = new Map<string, number>();
  for (const terms of termsOfSentence) for (const term of new Set(terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const total = Math.max(1, sentences.length);
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, terms: [...new Set(termsOfSentence[index] ?? [])] }))
    .filter(({ sentence, terms }) => sentence.terminal && sentence.words.length >= 8 && sentence.words.length <= 35 && terms.length >= 3 && !isBackchannel(sentence.words) && !startsWithConnective((sentence.words[0] as TranscriptWord).t, lang))
    .map((item) => {
      const weight = item.terms.reduce((sum, term) => sum + Math.log(1 + (frequency.get(term) ?? 1)), 0) / Math.sqrt(item.terms.length);
      const early = 1 + 0.1 * (1 - item.index / total);
      return { ...item, score: weight * early };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: typeof ranked = [];
  const covered = new Set<string>();
  let chars = 0;
  for (const item of ranked) {
    if (picked.length >= count) break;
    const repeated = item.terms.filter((term) => covered.has(term)).length;
    if (repeated / item.terms.length > 0.5 || chars + item.sentence.text.length + 1 > maxChars) continue;
    picked.push(item);
    chars += item.sentence.text.length + 1;
    for (const term of item.terms) covered.add(term);
  }
  return picked.sort((a, b) => a.index - b.index).map((item) => item.sentence);
}

/** Description text: the summary, the chapter block (when there are chapters) and the speakers line, separated by blank lines. */
export function assembleDescription(parts: { summary: string; chapters: Chapter[]; speakers: string[]; language: Lang }): string {
  const label = LABEL[parts.language];
  const blocks: string[] = [];
  if (parts.summary.trim() !== "") blocks.push(parts.summary.trim());
  if (parts.chapters.length > 0) blocks.push(`${label.chapters}\n${formatChapters(parts.chapters)}`);
  if (parts.speakers.length > 0) blocks.push(`${label.speakers} ${parts.speakers.join(", ")}`);
  const text = blocks.join("\n\n");
  return text.length <= DESCRIPTION_MAX_CHARS ? text : text.slice(0, DESCRIPTION_MAX_CHARS);
}

/** Tags from keywords and names: unique, each at most 30 characters, 500 characters in all (YouTube's limits). */
export function buildTags(candidates: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  let chars = 0;
  for (const raw of candidates) {
    const tag = raw.replace(/\s+/g, " ").trim();
    const key = tag.toLowerCase();
    if (tag === "" || tag.length > TAG_MAX_CHARS || seen.has(key) || chars + tag.length + 1 > TAGS_MAX_CHARS) continue;
    seen.add(key);
    tags.push(tag);
    chars += tag.length + 1;
  }
  return tags;
}

const lowerUnlessName = (text: string): string => (/^\p{Lu}/u.test(text) && text.slice(1) === text.slice(1).toLowerCase() && text.length > 1 ? text : text.toLowerCase());

/**
 * Three title variants, a description and tags from the transcript, with no model: the titles lead with the topic words, with
 * the people, and with a question or key sentence of the talk; the description is the highest-scoring sentences of the
 * transcript (extractive, in the order said), the chapter block and the speakers line. Keywords are the words as they appear
 * in the transcript, so Polish titles use them as a list rather than inflecting them.
 */
export function draftTitleAndDescription(input: DraftInput): PublishDraft {
  const { language } = input;
  const label = LABEL[language];
  const name = input.name?.replace(/\s+/g, " ").trim() || undefined;
  const speakers = input.speakers.map((speaker) => speaker.trim()).filter((speaker) => speaker !== "");
  const keywords = topKeywords(input.words, 6, language).map((keyword) => lowerUnlessName(keyword.text));
  const sentences = splitSentences(input.words);
  const summary = summarySentences(sentences, language);
  const people = listPhrase(speakers.slice(0, 3), language);
  const topic = listPhrase(keywords.slice(0, 3), language);
  const shortTopic = listPhrase(keywords.slice(0, 2), language);
  const question = sentences.find((sentence) => sentence.question && sentence.text.length >= 25 && sentence.text.length <= 90 && !startsWithConnective((sentence.words[0] as TranscriptWord).t, language));
  const hookSentence = question ?? summary[0];
  const hook = hookSentence ? trimTo(capitalize(hookSentence.text.replace(/[\s,;:.]+$/u, "")), 70) : "";

  const candidates: string[] = [];
  if (topic !== "") candidates.push(name ? `${name}: ${topic}` : capitalize(topic));
  if (people !== "" && shortTopic !== "") candidates.push(language === "en" ? `${people} ${label.on} ${shortTopic}` : `${people}: ${shortTopic}`);
  if (hook !== "") candidates.push(name ? `${hook} | ${name}` : hook);
  const base = name ?? (people !== "" ? people : label.fallback);
  candidates.push(base, `${base} – ${label.full}`, `${base} (${label.highlights})`, `${label.fallback} – ${label.full}`, `${label.fallback} (${label.highlights})`);
  const titles: string[] = [];
  for (const candidate of candidates) {
    const title = trimTo(candidate.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
    if (title !== "" && !titles.some((existing) => existing.toLowerCase() === title.toLowerCase())) titles.push(title);
    if (titles.length === TITLE_VARIANTS) break;
  }

  const description = assembleDescription({ summary: joinWords(summary.map((sentence) => ({ t: sentence.text }))), chapters: input.chapters, speakers, language });
  const tags = buildTags([...keywords, ...(name ? [name.toLowerCase()] : []), ...speakers]);
  return { titles, description, tags };
}

// ---- thumbnails ---------------------------------------------------------------------------------------------------------

export type ThumbnailKind = "video" | "short";

export interface ThumbnailSpec {
  width: number;
  height: number;
  /** Largest file size in bytes. */
  maxBytes: number;
}

/** The size of a thumbnail picture: 16:9 for a video, 9:16 for a Short; under 50 MB. */
export function thumbnailSpec(kind: ThumbnailKind): ThumbnailSpec {
  return kind === "short" ? { width: 2160, height: 3840, maxBytes: 50 * 1024 * 1024 } : { width: 3840, height: 2160, maxBytes: 50 * 1024 * 1024 };
}

export interface ThumbnailInput {
  durationMs: number;
  highlights: { tMs: number }[];
  words: TranscriptWord[];
  levels?: { pid: string; levels: Int8Array }[];
}

const THUMB_MIN_SPACING_MS = 3000;
const THUMB_MAX = 8;
const THUMB_PER_KIND = 3;
const ENERGY_WINDOW_FRAMES = 50;
const ENERGY_SPACING_MS = 15_000;

/** Centres (ms) of the loudest one-second stretches of the recording (the loudest track at each moment), at least 15 s apart. */
function energyPeaks(levels: { levels: Int8Array }[], count: number): number[] {
  const frames = Math.max(0, ...levels.map((track) => track.levels.length));
  if (frames < ENERGY_WINDOW_FRAMES) return [];
  const loudest = new Float64Array(frames + 1);
  for (let frame = 0; frame < frames; frame++) {
    let max = LEVEL_FLOOR_DB;
    for (const track of levels) max = Math.max(max, track.levels[frame] ?? LEVEL_FLOOR_DB);
    loudest[frame + 1] = (loudest[frame] as number) + max;
  }
  const windows: { at: number; value: number }[] = [];
  for (let frame = 0; frame + ENERGY_WINDOW_FRAMES <= frames; frame += 10) windows.push({ at: (frame + ENERGY_WINDOW_FRAMES / 2) * LEVEL_FRAME_MS, value: ((loudest[frame + ENERGY_WINDOW_FRAMES] as number) - (loudest[frame] as number)) / ENERGY_WINDOW_FRAMES });
  windows.sort((a, b) => b.value - a.value || a.at - b.at);
  const picked: number[] = [];
  for (const window of windows) {
    if (picked.length >= count) break;
    if (picked.every((at) => Math.abs(at - window.at) >= ENERGY_SPACING_MS)) picked.push(window.at);
  }
  return picked;
}

/**
 * Up to eight moments (ms on the project timeline) to offer as thumbnail frames, best first: flagged highlights, a moment
 * half a second into each of the best clips (a speaker mid-sentence, not between words), and the loudest moments. The three
 * kinds alternate so the offer is varied; moments closer than 3 s to one already offered are skipped. A recording with
 * nothing to go on gets three evenly spread moments. Empty for an empty recording.
 */
export function thumbnailCandidates(input: ThumbnailInput): number[] {
  const { durationMs } = input;
  if (!(durationMs > 0)) return [];
  const markers = [...input.highlights].map((highlight) => highlight.tMs).filter((at) => Number.isFinite(at)).sort((a, b) => a - b).slice(0, THUMB_PER_KIND + 1);
  const clipFrames = suggestClips({ words: input.words, ...(input.levels ? { levels: input.levels } : {}), highlights: input.highlights, durationMs, limit: THUMB_PER_KIND }).map((clip) => clip.s + 500);
  const loud = input.levels && input.levels.length > 0 ? energyPeaks(input.levels, THUMB_PER_KIND) : [];
  const lists = [markers, clipFrames, loud];
  const out: number[] = [];
  const last = Math.max(0, Math.round(durationMs) - 1);
  for (let k = 0; out.length < THUMB_MAX && lists.some((list) => k < list.length); k++) {
    for (const list of lists) {
      const at = list[k];
      if (at === undefined || out.length >= THUMB_MAX) continue;
      const clamped = Math.min(last, Math.max(0, Math.round(at)));
      if (out.every((other) => Math.abs(other - clamped) >= THUMB_MIN_SPACING_MS)) out.push(clamped);
    }
  }
  if (out.length === 0) return [0.1, 0.5, 0.9].map((share) => Math.round(durationMs * share));
  return out;
}

export interface OverlayLayout {
  lines: string[];
  /** In pixels of the thumbnail picture. */
  fontSize: number;
  /** The block behind the text, padding included; always inside the safe area. */
  box: Rect;
}

/** Where a headline goes: the left or the right third of a video thumbnail, or the top of a Short. */
export type OverlayPlacement = "left" | "right" | "top";

/** Distance between the baselines of two lines of a headline, in em: tight, as heavy capitals want it. */
export const LINE_HEIGHT_EM = 1.02;
const PAD_EM = 0.3;
/** Width of the black stroke around the letters of a headline, in em. */
export const OUTLINE_EM = 0.09;

interface PlacementRules {
  /** Widest block, as a share of the picture's width. */
  width: number;
  /** Tallest block, as a share of the safe area's height. */
  height: number;
  maxLines: number;
  /** Largest font size, as a share of the picture's short side. */
  size: number;
}

const SIDE_RULES: PlacementRules = { width: 0.36, height: 0.7, maxLines: 5, size: 0.2 };
const PLACEMENT_RULES: Record<OverlayPlacement, PlacementRules> = { left: SIDE_RULES, right: SIDE_RULES, top: { width: 1, height: 0.3, maxLines: 3, size: 0.12 } };

/** Words broken into lines no wider than `maxWidth`, as even as the line count allows; null when one word is wider. */
function wrapEvenly(words: string[], widthOf: (text: string) => number, maxWidth: number): string[] | null {
  const greedy = (limit: number): string[] | null => {
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (widthOf(word) > limit) return null;
      const candidate = line === "" ? word : `${line} ${word}`;
      if (widthOf(candidate) <= limit) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line !== "") lines.push(line);
    return lines;
  };
  const first = greedy(maxWidth);
  if (!first) return null;
  let low = Math.max(...words.map(widthOf));
  let high = maxWidth;
  for (let step = 0; step < 24; step++) {
    const mid = (low + high) / 2;
    const attempt = greedy(mid);
    if (attempt && attempt.length <= first.length) high = mid;
    else low = mid;
  }
  return greedy(high) ?? first;
}

/**
 * Lines, font size and block of a headline on a thumbnail: the largest bold size (using the advance widths of the bundled
 * font) at which the text wraps into the placement's line limit and its block, padding included, stays inside the safe area
 * and its width and height limits. A block on the left or right is flush with that edge of the safe area and centred
 * vertically; at the top it is centred horizontally. A text that cannot fit even at the smallest size is cut after as many
 * words as fit and ends with "…". `text` is measured as given: pass it in the case it is drawn.
 */
export function overlayTextLayout(text: string, spec: Canvas, placement: OverlayPlacement): OverlayLayout {
  const safe = safeArea(spec);
  const rules = PLACEMENT_RULES[placement];
  const shortSide = Math.min(spec.width, spec.height);
  const minSize = Math.max(8, Math.round(shortSide * 0.04));
  const maxSize = Math.round(shortSide * rules.size);
  const maxWidth = Math.min(safe.w, Math.round(spec.width * rules.width));
  const maxHeight = Math.floor(safe.h * rules.height);
  const widthAt = (candidate: string, size: number): number => (textUnits(candidate, true) / 1000) * size;
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { lines: [], fontSize: minSize, box: { x: safe.x, y: safe.y, w: 0, h: 0 } };

  const place = (parts: string[], size: number): OverlayLayout | null => {
    const pad = Math.ceil(size * PAD_EM);
    const lines = wrapEvenly(parts, (candidate) => widthAt(candidate, size), maxWidth - 2 * pad);
    if (!lines || lines.length > rules.maxLines) return null;
    const height = Math.ceil(lines.length * size * LINE_HEIGHT_EM) + 2 * pad;
    if (height > maxHeight) return null;
    const width = Math.ceil(Math.max(...lines.map((line) => widthAt(line, size)))) + 2 * pad;
    const x = placement === "left" ? safe.x : placement === "right" ? safe.x + safe.w - width : safe.x + Math.floor((safe.w - width) / 2);
    const y = placement === "top" ? safe.y : safe.y + Math.floor((safe.h - height) / 2);
    return { lines, fontSize: size, box: { x, y, w: width, h: height } };
  };
  for (let size = maxSize; size >= minSize; size = Math.floor(size * 0.96)) {
    const layout = place(words, size);
    if (layout) return layout;
  }

  // too long even at the smallest size: the most words that fit, the last one followed by an ellipsis
  const cut = (count: number): string[] => [...words.slice(0, count - 1), `${(words[count - 1] as string).replace(/…+$/u, "")}…`];
  let best: OverlayLayout | null = null;
  for (let low = 1, high = words.length - 1; low <= high; ) {
    const mid = (low + high) >> 1;
    const layout = place(cut(mid), minSize);
    if (layout) {
      best = layout;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (best) return best;
  // not even one word: as many of its letters as fit
  const letters = [...(words[0] as string)];
  for (let low = 1, high = letters.length - 1; low <= high; ) {
    const mid = (low + high) >> 1;
    const layout = place([`${letters.slice(0, mid).join("")}…`], minSize);
    if (layout) {
      best = layout;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best ?? { lines: ["…"], fontSize: minSize, box: { ...safe } };
}
