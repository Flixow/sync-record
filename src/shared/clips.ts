// Clip suggestions: short stretches of a recording that work on their own (a question and its answer, a lively exchange,
// a moment somebody flagged). Pure, deterministic and heuristic: no model is needed. This is the path that runs when no model
// is configured or the shorts agent fails (src/shared/shorts.ts, src/server/post/shorts-agent.ts, which lets a model cut the
// clips and validates what it says). Every clip starts on the first word of a sentence and ends on the last word of one.

import { keepOnly, type Edl } from "./edl.js";
import { isBackchannel, ABBREVIATION_SOFT, ABBREVIATION_TITLES, capitalize, detectLanguage, joinWords, startsWithConnective, trimTo, type Lang } from "./lexicon.js";
import { meanLevelDb, sentenceEnd, wordKey, type TranscriptWord } from "./transcript.js";

export const DEFAULT_MIN_CLIP_MS = 20_000;
export const DEFAULT_MAX_CLIP_MS = 90_000;
export const DEFAULT_CLIP_LIMIT = 10;
/** Two words of one speaker further apart than this are in different sentences. */
export const SENTENCE_GAP_MS = 1200;
/** A sentence longer than this (an engine that wrote no punctuation) is cut at its longest pause. */
const RUN_ON_MS = 25_000;
const TITLE_MAX_CHARS = 70;
/** An inner pause counts against a clip from this length on. */
const PAUSE_FREE_MS = 2500;
/** A pause this long between two sentences ends the clip candidates that would reach across it. */
const PAUSE_BREAK_MS = 10_000;
const QUESTION_ANSWER_MS = 6000;
const MARKER_NEAR_MS = 3000;
const MIN_ADJUST_MS = 1000;

// ---- words and sentences -----------------------------------------------------------------------------------------------

/** The longest a word of this length plausibly lasts; engines stretch the first word after a silence back over it (the same rule the captions use). */
const wordCapMs = (text: string): number => 450 + 110 * [...text].length;

/**
 * The words in time order with blank and non-finite ones dropped and stretched timestamps repaired: a word longer than it
 * can plausibly be keeps the end that touches the next word of its speaker and loses the stretched start (or the other way
 * round when it is the start that touches the word before). Every other time is returned untouched.
 */
export function normalizeWords(words: TranscriptWord[]): TranscriptWord[] {
  const cleaned = words
    .filter((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.t.trim() !== "")
    .map((word) => ({ ...word, t: word.t.trim() }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const previousOf = new Map<string, TranscriptWord>();
  const adjusted = cleaned.map((word) => ({ ...word }));
  const rawNext = new Map<TranscriptWord, TranscriptWord>();
  for (const word of cleaned) {
    const previous = previousOf.get(word.pid);
    if (previous) rawNext.set(previous, word);
    previousOf.set(word.pid, word);
  }
  const rawPrevious = new Map<TranscriptWord, TranscriptWord>();
  for (const [previous, next] of rawNext) rawPrevious.set(next, previous);
  cleaned.forEach((word, index) => {
    const cap = wordCapMs(word.t);
    if (word.e - word.s <= cap) return;
    const next = rawNext.get(word);
    const previous = rawPrevious.get(word);
    const touchesNext = next !== undefined && next.s - word.e < 200;
    const touchesPrevious = previous !== undefined && word.s - previous.e < 200;
    const target = adjusted[index] as TranscriptWord;
    if (touchesPrevious && !touchesNext) target.e = word.s + cap;
    else target.s = word.e - cap;
  });
  return adjusted.sort((a, b) => a.s - b.s || a.e - b.e);
}

export interface Sentence {
  /** First word's start and last word's end, in ms on the project timeline. */
  s: number;
  e: number;
  pid: string;
  words: TranscriptWord[];
  text: string;
  /** Ends with . ? ! … (not cut by a pause or a speaker change). */
  terminal: boolean;
  question: boolean;
}

const CLOSERS = /["')\]»”’]+$/u;
const CAPITAL_START = /^["'([«„“]*\p{Lu}/u;

/**
 * Whether a word with a full stop at its end really closes the sentence, given the word that follows it from the same speaker.
 * An abbreviation, an initial, a dotted acronym, an ordinal ("15.") or a decimal piece closes it only when a capital follows
 * after a real pause; any other word closes it.
 */
function stopEndsSentence(word: TranscriptWord, next: TranscriptWord | undefined, gapMs: number): boolean {
  const text = word.t.replace(CLOSERS, "");
  if (/\.\.+$|…$/u.test(text)) return true;
  const body = text.replace(/\.$/, "");
  const key = wordKey(body);
  if (ABBREVIATION_TITLES.has(key)) return next === undefined;
  if (next === undefined || next.s - word.e > gapMs) return true;
  const abbreviation = ABBREVIATION_SOFT.has(key) || /^\p{Lu}$/u.test(body) || /^(\p{L}\.)+\p{L}$/u.test(body) || /^\d+$/.test(key);
  if (!abbreviation) return true;
  return CAPITAL_START.test(next.t) && next.s - word.e >= 300;
}

/** Whether `word` ends a sentence: terminal punctuation that is not part of an abbreviation, ordinal or decimal. */
function endsSentence(word: TranscriptWord, next: TranscriptWord | undefined, gapMs: number): boolean {
  if (!sentenceEnd(word.t)) return false;
  if (/[!?…]["')\]»”’]*$/u.test(word.t)) return true;
  return stopEndsSentence(word, next, gapMs);
}

function makeSentence(words: TranscriptWord[], terminal: boolean): Sentence {
  const first = words[0] as TranscriptWord;
  const last = words[words.length - 1] as TranscriptWord;
  return {
    s: first.s,
    e: Math.max(...words.map((word) => word.e)),
    pid: first.pid,
    words,
    text: joinWords(words),
    terminal,
    question: terminal && /\?["')\]»”’]*$/u.test(last.t),
  };
}

/** Cuts a run-on sentence at its longest pause in the middle half; the pieces are not terminal. Leaves it whole when no pause is there. */
function cutRunOn(words: TranscriptWord[]): TranscriptWord[][] {
  const first = words[0] as TranscriptWord;
  const last = words[words.length - 1] as TranscriptWord;
  if (last.e - first.s <= RUN_ON_MS || words.length < 4) return [words];
  const from = first.s + (last.e - first.s) * 0.25;
  const to = first.s + (last.e - first.s) * 0.75;
  let best = -1;
  let bestGap = 99;
  for (let i = 1; i < words.length; i++) {
    const before = words[i - 1] as TranscriptWord;
    const after = words[i] as TranscriptWord;
    const gap = after.s - before.e;
    if (after.s < from || after.s > to || gap <= bestGap) continue;
    best = i;
    bestGap = gap;
  }
  if (best < 0) return [words];
  return [...cutRunOn(words.slice(0, best)), ...cutRunOn(words.slice(best))];
}

/**
 * Sentences of a transcript, in order of their start. Each speaker's words form their own stream (a backchannel from the
 * other speaker in the middle does not break a sentence) and a sentence ends at . ? ! … (unless it is an abbreviation such as
 * "Dr." or "np.", an initial, an ordinal such as "15." or a decimal piece), at a pause longer than 1.2 s, or at the speaker's
 * last word. Runs longer than 25 s without punctuation are cut at their longest pause. Works the same for English and Polish.
 */
export function splitSentences(words: TranscriptWord[], gapMs = SENTENCE_GAP_MS): Sentence[] {
  const streams = new Map<string, TranscriptWord[]>();
  for (const word of normalizeWords(words)) {
    const stream = streams.get(word.pid);
    if (stream) stream.push(word);
    else streams.set(word.pid, [word]);
  }
  const sentences: Sentence[] = [];
  for (const stream of streams.values()) {
    let current: TranscriptWord[] = [];
    const flush = (terminal: boolean): void => {
      if (current.length === 0) return;
      const pieces = cutRunOn(current);
      pieces.forEach((piece, index) => sentences.push(makeSentence(piece, terminal && index === pieces.length - 1)));
      current = [];
    };
    stream.forEach((word, index) => {
      const previous = current[current.length - 1];
      if (previous && word.s - previous.e > gapMs) flush(false);
      current.push(word);
      if (endsSentence(word, stream[index + 1], gapMs)) flush(true);
    });
    flush(false);
  }
  return sentences.sort((a, b) => a.s - b.s || a.e - b.e || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
}

/** The words of a clip, in order. */
export function clipWords(words: TranscriptWord[], clip: { s: number; e: number }): TranscriptWord[] {
  return normalizeWords(words).filter((word) => word.s >= clip.s && word.s < clip.e);
}

/** The text of a clip, one line per speaker turn ("Anna: …"); `nameOf` turns a participant id into a name. */
export function clipText(words: TranscriptWord[], clip: { s: number; e: number }, nameOf: (pid: string) => string = (pid) => pid): string {
  const lines: string[] = [];
  let turn: TranscriptWord[] = [];
  const flush = (): void => {
    const first = turn[0];
    if (first) lines.push(`${nameOf(first.pid)}: ${joinWords(turn)}`);
    turn = [];
  };
  for (const word of clipWords(words, clip)) {
    if (turn.length > 0 && (turn[0] as TranscriptWord).pid !== word.pid) flush();
    turn.push(word);
  }
  flush();
  return lines.join("\n");
}

// ---- reasons ------------------------------------------------------------------------------------------------------------

/** Human sentences for the reason keys of a suggestion, in both interface languages. */
export const REASON_TEXT: Record<string, { en: string; pl: string }> = {
  marker: { en: "Someone flagged this moment while recording.", pl: "Ktoś oznaczył ten moment podczas nagrania." },
  "question-answer": { en: "A question is answered right away.", pl: "Pytanie i od razu odpowiedź." },
  "high-energy": { en: "Louder and livelier than the rest of the recording.", pl: "Głośniej i żywiej niż reszta nagrania." },
  "fast-pace": { en: "A quick, lively pace of speech.", pl: "Szybkie, żywe tempo mówienia." },
  "back-and-forth": { en: "The speakers take turns in quick succession.", pl: "Rozmówcy szybko się zmieniają." },
  "dense-speech": { en: "Almost no pauses.", pl: "Prawie bez przerw." },
  "complete-thought": { en: "Starts and ends on a complete thought.", pl: "Zaczyna się i kończy pełną myślą." },
  "good-length": { en: "A good length for a short clip.", pl: "Dobra długość na krótki klip." },
  agent: { en: "Cut by the language model: a strong opening and a story that stands on its own.", pl: "Wycięte przez model językowy: mocne otwarcie i zamknięta historia." },
};

export interface ClipSuggestion {
  id: string;
  /** First word's start and last word's end on the project timeline, in ms; both lie on sentence boundaries. */
  s: number;
  e: number;
  /** Relative: higher is better, comparable only within one run (a marker adds 0.5). */
  score: number;
  /** Keys of REASON_TEXT, the strongest first; never empty. */
  reasons: string[];
  /** The first strong sentence, at most 70 characters. */
  title: string;
  /** Participant ids in order of their first word. */
  speakers: string[];
  /** Set when the language model cut this clip (src/shared/shorts.ts): its title is the model's and is kept when the in or out point moves. */
  source?: "agent";
  /** What the viewer hears first, in the model's words (agent clips only), at most 120 characters. */
  hook?: string;
  /** One sentence from the model on why this stretch works as a short (agent clips only), at most 200 characters. */
  why?: string;
}

/** A clip as its own project: it has an EDL of its own (keep only the clip range) and is exported on its own. */
export interface ClipProject {
  id: string;
  /** The session (project) the clip was cut from. */
  parentSid: string;
  s: number;
  e: number;
  preset: string;
  name: string;
}

/** The EDL of a clip: everything outside the clip range is removed. */
export function clipToEdl(clip: { s: number; e: number }, durationMs: number): Edl {
  return keepOnly([{ s: clip.s, e: clip.e }], durationMs);
}

// ---- scoring ------------------------------------------------------------------------------------------------------------

export interface SuggestInput {
  words: TranscriptWord[];
  /** The level track (20 ms frames, dBFS) of each speaker; without it energy is left out of the score. */
  levels?: { pid: string; levels: Int8Array }[];
  /** Moments flagged while recording. */
  highlights?: { tMs: number }[];
  durationMs: number;
  /** 20000 */
  minMs?: number;
  /** 90000 */
  maxMs?: number;
  /** 10 */
  limit?: number;
}

export interface SuggestOptions {
  /** Language of the transcript; detected from the words when absent. */
  lang?: Lang;
  /** Largest share of the shorter clip two suggestions may share. 0.2 */
  maxOverlap?: number;
}

const WEIGHTS = { qa: 0.3, energy: 0.2, pace: 0.15, complete: 0.2, length: 0.15 } as const;
const MARKER_BONUS = 0.5;
const MARKER_NEAR_BONUS = 0.2;
/** A clip edge that cuts through a sentence of someone else (crosstalk), by more than this. */
const STRADDLE_MS = 300;
const STRADDLE_PENALTY = 0.1;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** First sentence that says something: at least four words, not a reaction, not a continuation. */
function strongSentence(sentences: Sentence[], lang: Lang): Sentence | undefined {
  const sayings = sentences.filter((sentence) => sentence.words.length >= 4 && !isBackchannel(sentence.words));
  return sayings.find((sentence) => !startsWithConnective((sentence.words[0] as TranscriptWord).t, lang)) ?? sayings[0] ?? sentences[0];
}

function titleOf(sentences: Sentence[], lang: Lang): string {
  const sentence = strongSentence(sentences, lang);
  if (!sentence) return "";
  return trimTo(capitalize(sentence.text.replace(/[\s,;:.]+$/u, "").replace(/^[\s,;:.\-–—]+/u, "")), TITLE_MAX_CHARS);
}

const speakersOf = (sentences: Sentence[]): string[] => [...new Set(sentences.map((sentence) => sentence.pid))];

interface Candidate {
  i: number;
  j: number;
  s: number;
  e: number;
  score: number;
  reasons: string[];
}

interface Raw {
  i: number;
  j: number;
  s: number;
  e: number;
  words: number;
  speechMs: number;
  qa: number;
  turns: number;
  backchannels: number;
  sentences: number;
  longPauseMs: number;
  energyDb: number | null;
  rateMean: number;
  rateCv: number;
  marker: 0 | 1 | 2;
  /** Number of clip edges (0-2) that cut through a sentence of another speaker. */
  straddles: number;
}

/**
 * Clips of 20-90 s that start on a sentence start and end on a sentence end, best first. A window is scored on
 *  - a question followed by a reply from another speaker (the strongest content signal),
 *  - energy: its mean level against the median sentence level of the recording (only with `levels`),
 *  - pace: words per second of speech against the recording's median, near it or a little above, with some variety,
 *  - completeness: does not start with a connective ("and", "but", "ale", "więc"), ends on terminal punctuation,
 *  - length: closest to 45 s,
 *  - a flagged moment inside the window (+0.5; within 3 s of an edge +0.2),
 * and loses points for long pauses inside and for being mostly one-word reactions. The best are picked greedily; two picks
 * share at most 20 % of the shorter one. Deterministic: ties go to the earlier, then the shorter window.
 */
export function suggestClips(input: SuggestInput, opts: SuggestOptions = {}): ClipSuggestion[] {
  const minMs = input.minMs ?? DEFAULT_MIN_CLIP_MS;
  const maxMs = input.maxMs ?? DEFAULT_MAX_CLIP_MS;
  const limit = input.limit ?? DEFAULT_CLIP_LIMIT;
  const maxOverlap = opts.maxOverlap ?? 0.2;
  if (limit <= 0 || maxMs < minMs) return [];
  const sentences = splitSentences(input.words);
  if (sentences.length === 0) return [];
  const lang = opts.lang ?? detectLanguage(input.words);
  const n = sentences.length;

  const trackOf = new Map((input.levels ?? []).map((entry) => [entry.pid, entry.levels]));
  const sentenceDb: (number | null)[] = sentences.map((sentence) => {
    const track = trackOf.get(sentence.pid);
    return track ? meanLevelDb(track, sentence.s, sentence.e) : null;
  });
  const known = sentenceDb.filter((db): db is number => db !== null && db > -90);
  const medianDb = known.length > 0 ? median(known) : null;
  const rateOf = (sentence: Sentence): number => sentence.words.length / Math.max(0.4, (sentence.e - sentence.s) / 1000);
  const rates = sentences.map(rateOf);
  const medianRate = median(sentences.map((sentence, index) => (sentence.words.length >= 4 ? (rates[index] as number) : NaN)).filter((rate) => !Number.isNaN(rate))) || median(rates);

  const backchannel = sentences.map((sentence) => isBackchannel(sentence.words));
  const connective = sentences.map((sentence) => startsWithConnective((sentence.words[0] as TranscriptWord).t, lang));
  // answeredBy[m] = index of the question sentence that sentence m answers, or -1
  const answers = new Array<number>(n).fill(-1);
  for (let q = 0; q < n; q++) {
    if (!(sentences[q] as Sentence).question) continue;
    const question = sentences[q] as Sentence;
    for (let m = q + 1; m < n && m <= q + 4; m++) {
      const reply = sentences[m] as Sentence;
      if (reply.s - question.e > QUESTION_ANSWER_MS) break;
      if (reply.pid === question.pid) continue;
      // the first thing another speaker says decides: a real reply answers, a reaction does not
      if (reply.words.length >= 3 && !backchannel[m] && answers[m] === -1) answers[m] = q;
      break;
    }
  }
  const markers = [...(input.highlights ?? [])].map((highlight) => highlight.tMs).filter(Number.isFinite).sort((a, b) => a - b);
  const markerState = (s: number, e: number): 0 | 1 | 2 => {
    // 2: a marker inside the window, 1: one within 3 s of an edge
    let low = 0;
    let high = markers.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((markers[mid] as number) < s - MARKER_NEAR_MS) low = mid + 1;
      else high = mid;
    }
    let state: 0 | 1 | 2 = 0;
    for (let k = low; k < markers.length && (markers[k] as number) <= e + MARKER_NEAR_MS; k++) {
      const at = markers[k] as number;
      if (at >= s && at <= e) return 2;
      state = 1;
    }
    return state;
  };

  // the latest end among the sentences before each sentence: a start that lies before it cuts through one of them
  const endBefore: number[] = [];
  let latestEnd = -Infinity;
  for (const sentence of sentences) {
    endBefore.push(latestEnd);
    latestEnd = Math.max(latestEnd, sentence.e);
  }

  const raws: Raw[] = [];
  for (let i = 0; i < n; i++) {
    const first = sentences[i] as Sentence;
    let end = first.e;
    let covered = 0;
    let coveredTo = first.s;
    let words = 0;
    let qa = 0;
    let turns = 0;
    let backchannels = 0;
    let longPause = 0;
    let dbWeighted = 0;
    let dbMs = 0;
    let rateSum = 0;
    let rateSquares = 0;
    for (let j = i; j < n; j++) {
      const sentence = sentences[j] as Sentence;
      if (j > i) {
        const gap = sentence.s - end;
        if (gap > PAUSE_BREAK_MS) break;
        if (gap > PAUSE_FREE_MS) longPause += gap - PAUSE_FREE_MS;
        if (sentence.pid !== (sentences[j - 1] as Sentence).pid) turns += 1;
      }
      end = Math.max(end, sentence.e);
      if (end - first.s > maxMs) break;
      covered += Math.max(0, sentence.e - Math.max(sentence.s, coveredTo));
      coveredTo = Math.max(coveredTo, sentence.e);
      words += sentence.words.length;
      if ((answers[j] as number) >= i) qa += 1;
      if (backchannel[j]) backchannels += 1;
      const db = sentenceDb[j];
      const duration = Math.max(1, sentence.e - sentence.s);
      if (db !== null && db !== undefined && db > -90) {
        dbWeighted += db * duration;
        dbMs += duration;
      }
      const rate = rates[j] as number;
      rateSum += rate;
      rateSquares += rate * rate;
      const count = j - i + 1;
      if (end - first.s < minMs) continue;
      const rateMean = rateSum / count;
      const variance = Math.max(0, rateSquares / count - rateMean * rateMean);
      raws.push({
        i,
        j,
        s: first.s,
        e: end,
        words,
        speechMs: covered,
        qa,
        turns,
        backchannels,
        sentences: count,
        longPauseMs: longPause,
        energyDb: dbMs > 0 ? dbWeighted / dbMs : null,
        rateMean,
        rateCv: rateMean > 0 ? Math.sqrt(variance) / rateMean : 0,
        marker: markerState(first.s, end),
        straddles: Number((endBefore[i] as number) > first.s + STRADDLE_MS) + Number((sentences[j + 1]?.s ?? Infinity) < end - STRADDLE_MS),
      });
    }
  }
  if (raws.length === 0) return [];

  const deltas = raws.map((raw) => (raw.energyDb !== null && medianDb !== null ? raw.energyDb - medianDb : null)).filter((delta): delta is number => delta !== null && delta > 0);
  const energyScale = Math.max(3, percentile(deltas, 0.9));
  const useEnergy = medianDb !== null;
  const weightSum = WEIGHTS.qa + WEIGHTS.pace + WEIGHTS.complete + WEIGHTS.length + (useEnergy ? WEIGHTS.energy : 0);

  const candidates: Candidate[] = raws.map((raw) => {
    const length = raw.e - raw.s;
    const lengthScore = clamp01(1 - Math.abs(Math.log(length / 45_000)) / Math.LN2);
    const qaScore = clamp01(raw.qa / 2);
    const energy = raw.energyDb !== null && medianDb !== null ? clamp01((raw.energyDb - medianDb) / energyScale) : 0;
    const speechSeconds = Math.max(0.5, raw.speechMs / 1000);
    const paceRatio = medianRate > 0 ? raw.words / speechSeconds / medianRate : 1;
    const paceScore = 0.7 * Math.exp(-(((paceRatio - 1.1) / 0.3) ** 2)) + 0.3 * clamp01(raw.rateCv / 0.35);
    const last = sentences[raw.j] as Sentence;
    const startOk = !connective[raw.i];
    const hangingQuestion = last.question && raw.qa === 0 ? 1 : 0;
    const endOk = last.terminal && !hangingQuestion;
    const completeScore = (startOk ? 0.5 : 0) + (last.terminal ? (hangingQuestion ? 0.2 : 0.5) : 0);
    const quality = (WEIGHTS.qa * qaScore + (useEnergy ? WEIGHTS.energy * energy : 0) + WEIGHTS.pace * paceScore + WEIGHTS.complete * completeScore + WEIGHTS.length * lengthScore) / weightSum;
    const pausePenalty = Math.min(0.35, (raw.longPauseMs / length) * 1.2);
    const backShare = raw.backchannels / raw.sentences;
    const backPenalty = backShare > 0.4 ? Math.min(0.5, 0.15 + (backShare - 0.4) * 1.5) : 0;
    const markerBonus = raw.marker === 2 ? MARKER_BONUS : raw.marker === 1 ? MARKER_NEAR_BONUS : 0;
    const score = quality + markerBonus - pausePenalty - backPenalty - STRADDLE_PENALTY * raw.straddles;

    const reasons: string[] = [];
    if (raw.marker === 2) reasons.push("marker");
    if (raw.qa > 0) reasons.push("question-answer");
    if (useEnergy && raw.energyDb !== null && medianDb !== null && raw.energyDb - medianDb >= 1.5 && energy >= 0.5) reasons.push("high-energy");
    if (paceRatio >= 1.12 && paceRatio <= 1.6) reasons.push("fast-pace");
    if (raw.turns >= 3 && raw.sentences >= 4) reasons.push("back-and-forth");
    if (raw.longPauseMs === 0 && raw.speechMs / length >= 0.85) reasons.push("dense-speech");
    if (startOk && endOk) reasons.push("complete-thought");
    if (lengthScore >= 0.6) reasons.push("good-length");
    if (reasons.length === 0) reasons.push(startOk || endOk ? "complete-thought" : "good-length");
    return { i: raw.i, j: raw.j, s: raw.s, e: raw.e, score, reasons };
  });

  candidates.sort((a, b) => b.score - a.score || a.s - b.s || a.e - b.e);
  const chosen: Candidate[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    const clash = chosen.some((picked) => {
      const overlap = Math.min(picked.e, candidate.e) - Math.max(picked.s, candidate.s);
      return overlap > 0 && overlap > maxOverlap * Math.min(picked.e - picked.s, candidate.e - candidate.s);
    });
    if (!clash) chosen.push(candidate);
  }

  return chosen.map((candidate) => {
    const inside = sentences.slice(candidate.i, candidate.j + 1);
    return {
      id: `clip-${candidate.s}-${candidate.e}`,
      s: Math.round(candidate.s),
      e: Math.round(candidate.e),
      score: Number(candidate.score.toFixed(3)),
      reasons: candidate.reasons,
      title: titleOf(inside, lang),
      speakers: speakersOf(inside),
    };
  });
}

// ---- in and out points -------------------------------------------------------------------------------------------------

/**
 * The sentence boundary nearest to `ms`: "start" snaps to the start of a sentence (for an in point), "end" to the end of one
 * (for an out point). Ties go to the earlier boundary for "start" and the later one for "end". Unchanged without sentences.
 */
export function snapToSentence(words: TranscriptWord[], ms: number, direction: "start" | "end"): number {
  const sentences = splitSentences(words);
  return nearest(sentences.map((sentence) => (direction === "start" ? sentence.s : sentence.e)), ms, direction);
}

/** The start (direction "start") or end ("end") of the word nearest to `ms`. Unchanged without words. */
export function snapToWord(words: TranscriptWord[], ms: number, direction: "start" | "end"): number {
  return nearest(normalizeWords(words).map((word) => (direction === "start" ? word.s : word.e)), ms, direction);
}

function nearest(values: number[], ms: number, direction: "start" | "end"): number {
  let best: number | null = null;
  for (const value of values) {
    if (best === null) best = value;
    else {
      const distance = Math.abs(value - ms);
      const bestDistance = Math.abs(best - ms);
      if (distance < bestDistance || (distance === bestDistance && (direction === "end" ? value > best : value < best))) best = value;
    }
  }
  return best ?? ms;
}

/**
 * A clip's range moved to new in and/or out points, each snapped to the nearest word boundary (start of a word for the in
 * point, end of a word for the out point). The clip keeps at least one second; when the new points would cross, the one that
 * was not moved stays and the moved one stops one second short of it.
 */
export function adjustRange(range: { s: number; e: number }, words: TranscriptWord[], change: { sMs?: number; eMs?: number }): { s: number; e: number } {
  const clean = normalizeWords(words);
  if (clean.length === 0) return { s: range.s, e: range.e };
  const starts = clean.map((word) => word.s);
  const ends = clean.map((word) => word.e);
  let s = change.sMs === undefined ? range.s : nearest(starts, change.sMs, "start");
  let e = change.eMs === undefined ? range.e : nearest(ends, change.eMs, "end");
  if (e - s < MIN_ADJUST_MS) {
    if (change.sMs !== undefined && change.eMs === undefined) s = Math.max(starts[0] as number, ...starts.filter((start) => start <= e - MIN_ADJUST_MS));
    else e = Math.min(ends[ends.length - 1] as number, ...ends.filter((end) => end >= s + MIN_ADJUST_MS));
  }
  return e > s ? { s, e } : { s: range.s, e: range.e };
}

/**
 * The in point ("s") or out point ("e") of a range moved by `steps` words (negative: earlier), as a change for adjustRange
 * and adjustClip. Stops at the first and the last word of the transcript.
 */
export function wordStep(range: { s: number; e: number }, words: TranscriptWord[], edge: "s" | "e", steps: number): { sMs: number } | { eMs: number } {
  const values = [...new Set(normalizeWords(words).map((word) => (edge === "s" ? word.s : word.e)))].sort((a, b) => a - b);
  const at = values.indexOf(nearest(values, range[edge], edge === "s" ? "start" : "end"));
  const to = at < 0 ? range[edge] : (values[Math.min(values.length - 1, Math.max(0, at + steps))] as number);
  return edge === "s" ? { sMs: to } : { eMs: to };
}

/** A suggestion with new in and out points (see adjustRange); its title (unless the model wrote it) and speakers follow the new range, its score and reasons stay. */
export function adjustClip(clip: ClipSuggestion, words: TranscriptWord[], change: { sMs?: number; eMs?: number }): ClipSuggestion {
  const range = adjustRange(clip, words, change);
  const sentences = splitSentences(words).filter((sentence) => sentence.s >= range.s && sentence.e <= range.e);
  const lang = detectLanguage(words);
  const title = clip.source === "agent" ? clip.title : sentences.length > 0 ? titleOf(sentences, lang) : trimTo(capitalize(joinWords(clipWords(words, range))), TITLE_MAX_CHARS);
  const speakers = sentences.length > 0 ? speakersOf(sentences) : [...new Set(clipWords(words, range).map((word) => word.pid))];
  return { ...clip, id: `clip-${range.s}-${range.e}`, s: range.s, e: range.e, title, speakers };
}
