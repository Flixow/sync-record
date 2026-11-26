// Chapters from the transcript, without a model: lexical cohesion between neighbouring blocks of sentences (TextTiling),
// boundaries at the valleys, titles from the most characteristic words, and YouTube's rules for a chapter list enforced.

import { findRemoved, keptDuration, toOutput, type Edl } from "./edl.js";
import { splitSentences, type Sentence } from "./clips.js";
import { capitalize, detectLanguage, stem, termsOf, tokenize, STOP_WORDS, trimTo, type Lang } from "./lexicon.js";
import type { TranscriptWord } from "./transcript.js";

export const MIN_CHAPTERS = 3;
/** YouTube: chapters are at least 10 s long. */
export const MIN_CHAPTER_GAP_MS = 10_000;
const TITLE_MAX_CHARS = 60;
/** A block of sentences on either side of a gap holds at least this many content terms (and two sentences), at most 14 sentences. */
const BLOCK_TERMS = 60;
const BLOCK_MAX_SENTENCES = 14;
/**
 * A valley counts when it is this many standard deviations deeper than the average gap, at least MIN_DEPTH deep (cosine units)
 * and at least RELATIVE_DEPTH of the deepest valley: random word choice makes shallow dips in the middle of a topic.
 */
const DEPTH_SD = 1;
const MIN_DEPTH = 0.3;
const RELATIVE_DEPTH = 0.3;

export interface Topic {
  /** On the timeline of the words, in ms; the first topic starts at 0 and the last one ends at the duration. */
  s: number;
  e: number;
}

export interface Chapter {
  startMs: number;
  title: string;
}

export interface SegmentOptions {
  /** No chapter is shorter than this. 60000 */
  minChapterMs?: number;
  /** Upper bound of the number of topics, the first one included. 15 */
  maxChapters?: number;
  /** Language of the transcript; detected when absent. */
  lang?: Lang;
}

type Counts = Map<string, number>;

function addTerms(into: Counts, terms: string[]): void {
  for (const term of terms) into.set(term, (into.get(term) ?? 0) + 1);
}

function cosine(a: Counts, b: Counts): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, count] of a) {
    normA += count * count;
    dot += count * (b.get(term) ?? 0);
  }
  for (const count of b.values()) normB += count * count;
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** Terms of the block of sentences that ends just before gap `g` (side -1) or starts right after it (side 1). */
function blockAround(terms: string[][], gap: number, side: -1 | 1): Counts {
  const counts: Counts = new Map();
  let total = 0;
  let taken = 0;
  for (let k = side === -1 ? gap - 1 : gap; k >= 0 && k < terms.length && taken < BLOCK_MAX_SENTENCES; k += side) {
    addTerms(counts, terms[k] as string[]);
    total += (terms[k] as string[]).length;
    taken += 1;
    if (taken >= 2 && total >= BLOCK_TERMS) break;
  }
  return counts;
}

/**
 * Splits the recording into topics. Between every two sentences the cosine similarity of the term counts of the block before
 * and the block after is computed (content terms, stop words of both languages dropped, Polish words cut to a five-letter
 * prefix, English ones lightly stemmed), smoothed over three gaps; every valley gets a depth (how far the similarity climbs on
 * both sides). The deepest valleys that are clearly deeper than the average one win, at least `minChapterMs` from each other and from both ends,
 * at most `maxChapters` topics. Boundaries sit on sentence starts; the first topic starts at 0 and the last ends at `durationMs`.
 */
export function segmentTopics(words: TranscriptWord[], durationMs: number, opts: SegmentOptions = {}): Topic[] {
  const minMs = opts.minChapterMs ?? 60_000;
  const maxChapters = opts.maxChapters ?? 15;
  const whole: Topic[] = [{ s: 0, e: durationMs }];
  const sentences = splitSentences(words);
  if (sentences.length < 4 || maxChapters < 2 || durationMs < 2 * minMs) return whole;
  const lang = opts.lang ?? detectLanguage(words);
  const terms = sentences.map((sentence) => termsOf(sentence.text, lang));

  // similarity of the blocks around gap g (between sentence g-1 and g), g = 1..n-1; index 0 unused
  const raw: number[] = [0];
  for (let g = 1; g < sentences.length; g++) raw.push(cosine(blockAround(terms, g, -1), blockAround(terms, g, 1)));
  const sim = raw.map((value, g) => {
    if (g === 0) return 0;
    const from = Math.max(1, g - 1);
    const to = Math.min(raw.length - 1, g + 1);
    let sum = 0;
    for (let k = from; k <= to; k++) sum += raw[k] as number;
    return sum / (to - from + 1);
  });

  const depth: number[] = [0];
  for (let g = 1; g < sentences.length; g++) {
    let left = g;
    while (left > 1 && (sim[left - 1] as number) >= (sim[left] as number)) left -= 1;
    let right = g;
    while (right < sentences.length - 1 && (sim[right + 1] as number) >= (sim[right] as number)) right += 1;
    depth.push((sim[left] as number) + (sim[right] as number) - 2 * (sim[g] as number));
  }
  const inner = depth.slice(1);
  const mean = inner.reduce((sum, value) => sum + value, 0) / inner.length;
  const sd = Math.sqrt(inner.reduce((sum, value) => sum + (value - mean) ** 2, 0) / inner.length);
  const cutoff = Math.max(MIN_DEPTH, mean + DEPTH_SD * sd, RELATIVE_DEPTH * Math.max(...inner));

  const valleys: { g: number; at: number; depth: number }[] = [];
  for (let g = 1; g < sentences.length; g++) {
    const left = g > 1 ? (sim[g - 1] as number) : Infinity;
    const right = g < sentences.length - 1 ? (sim[g + 1] as number) : Infinity;
    if ((depth[g] as number) >= cutoff && (sim[g] as number) <= left && (sim[g] as number) <= right) valleys.push({ g, at: (sentences[g] as Sentence).s, depth: depth[g] as number });
  }
  valleys.sort((a, b) => b.depth - a.depth || a.at - b.at);

  const starts: number[] = [0];
  for (const valley of valleys) {
    if (starts.length >= maxChapters) break;
    if (valley.at < minMs || durationMs - valley.at < minMs) continue;
    if (starts.some((start) => Math.abs(start - valley.at) < minMs)) continue;
    starts.push(valley.at);
  }
  starts.sort((a, b) => a - b);
  return starts.map((start, index) => ({ s: start, e: starts[index + 1] ?? durationMs }));
}

// ---- titles ------------------------------------------------------------------------------------------------------------

export const FALLBACK_TITLE: Record<Lang, string> = { en: "Part", pl: "Część" };

export interface Keyword {
  /** How the word is written in the transcript (lower case, a capital when it is a name). */
  text: string;
  score: number;
}

/**
 * The words that characterise a stretch of the timeline against the whole transcript: term frequency in the stretch, weighted
 * by how rare the term is among all sentences and by how many different sentences of the stretch use it.
 */
function keywordsIn(sentences: Sentence[], range: { s: number; e: number }, lang: Lang, count: number): Keyword[] {
  const documentFrequency: Counts = new Map();
  for (const sentence of sentences) for (const term of new Set(termsOf(sentence.text, lang))) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const inside = sentences.filter((sentence) => sentence.s >= range.s && sentence.s < range.e);
  const frequency: Counts = new Map();
  const spread: Counts = new Map();
  const forms = new Map<string, Map<string, number>>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const sentence of inside) {
    const seen = new Set<string>();
    sentence.words.forEach((word, index) => {
      for (const token of tokenize(word.t)) {
        if (token.length < 3 || /^\p{N}+$/u.test(token) || STOP_WORDS.has(token)) continue;
        const term = stem(token, lang);
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
        seen.add(term);
        if (!firstSeen.has(term)) firstSeen.set(term, order++);
        // a capital inside a sentence marks a name; the first word of a sentence says nothing
        const proper = index > 0 && /^\p{Lu}/u.test(word.t.replace(/^[^\p{L}]+/u, "")) ? token.charAt(0).toUpperCase() + token.slice(1) : token;
        const byForm = forms.get(term) ?? new Map<string, number>();
        byForm.set(proper, (byForm.get(proper) ?? 0) + 1);
        forms.set(term, byForm);
      }
    });
    for (const term of seen) spread.set(term, (spread.get(term) ?? 0) + 1);
  }
  const total = Math.max(1, sentences.length);
  const scored = [...frequency].map(([term, tf]) => {
    const idf = Math.log(1 + total / (documentFrequency.get(term) ?? 1));
    const form = [...(forms.get(term) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? term;
    // longer words and names say more than short common ones
    const specific = (0.7 + 0.3 * Math.min(1, term.length / 6)) * (/^\p{Lu}/u.test(form) ? 1.3 : 1);
    const score = tf * idf * specific * (1 + 0.5 * ((spread.get(term) ?? 1) - 1));
    return { term, text: form, score };
  });
  scored.sort((a, b) => b.score - a.score || (firstSeen.get(a.term) as number) - (firstSeen.get(b.term) as number));
  return scored.slice(0, count).map(({ text, score }) => ({ text, score }));
}

/** The most characteristic words of the whole transcript, best first (used for titles and tags). */
export function topKeywords(words: TranscriptWord[], count: number, lang?: Lang): Keyword[] {
  const sentences = splitSentences(words);
  if (sentences.length === 0) return [];
  return keywordsIn(sentences, { s: -Infinity, e: Infinity }, lang ?? detectLanguage(words), count);
}

export interface TitleOptions {
  lang?: Lang;
  /** Zero-based position of the chapter; names the chapter "Part 3" when the stretch has no usable words. */
  index?: number;
  /** Words in the title. 3 */
  terms?: number;
}

function titleFrom(sentences: Sentence[], topic: { s: number; e: number }, lang: Lang, opts: TitleOptions): string {
  const picked = keywordsIn(sentences, topic, lang, opts.terms ?? 3);
  if (picked.length === 0) return `${FALLBACK_TITLE[lang]} ${(opts.index ?? 0) + 1}`;
  return trimTo(capitalize(picked.map((keyword) => keyword.text).join(", ")), TITLE_MAX_CHARS);
}

/** A keyword title for a topic: its top terms in the language of the transcript, for example "Satellite, phone, coverage". */
export function chapterTitles(topic: { s: number; e: number }, words: TranscriptWord[], opts: TitleOptions = {}): string {
  return titleFrom(splitSentences(words), topic, opts.lang ?? detectLanguage(words), opts);
}

// ---- YouTube's rules ----------------------------------------------------------------------------------------------------

const wholeSeconds = (ms: number): number => Math.floor(ms / 1000);

/** What is wrong with a chapter list; `chapter` is the 1-based number of the chapter the issue is about (for "not-ascending" and "too-close", the later one of the pair). */
export type ChapterIssue =
  | { code: "too-few"; count: number }
  | { code: "bad-start"; chapter: number }
  | { code: "no-title"; chapter: number }
  | { code: "first-not-zero" }
  | { code: "not-ascending"; chapter: number }
  | { code: "too-close"; chapter: number }
  | { code: "last-too-short" };

/** The English message of an issue, as `validateChapters` lists it in `errors`. */
export function describeChapterIssue(issue: ChapterIssue): string {
  switch (issue.code) {
    case "too-few":
      return `needs at least ${MIN_CHAPTERS} chapters, got ${issue.count}`;
    case "bad-start":
      return `chapter ${issue.chapter} has an invalid start`;
    case "no-title":
      return `chapter ${issue.chapter} has no title`;
    case "first-not-zero":
      return "the first chapter must start at 00:00";
    case "not-ascending":
      return `chapter ${issue.chapter} does not start after chapter ${issue.chapter - 1}`;
    case "too-close":
      return `chapters ${issue.chapter - 1} and ${issue.chapter} are less than 10 s apart`;
    case "last-too-short":
      return "the last chapter must be at least 10 s long";
  }
}

/**
 * YouTube turns a description into chapters only when: the first chapter is at 00:00, there are at least three, they ascend
 * and each is at least 10 s long (so the last one starts at least 10 s before the end). Times are judged in whole seconds,
 * as they are written. `errors` are the English messages of `issues`.
 */
export function validateChapters(chapters: Chapter[], durationMs: number): { ok: boolean; errors: string[]; issues: ChapterIssue[] } {
  const issues: ChapterIssue[] = [];
  if (chapters.length < MIN_CHAPTERS) issues.push({ code: "too-few", count: chapters.length });
  chapters.forEach((chapter, index) => {
    if (!Number.isFinite(chapter.startMs) || chapter.startMs < 0) issues.push({ code: "bad-start", chapter: index + 1 });
    if (chapter.title.trim() === "") issues.push({ code: "no-title", chapter: index + 1 });
  });
  const first = chapters[0];
  if (first && wholeSeconds(first.startMs) !== 0) issues.push({ code: "first-not-zero" });
  for (let i = 1; i < chapters.length; i++) {
    const previous = wholeSeconds((chapters[i - 1] as Chapter).startMs);
    const current = wholeSeconds((chapters[i] as Chapter).startMs);
    if (current <= previous) issues.push({ code: "not-ascending", chapter: i + 1 });
    else if ((current - previous) * 1000 < MIN_CHAPTER_GAP_MS) issues.push({ code: "too-close", chapter: i + 1 });
  }
  const last = chapters[chapters.length - 1];
  if (last && Number.isFinite(durationMs) && durationMs - wholeSeconds(last.startMs) * 1000 < MIN_CHAPTER_GAP_MS) issues.push({ code: "last-too-short" });
  return { ok: issues.length === 0, errors: issues.map(describeChapterIssue), issues };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `MM:SS`, or `H:MM:SS` from one hour on. */
export function chapterTime(ms: number): string {
  const total = Math.max(0, wholeSeconds(ms));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/** The chapter list as it goes into a video description: one `00:00 Title` line per chapter. */
export function formatChapters(chapters: Chapter[]): string {
  return chapters.map((chapter) => `${chapterTime(chapter.startMs)} ${chapter.title.replace(/\s+/g, " ").trim() || "Chapter"}`).join("\n");
}

/** The words as they sit on the edited timeline: words in a removed range are dropped, the others are mapped through the cuts. */
export function wordsThroughEdl(words: TranscriptWord[], edl: Edl): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const word of words) {
    if (findRemoved(edl, (word.s + word.e) / 2) !== null) continue;
    out.push({ ...word, s: toOutput(edl, word.s), e: toOutput(edl, word.e) });
  }
  return out;
}

/**
 * A chapter list for the edited video that is guaranteed to pass `validateChapters` (when the video is at least 30 s long;
 * a shorter one cannot hold three chapters of 10 s and gets an empty list). The words go through the EDL first, so cut
 * material does not shape the chapters and every time is on the output timeline. Topics come from `segmentTopics` with a
 * minimum length of at least 10 s; chapters that still end up too close (or too near the end) are merged into the earlier
 * one; fewer than three are padded by splitting the longest stretch into equal parts (the padding chapters are titled from their own
 * words); when even that cannot work, the video is cut into three equal parts. Starts are whole seconds.
 */
export function chaptersForYoutube(words: TranscriptWord[], durationMs: number, edl?: Edl, opts: SegmentOptions = {}): Chapter[] {
  const outputMs = edl ? keptDuration(edl, durationMs) : durationMs;
  if (!(outputMs >= MIN_CHAPTERS * MIN_CHAPTER_GAP_MS)) return [];
  const mapped = edl ? wordsThroughEdl(words, edl) : words;
  const lang = opts.lang ?? detectLanguage(words);
  const sentences = splitSentences(mapped);
  const topics = segmentTopics(mapped, outputMs, { ...opts, lang, minChapterMs: Math.max(opts.minChapterMs ?? 60_000, MIN_CHAPTER_GAP_MS) });
  const endSec = wholeSeconds(outputMs);
  const limitSec = endSec - MIN_CHAPTER_GAP_MS / 1000;

  const starts: number[] = [];
  for (const topic of topics) {
    const sec = starts.length === 0 ? 0 : wholeSeconds(topic.s);
    const previous = starts[starts.length - 1];
    if (previous !== undefined && (sec - previous < 10 || sec > limitSec)) continue;
    starts.push(sec);
  }

  // pad up to three chapters: split the longest stretch into equal parts, as long as each part stays at least 10 s
  if (starts.length < MIN_CHAPTERS) {
    const need = MIN_CHAPTERS - starts.length;
    let at = 0;
    let longest = 0;
    starts.forEach((start, index) => {
      const length = (starts[index + 1] ?? endSec) - start;
      if (length > longest) {
        longest = length;
        at = index;
      }
    });
    if (Math.floor(longest / (need + 1)) >= MIN_CHAPTER_GAP_MS / 1000) {
      const from = starts[at] as number;
      starts.splice(at + 1, 0, ...Array.from({ length: need }, (_, k) => from + Math.floor(((k + 1) * longest) / (need + 1))));
    } else {
      starts.length = 0;
      for (let k = 0; k < MIN_CHAPTERS; k++) starts.push(Math.floor((k * endSec) / MIN_CHAPTERS));
    }
  }

  return starts.map((sec, index) => {
    const topic = { s: sec * 1000, e: (starts[index + 1] ?? endSec) * 1000 };
    return { startMs: sec * 1000, title: titleFrom(sentences, topic, lang, { index }) };
  });
}
