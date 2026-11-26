// Burned-in captions: breaking transcript words into caption events, the ASS file libass renders from them, the boxes
// they occupy, the sidecar files and the ffmpeg filter. Pure functions over plain values.
//
// Timing: events run on the output timeline. Words keep their own start and end; the only repairs are the ones real engine
// output needs (a word stretched over a silence, overlapping or equal starts, hyphen pieces split from their word).
// Geometry: captions sit inside safeArea(canvas). Sizes are in pixels at a 1080 px short edge and scale with the canvas.
// Font: the bundled Noto Sans (assets/fonts), the only face the ASS file names; the width table below is read from it.

import { findRemoved, normalize, toOutput, type Range } from "./edl.js";
import { safeArea, type Canvas, type Rect } from "./safe-area.js";
import { buildCues, sentenceEnd, toSrt, toVtt, type Cue, type TranscriptWord } from "./transcript.js";

export type CaptionAspect = "16:9" | "9:16" | "1:1";

export interface CaptionStyle {
  id: string;
  label: string;
  fontName: string;
  /** Em size in px at a 1080 px short edge; scaled by the canvas. */
  fontSize: number;
  bold: boolean;
  /** CSS hex colours (#RRGGBB). */
  primary: string;
  highlight: string;
  outline: string;
  /** Outline and shadow in px at a 1080 px short edge. */
  outlineWidth: number;
  shadow: number;
  /** An opaque box behind the text: colour, opacity (0..1) and padding in px at a 1080 px short edge. */
  box?: { color: string; alpha: number; padding: number };
  uppercase: boolean;
  /** Where the block sits inside the safe area. */
  position: "bottom" | "center" | "top";
  maxLines: number;
  maxCharsPerLine: Record<CaptionAspect, number>;
  /** none: plain text. word: the word being spoken is coloured while it is spoken. karaoke: words fill with the highlight colour as they are spoken and stay filled. */
  highlightMode: "none" | "word" | "karaoke";
}

export interface CaptionWord {
  text: string;
  /** ms on the timeline the captions are for (the output timeline when an EDL was given). */
  s: number;
  e: number;
}

/** One caption event: up to maxLines lines shown from s to e. */
export interface CaptionLine {
  s: number;
  e: number;
  words: CaptionWord[];
  /** The words of each line, joined by single spaces; a word is never split across lines. */
  lines: string[];
  /** The speaker of every word of the event; set when layoutCaptions was asked to keep speakers apart. */
  pid?: string;
}

export interface LayoutOptions {
  /** Removed ranges of the EDL (project timeline, ms): words inside them are dropped, the others move to the output timeline. */
  removed?: Range[];
  /** One speaker per event. */
  speakers?: boolean;
}

/** The fonts the ASS file asks for; fontsdir must hold them. */
export const CAPTION_FONT_FILES = ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"] as const;

/** Shortest time an event stays on screen, unless the next event starts sooner. */
export const MIN_CAPTION_MS = 400;

const FONT = "Noto Sans";

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: "clean",
    label: "Clean",
    fontName: FONT,
    fontSize: 52,
    bold: true,
    primary: "#FFFFFF",
    highlight: "#FFFFFF",
    outline: "#000000",
    outlineWidth: 3.5,
    shadow: 1.5,
    uppercase: false,
    position: "bottom",
    maxLines: 2,
    maxCharsPerLine: { "16:9": 42, "9:16": 24, "1:1": 28 },
    highlightMode: "none",
  },
  {
    id: "bold-box",
    label: "Bold box",
    fontName: FONT,
    fontSize: 56,
    bold: true,
    primary: "#FFFFFF",
    highlight: "#FFD23F",
    outline: "#000000",
    outlineWidth: 0,
    shadow: 0,
    box: { color: "#000000", alpha: 0.72, padding: 12 },
    uppercase: false,
    position: "bottom",
    maxLines: 2,
    maxCharsPerLine: { "16:9": 38, "9:16": 22, "1:1": 25 },
    highlightMode: "word",
  },
  {
    id: "karaoke-pop",
    label: "Karaoke pop",
    fontName: FONT,
    fontSize: 70,
    bold: true,
    primary: "#FFFFFF",
    highlight: "#FFE14D",
    outline: "#101010",
    outlineWidth: 6,
    shadow: 3,
    uppercase: true,
    position: "center",
    maxLines: 2,
    maxCharsPerLine: { "16:9": 28, "9:16": 15, "1:1": 17 },
    highlightMode: "karaoke",
  },
  {
    id: "minimal",
    label: "Minimal",
    fontName: FONT,
    fontSize: 44,
    bold: false,
    primary: "#F4F4F4",
    highlight: "#F4F4F4",
    outline: "#000000",
    outlineWidth: 2,
    shadow: 0.8,
    uppercase: false,
    position: "bottom",
    maxLines: 2,
    maxCharsPerLine: { "16:9": 48, "9:16": 28, "1:1": 32 },
    highlightMode: "none",
  },
];

export function captionStyleById(id: string): CaptionStyle | null {
  return CAPTION_STYLES.find((style) => style.id === id) ?? null;
}

export function aspectOf(canvas: Canvas): CaptionAspect {
  const ratio = canvas.width / canvas.height;
  if (ratio > 1.2) return "16:9";
  if (ratio < 0.8) return "9:16";
  return "1:1";
}

// ---- text width -------------------------------------------------------------------------------------------------------

type Run = [start: number, widths: number[]];

// Advance widths in font units (1000 per em) of the bundled Noto Sans, by code point run. Generated from the font files
// by scripts/gen-caption-metrics.ts; tests/unit/captions.test.ts fails when they no longer match the files.
const REGULAR_RUNS: Run[] = [
  [32, [260, 269, 408, 646, 572, 831, 732, 225, 300, 300, 551, 572, 268, 322, 268, 372, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572, 268, 268, 572, 572, 572, 434, 899, 639, 650, 632, 730, 556, 519, 728, 741, 339, 273, 619, 524, 907, 760, 781, 605, 781, 622, 549, 556, 731, 600, 930, 586, 566, 572, 329, 372, 329, 572, 444, 281, 561, 615, 480, 615, 564, 344, 615, 618, 258, 258, 534, 258, 935, 618, 605, 615, 615, 413, 479, 361, 618, 508, 786, 529, 510, 470, 380, 551, 380, 572]],
  [160, [260, 269, 572, 572, 572, 572, 551, 513, 580, 832, 357, 509, 572, 322, 832, 500, 428, 572, 350, 350, 281, 623, 655, 268, 225, 350, 376, 509, 745, 771, 781, 434, 639, 639, 639, 639, 639, 639, 881, 632, 556, 556, 556, 556, 339, 339, 339, 339, 730, 760, 781, 781, 781, 781, 781, 572, 781, 731, 731, 731, 731, 566, 605, 631, 561, 561, 561, 561, 561, 561, 864, 480, 564, 564, 564, 564, 258, 258, 258, 258, 605, 618, 605, 605, 605, 605, 605, 572, 605, 618, 618, 618, 618, 510, 615, 510, 639, 561, 639, 561, 639, 561, 632, 480, 632, 480, 632, 480, 632, 480, 730, 615, 730, 617, 556, 564, 556, 564, 556, 564, 556, 564, 556, 564, 728, 615, 728, 615, 728, 615, 728, 615, 741, 618, 741, 618, 339, 258, 339, 258, 339, 258, 339, 258, 339, 258, 612, 516, 273, 258, 619, 534, 534, 524, 258, 524, 258, 524, 258, 524, 268, 524, 258, 760, 618, 760, 618, 760, 618, 688, 760, 618, 781, 605, 781, 605, 781, 605, 928, 946, 622, 413, 622, 413, 622, 413, 549, 479, 549, 479, 549, 479, 549, 479, 556, 361, 556, 361, 556, 361, 731, 618, 731, 618, 731, 618, 731, 618, 731, 618, 731, 618, 930, 786, 566, 510, 566, 572, 470, 572, 470, 572, 470, 326]],
  [8208, [322, 322, 572, 500, 1000, 1000, 551, 411, 175, 175, 250, 175, 359, 359, 416, 359, 512, 512, 376, 368, 500, 536, 791, 268]],
  [8240, [1177]],
  [8249, [310, 310]],
  [8364, [572]],
  [8482, [773]],
];
const BOLD_RUNS: Run[] = [
  [32, [260, 286, 472, 646, 572, 901, 750, 266, 339, 339, 545, 572, 285, 322, 285, 413, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572, 285, 285, 572, 572, 572, 477, 897, 690, 672, 637, 740, 560, 549, 724, 765, 389, 331, 664, 565, 943, 813, 796, 628, 796, 660, 551, 579, 756, 650, 967, 667, 624, 579, 331, 413, 331, 572, 411, 362, 604, 633, 514, 633, 591, 387, 633, 657, 305, 305, 620, 305, 982, 657, 619, 633, 633, 454, 497, 434, 657, 569, 856, 578, 569, 488, 394, 551, 394, 572]],
  [160, [260, 286, 572, 572, 572, 572, 551, 486, 607, 832, 383, 615, 572, 322, 832, 500, 428, 572, 379, 379, 362, 660, 655, 285, 205, 379, 388, 615, 830, 874, 845, 477, 690, 690, 690, 690, 690, 690, 952, 637, 560, 560, 560, 560, 389, 389, 389, 389, 740, 813, 796, 796, 796, 796, 796, 572, 796, 756, 756, 756, 756, 624, 628, 711, 604, 604, 604, 604, 604, 604, 917, 514, 591, 591, 591, 591, 305, 305, 305, 305, 619, 657, 619, 619, 619, 619, 619, 572, 619, 657, 657, 657, 657, 569, 633, 569, 690, 604, 690, 604, 690, 604, 637, 514, 637, 514, 637, 514, 637, 514, 740, 633, 740, 649, 560, 591, 560, 591, 560, 591, 560, 591, 560, 591, 724, 633, 724, 633, 724, 633, 724, 633, 765, 657, 765, 657, 389, 305, 389, 305, 389, 305, 389, 305, 389, 305, 720, 610, 331, 305, 664, 620, 620, 565, 305, 565, 305, 565, 305, 565, 362, 565, 305, 813, 657, 813, 657, 813, 657, 770, 813, 657, 796, 619, 796, 619, 796, 619, 973, 978, 660, 454, 660, 454, 660, 454, 551, 497, 551, 497, 551, 497, 551, 497, 579, 434, 579, 434, 579, 434, 756, 657, 756, 657, 756, 657, 756, 657, 756, 657, 756, 657, 967, 856, 624, 569, 624, 579, 488, 579, 488, 579, 488, 383]],
  [8208, [322, 322, 572, 500, 1000, 1000, 551, 411, 217, 217, 285, 217, 445, 445, 513, 445, 516, 516, 376, 376, 500, 570, 855, 285]],
  [8240, [1281]],
  [8249, [368, 368]],
  [8364, [572]],
  [8482, [773]],
];

/** libass sizes a font so that its (OS/2 winAscent + winDescent) equals the ASS font size: 1.362 em for Noto Sans. The line pitch is that size too. */
const LINE_PER_EM = 1.362;
const FALLBACK_UNITS = { regular: 560, bold: 610 };

function tableOf(runs: Run[]): Map<number, number> {
  const table = new Map<number, number>();
  for (const [start, widths] of runs) widths.forEach((width, index) => table.set(start + index, width));
  return table;
}

export const CAPTION_ADVANCES = { regular: REGULAR_RUNS, bold: BOLD_RUNS };
const ADVANCE_TABLES = { regular: tableOf(REGULAR_RUNS), bold: tableOf(BOLD_RUNS) };

/** Width of a text line in font units (1000 per em), without kerning, so a little more than what libass draws. */
export function textUnits(text: string, bold: boolean): number {
  const table = ADVANCE_TABLES[bold ? "bold" : "regular"];
  const fallback = bold ? FALLBACK_UNITS.bold : FALLBACK_UNITS.regular;
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x200b && code <= 0x200f) || code === 0x2060 || code === 0xfeff) continue;
    units += table.get(code) ?? fallback;
  }
  return units;
}

// ---- words ------------------------------------------------------------------------------------------------------------

const MIN_WORD_MS = 40;
/** A pause between two words longer than this starts a new event. */
const PAUSE_BREAK_MS = 700;
const TARGET_MIN_MS = 1000;
const TARGET_MAX_MS = 3000;
const HARD_MAX_MS = 4500;

/** The longest a word of this length plausibly lasts; engines stretch the first word after a silence back over it. */
const wordCapMs = (text: string): number => 450 + 110 * [...text].length;

const sanitize = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * The words as captions show them: cleaned, in time order, on the output timeline, with strictly increasing starts and no
 * overlap. A word stretched over a silence keeps its end (that is where engines put it right) and loses the stretched start;
 * a hyphen or apostrophe piece the engine split off ("Wi" + "-Fi") is joined to its word; words whose middle lies inside a
 * removed range are dropped, the others are mapped through the cut.
 */
export function prepareWords(words: TranscriptWord[], removed?: Range[]): TranscriptWord[] {
  const cleaned: TranscriptWord[] = [];
  for (const word of words) {
    const t = sanitize(word.t);
    if (t === "" || !Number.isFinite(word.s) || !Number.isFinite(word.e)) continue;
    const cap = wordCapMs(t);
    cleaned.push({ ...word, t, s: word.e - word.s > cap ? word.e - cap : word.s });
  }
  cleaned.sort((a, b) => a.s - b.s || a.e - b.e);

  const joined: TranscriptWord[] = [];
  for (const word of cleaned) {
    const previous = joined[joined.length - 1];
    if (previous && previous.pid === word.pid && /^[-'’]\p{L}/u.test(word.t) && word.s - previous.e < 300 && !sentenceEnd(previous.t)) {
      joined[joined.length - 1] = { ...previous, t: previous.t + word.t, e: Math.max(previous.e, word.e) };
    } else joined.push(word);
  }

  const edl = { removed: normalize(removed ?? []) };
  const mapped: TranscriptWord[] = [];
  for (const word of joined) {
    if (edl.removed.length > 0 && findRemoved(edl, (word.s + word.e) / 2) !== null) continue;
    mapped.push(edl.removed.length > 0 ? { ...word, s: toOutput(edl, word.s), e: toOutput(edl, word.e) } : word);
  }

  const out: TranscriptWord[] = [];
  let previousStart = -Infinity;
  for (const word of mapped) {
    const s = Math.round(Math.max(word.s, previousStart + MIN_WORD_MS));
    out.push({ ...word, s, e: Math.round(Math.max(word.e, s + MIN_WORD_MS)) });
    previousStart = s;
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const word = out[i] as TranscriptWord;
    word.e = Math.min(word.e, (out[i + 1] as TranscriptWord).s);
  }
  return out;
}

// ---- geometry ---------------------------------------------------------------------------------------------------------

interface Geometry {
  /** Canvas pixels per style pixel. */
  scale: number;
  /** Em size in canvas px. */
  em: number;
  /** The ASS font size that gives this em in libass. */
  assSize: number;
  /** Line pitch in canvas px. */
  lineHeight: number;
  /** Space around the text a caption's outline, box padding and shadow can fill. */
  inset: number;
  safe: Rect;
  /** Horizontal centre of the safe area and the widest the text may be. */
  cx: number;
  maxWidth: number;
}

function geometryOf(canvas: Canvas, style: CaptionStyle): Geometry {
  const scale = Math.min(canvas.width, canvas.height) / 1080;
  const em = style.fontSize * scale;
  const reach = (style.box ? style.box.padding : style.outlineWidth) + style.shadow;
  // 3 px (at 1080) of slack for anti-aliasing and the box libass adds around the line
  const inset = Math.ceil((reach + 3) * scale);
  const safe = safeArea(canvas);
  return { scale, em, assSize: em * LINE_PER_EM, lineHeight: em * LINE_PER_EM, inset, safe, cx: safe.x + safe.w / 2, maxWidth: safe.w - 2 * inset - 2 };
}

const displayText = (text: string, style: CaptionStyle): string => (style.uppercase ? text.toUpperCase() : text);

interface Placement {
  rect: Rect;
  /** Font size factor: 1, or less when the widest line would not fit the safe area. */
  fit: number;
  an: 2 | 5 | 8;
  x: number;
  y: number;
}

function placeEvent(lines: string[], geometry: Geometry, style: CaptionStyle): Placement {
  const { em, lineHeight, inset, safe, cx } = geometry;
  const widest = Math.max(0, ...lines.map((line) => textUnits(displayText(line, style), style.bold))) / 1000 * em;
  const fit = widest > geometry.maxWidth ? Math.floor((geometry.maxWidth / widest) * 100) / 100 : 1;
  const width = widest * fit + 2 * inset;
  const height = lines.length * lineHeight * fit + 2 * inset;
  const left = cx - width / 2;
  const bottom = safe.y + safe.h;
  const centre = safe.y + safe.h / 2;
  let top: number;
  let an: 2 | 5 | 8;
  let y: number;
  if (style.position === "top") {
    top = safe.y;
    an = 8;
    y = top + inset;
  } else if (style.position === "center") {
    top = centre - height / 2;
    an = 5;
    y = centre;
  } else {
    top = bottom - height;
    an = 2;
    y = bottom - inset;
  }
  const x0 = Math.max(safe.x, Math.floor(left));
  const y0 = Math.max(safe.y, Math.floor(top));
  const x1 = Math.min(safe.x + safe.w, Math.ceil(left + width));
  const y1 = Math.min(bottom, Math.ceil(top + height));
  return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, fit, an, x: cx, y };
}

/** The box each event occupies, outline, padding and shadow included, estimated from the font's advance widths. */
export function captionBoxes(lines: CaptionLine[], canvas: Canvas, style: CaptionStyle): Rect[] {
  const geometry = geometryOf(canvas, style);
  return lines.map((event) => placeEvent(event.lines, geometry, style).rect);
}

// ---- layout -----------------------------------------------------------------------------------------------------------

const CLAUSE_END = /[,;:–—]["')\]]*$/;
const ONE_LETTER = /^\p{L}$/u;
/** Articles, prepositions and conjunctions (English and Polish): a line or an event should not end on one. */
const WEAK_END = /^(?:an|the|of|to|in|on|at|by|for|with|and|or|but|as|if|so|than|that|ze|na|do|od|po|za|oraz|lub|albo|że|się|nie|bo|ale|jak)$/i;

interface Item {
  word: TranscriptWord;
  chars: number;
  units: number;
}

/** Breaks one run of words (no speaker change, no long pause) into events and each event into balanced lines. */
class Breaker {
  private readonly lineMemo = new Map<number, number[] | null>();
  private readonly chars: number[] = [0];
  private readonly units: number[] = [0];
  private readonly items: Item[];
  private readonly maxChars: number;
  private readonly maxLines: number;
  private readonly maxUnits: number;
  private readonly spaceUnits: number;

  constructor(items: Item[], limits: { maxChars: number; maxLines: number; maxUnits: number; spaceUnits: number }) {
    this.items = items;
    this.maxChars = limits.maxChars;
    this.maxLines = limits.maxLines;
    this.maxUnits = limits.maxUnits;
    this.spaceUnits = limits.spaceUnits;
    for (const item of items) {
      this.chars.push((this.chars[this.chars.length - 1] as number) + item.chars);
      this.units.push((this.units[this.units.length - 1] as number) + item.units);
    }
  }

  private lineChars(i: number, j: number): number {
    return (this.chars[j] as number) - (this.chars[i] as number) + (j - i - 1);
  }

  private lineUnits(i: number, j: number): number {
    return (this.units[j] as number) - (this.units[i] as number) + (j - i - 1) * this.spaceUnits;
  }

  private fits(i: number, j: number): boolean {
    return this.lineChars(i, j) <= this.maxChars && this.lineUnits(i, j) <= this.maxUnits;
  }

  /** Cost of a line ending before word j: balanced lines are cheap, a break after a clause end is cheaper still, one after a one-letter word is not wanted. */
  private lineCost(i: number, j: number, last: boolean): number {
    const share = Math.min(1, this.lineUnits(i, j) / this.maxUnits);
    let cost = share * share;
    if (!last) {
      const text = (this.items[j - 1] as Item).word.t;
      if (sentenceEnd(text)) cost -= 0.15;
      else if (CLAUSE_END.test(text)) cost -= 0.08;
      else if (ONE_LETTER.test(text)) cost += 0.2;
      else if (WEAK_END.test(text)) cost += 0.12;
    }
    return cost;
  }

  /** End indexes (exclusive) of the lines of words [i, j), with as few lines as possible; null when they do not fit in maxLines. A single word always fits. */
  lines(i: number, j: number): number[] | null {
    const key = i * (this.items.length + 1) + j;
    const memo = this.lineMemo.get(key);
    if (memo !== undefined) return memo;
    let result: number[] | null = null;
    if (j - i === 1 || this.fits(i, j)) result = [j];
    else {
      for (let count = 2; count <= this.maxLines && !result; count++) result = this.split(i, j, count);
    }
    this.lineMemo.set(key, result);
    return result;
  }

  private split(i: number, j: number, count: number): number[] | null {
    const n = j - i;
    // best[k][m]: cheapest way to put the first m words in k lines
    const best: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const from: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
    (best[0] as number[])[0] = 0;
    for (let k = 1; k <= count; k++) {
      for (let m = k; m <= n; m++) {
        for (let p = k - 1; p < m; p++) {
          const previous = (best[k - 1] as number[])[p] as number;
          if (previous === Infinity || !this.fits(i + p, i + m)) continue;
          const cost = previous + this.lineCost(i + p, i + m, m === n);
          if (cost < ((best[k] as number[])[m] as number)) {
            (best[k] as number[])[m] = cost;
            (from[k] as number[])[m] = p;
          }
        }
      }
    }
    if ((best[count] as number[])[n] === Infinity) return null;
    const ends: number[] = [];
    let m = n;
    for (let k = count; k >= 1; k--) {
      ends.unshift(i + m);
      m = (from[k] as number[])[m] as number;
    }
    return ends;
  }

  /** Splits the run into events: the cheapest partition by reading time, length and how natural the breaks are. */
  events(): { start: number; end: number; lines: number[] }[] {
    const n = this.items.length;
    const best = new Array<number>(n + 1).fill(Infinity);
    const from = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      const base = best[i] as number;
      if (base === Infinity) continue;
      for (let j = i + 1; j <= n; j++) {
        const lines = this.lines(i, j);
        if (!lines) break;
        const duration = (this.items[j - 1] as Item).word.e - (this.items[i] as Item).word.s;
        if (j - i > 1 && duration > HARD_MAX_MS) break;
        const cost = base + this.eventCost(i, j, duration);
        if (cost < (best[j] as number)) {
          best[j] = cost;
          from[j] = i;
        }
      }
    }
    const out: { start: number; end: number; lines: number[] }[] = [];
    for (let j = n; j > 0; ) {
      const i = from[j] as number;
      out.unshift({ start: i, end: j, lines: this.lines(i, j) as number[] });
      j = i;
    }
    return out;
  }

  private eventCost(i: number, j: number, duration: number): number {
    let cost = 1;
    if (duration < TARGET_MIN_MS) cost += ((TARGET_MIN_MS - duration) / TARGET_MIN_MS) * 1.5;
    if (duration > TARGET_MAX_MS) cost += ((duration - TARGET_MAX_MS) / 1000) * 2.5;
    const fill = Math.min(1, this.lineChars(i, j) / (this.maxChars * this.maxLines));
    cost += 0.8 * (1 - fill) * (1 - fill);
    if (j < this.items.length) {
      const text = (this.items[j - 1] as Item).word.t;
      if (sentenceEnd(text)) cost += 0;
      else if (CLAUSE_END.test(text)) cost += 0.4;
      else cost += 1.6;
      if (ONE_LETTER.test(text)) cost += 1.5;
      else if (WEAK_END.test(text)) cost += 0.8;
    }
    return cost;
  }
}

/**
 * Caption events for the words: breaks at sentence and clause ends and at pauses, lines balanced and never longer than
 * maxCharsPerLine (of the canvas' aspect) or the safe area, a word never split. Times are the words' own, on the output
 * timeline when `removed` is given; events do not overlap and stay at least MIN_CAPTION_MS on screen unless the next one starts sooner.
 */
export function layoutCaptions(words: TranscriptWord[], canvas: Canvas, style: CaptionStyle, opts: LayoutOptions = {}): CaptionLine[] {
  const prepared = prepareWords(words, opts.removed);
  if (prepared.length === 0) return [];
  const geometry = geometryOf(canvas, style);
  const maxChars = style.maxCharsPerLine[aspectOf(canvas)];
  const maxUnits = (geometry.maxWidth / geometry.em) * 1000;
  const spaceUnits = textUnits(" ", style.bold);
  const items: Item[] = prepared.map((word) => {
    const text = displayText(word.t, style);
    return { word, chars: [...text].length, units: textUnits(text, style.bold) };
  });

  const events: CaptionLine[] = [];
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    const previous = items[i - 1] as Item;
    const next = items[i];
    const boundary = !next || next.word.s - previous.word.e > PAUSE_BREAK_MS || (opts.speakers === true && next.word.pid !== previous.word.pid);
    if (!boundary) continue;
    const run = items.slice(start, i);
    const breaker = new Breaker(run, { maxChars, maxLines: Math.max(1, style.maxLines), maxUnits, spaceUnits });
    for (const event of breaker.events()) {
      const members = run.slice(event.start, event.end);
      let lineStart = event.start;
      const lines = event.lines.map((lineEnd) => {
        const text = run.slice(lineStart, lineEnd).map((item) => item.word.t).join(" ");
        lineStart = lineEnd;
        return text;
      });
      const first = (members[0] as Item).word;
      const last = (members[members.length - 1] as Item).word;
      events.push({
        s: first.s,
        e: last.e,
        words: members.map((item) => ({ text: item.word.t, s: item.word.s, e: item.word.e })),
        lines,
        ...(opts.speakers === true ? { pid: first.pid } : {}),
      });
    }
    start = i;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as CaptionLine;
    const next = events[i + 1];
    event.e = Math.max(event.e, event.s + MIN_CAPTION_MS);
    if (next) event.e = Math.min(event.e, next.s);
  }
  return events;
}

// ---- ASS --------------------------------------------------------------------------------------------------------------

/** &HAABBGGRR for a style field; alpha 1 is opaque. */
function assColor(hex: string, opacity = 1): string {
  const [r, g, b] = rgbOf(hex);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${byte(alpha)}${byte(b)}${byte(g)}${byte(r)}`;
}

/** &HBBGGRR& for an override tag. */
function assTagColor(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  return `&H${byte(b)}${byte(g)}${byte(r)}&`;
}

function rgbOf(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return [255, 255, 255];
  return [parseInt(match[1] as string, 16), parseInt(match[2] as string, 16), parseInt(match[3] as string, 16)];
}

const byte = (value: number): string => value.toString(16).toUpperCase().padStart(2, "0");

/**
 * Text of a Dialogue line. `{` and `}` are escaped with a backslash, line breaks become \N, and a literal backslash is
 * followed by a zero-width space so that it can never join the next character into an escape such as \N or \{.
 */
export function escapeAssText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[\\{}]/g, (char) => (char === "\\" ? "\\\u200b" : `\\${char}`)))
    .join("\\N");
}

const assTime = (ms: number): string => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const num = (value: number): string => String(Math.round(value * 100) / 100);

/** The words of each line of an event, found by matching the line texts; a hand-made event that does not match is one line. */
function wordsByLine(event: CaptionLine): CaptionWord[][] {
  const out: CaptionWord[][] = [];
  let index = 0;
  for (const line of event.lines) {
    const group: CaptionWord[] = [];
    let text = "";
    while (index < event.words.length && text.length < line.length) {
      const word = event.words[index] as CaptionWord;
      text = text === "" ? word.text : `${text} ${word.text}`;
      group.push(word);
      index += 1;
    }
    if (text !== line) return [event.words];
    out.push(group);
  }
  return index === event.words.length ? out : [event.words];
}

function eventText(event: CaptionLine, style: CaptionStyle, startMs: number): string {
  const groups = wordsByLine(event);
  const primary = assTagColor(style.primary);
  const highlight = assTagColor(style.highlight);
  let cursor = 0; // karaoke: centiseconds played so far
  const lines = groups.map((group) => {
    const parts = group.map((word) => {
      const text = escapeAssText(displayText(word.text, style));
      let tags = "";
      if (style.highlightMode === "word") {
        const on = Math.max(0, Math.round(word.s - startMs));
        const off = Math.max(on + 1, Math.round(word.e - startMs));
        tags = `{\\1c${primary}\\t(${on},${on + 1},\\1c${highlight})\\t(${off},${off + 1},\\1c${primary})}`;
      } else if (style.highlightMode === "karaoke") {
        const on = Math.max(0, Math.round((word.s - startMs) / 10));
        const off = Math.max(on + 1, Math.round((word.e - startMs) / 10));
        const gap = Math.max(0, on - cursor);
        tags = `${gap > 0 ? `{\\k${gap}}` : ""}{\\kf${off - on}}`;
        cursor = Math.max(cursor, on) + (off - on);
      }
      return `${tags}${text}`;
    });
    return parts.join(" ");
  });
  return lines.join("\\N");
}

/** A complete ASS file (PlayRes = canvas) with one Dialogue per event, positioned inside the safe area. */
export function toAss(lines: CaptionLine[], canvas: Canvas, style: CaptionStyle): string {
  const geometry = geometryOf(canvas, style);
  const { safe } = geometry;
  const box = style.box;
  const alignment = style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
  const marginV = style.position === "top" ? safe.y + geometry.inset : style.position === "center" ? 0 : canvas.height - (safe.y + safe.h) + geometry.inset;
  const name = style.id.replace(/[^A-Za-z0-9_-]/g, "_") || "caption";
  const primaryField = style.highlightMode === "karaoke" ? style.highlight : style.primary;
  const secondaryField = style.highlightMode === "karaoke" ? style.primary : style.highlight;
  const styleLine = [
    name,
    style.fontName.replace(/[,\r\n]/g, " "),
    num(geometry.assSize),
    assColor(primaryField),
    assColor(secondaryField),
    box ? assColor(box.color, box.alpha) : assColor(style.outline),
    assColor("#000000", 0.55),
    style.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    box ? 3 : 1,
    num((box ? box.padding : style.outlineWidth) * geometry.scale),
    num(style.shadow * geometry.scale),
    alignment,
    safe.x,
    canvas.width - (safe.x + safe.w),
    marginV,
    1,
  ].join(",");
  const header = [
    "[Script Info]",
    "; Generated by SyncRecord",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${styleLine}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const dialogues = lines.map((event) => {
    const startCs = Math.round(event.s / 10);
    const endCs = Math.max(startCs + 1, Math.round(event.e / 10));
    const placement = placeEvent(event.lines, geometry, style);
    const fit = placement.fit < 1 ? `\\fs${num(geometry.assSize * placement.fit)}` : "";
    const position = `{\\an${placement.an}\\pos(${num(placement.x)},${num(placement.y)})${fit}}`;
    return `Dialogue: 0,${assTime(startCs * 10)},${assTime(endCs * 10)},${name},,0,0,0,,${position}${eventText(event, style, startCs * 10)}`;
  });
  return `${[...header, ...dialogues].join("\n")}\n`;
}

// ---- sidecars ---------------------------------------------------------------------------------------------------------

export interface SidecarOptions {
  /** Removed ranges of the EDL (project timeline, ms), as for layoutCaptions. */
  removed?: Range[];
  /** Prefix each speaker change with the speaker's name. */
  speakers?: boolean;
  nameOf?: (pid: string) => string;
}

/** SRT and WebVTT for the same words, cut and mapped like the burned-in captions; empty input gives an empty SRT and a header-only VTT. */
export function captionSidecars(words: TranscriptWord[], opts: SidecarOptions = {}): { srt: string; vtt: string } {
  const prepared = prepareWords(words, opts.removed);
  const cues: Cue[] = buildCues(prepared, opts.nameOf ?? ((pid) => pid));
  // buildCues keeps a cue at least 100 ms long, which can run into a close next start
  for (let i = 0; i + 1 < cues.length; i++) {
    const cue = cues[i] as Cue;
    cue.endMs = Math.max(cue.startMs + 1, Math.min(cue.endMs, (cues[i + 1] as Cue).startMs));
  }
  return { srt: toSrt(cues, opts.speakers === true), vtt: toVtt(cues, opts.speakers === true) };
}

// ---- ffmpeg -----------------------------------------------------------------------------------------------------------

/**
 * A filter option value that survives both levels of ffmpeg's filtergraph parsing: backslash-escaped for the option
 * parser (`\\`, `\'`, `\:`), then wrapped in single quotes for the graph parser, which keeps `,` `;` `[` `]` and spaces as they are.
 */
export function escapeFilterValue(value: string): string {
  const option = value.replace(/[\\':]/g, (char) => `\\${char}`);
  return `'${option.replace(/'/g, "'\\''")}'`;
}

/** The ffmpeg video filter that burns the ASS file in with libass. The face the file names is loaded from `fontsDir`, so the result does not depend on the fonts installed on the host. */
export function captionFilter(assPath: string, fontsDir: string): string {
  return `ass=filename=${escapeFilterValue(assPath)}:fontsdir=${escapeFilterValue(fontsDir)}`;
}
