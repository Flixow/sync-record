import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTION_ADVANCES,
  CAPTION_FONT_FILES,
  CAPTION_STYLES,
  MIN_CAPTION_MS,
  aspectOf,
  captionBoxes,
  captionFilter,
  captionSidecars,
  captionStyleById,
  escapeAssText,
  escapeFilterValue,
  layoutCaptions,
  prepareWords,
  textUnits,
  toAss,
  type CaptionLine,
  type CaptionStyle,
} from "../../src/shared/captions.js";
import { insideRect, safeArea, type Canvas } from "../../src/shared/safe-area.js";
import { validateSrt, validateVtt, type TranscriptWord } from "../../src/shared/transcript.js";
import { advanceRuns } from "../../scripts/gen-caption-metrics.js";
import { FONTS_DIR } from "../support/caption-render.js";
import { readFont } from "../support/font.js";

const word = (t: string, s: number, e: number, pid = "p1"): TranscriptWord => ({ t, s, e, src: `${pid}-audio`, pid });

const CANVASES: Record<string, Canvas> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16 small": { width: 540, height: 960 },
  "16:9 4k": { width: 3840, height: 2160 },
};

// ---- deterministic speech: words with punctuation, pauses, speaker turns and the odd long word -----------------------------

const EN = "the quick brown fox jumps over a lazy dog while people were saying that nothing would ever change in this city but it did and we all remember how extraordinary understanding can be when you listen carefully to each other".split(" ");
const PL = "zażółć gęślą jaźń to znana fraza ale w tej rozmowie mówimy o czymś zupełnie innym niż pogoda czy polityka więc najserdeczniejsze podziękowania dla wszystkich którzy przyszli w ten wyjątkowo deszczowy wieczór żeby nas posłuchać".split(" ");

function speech(vocabulary: string[], count: number, seed: number): TranscriptWord[] {
  let state = seed;
  const random = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const out: TranscriptWord[] = [];
  let at = 1000;
  let pid = "p1";
  let sentence = 0;
  for (let i = 0; i < count; i++) {
    let text = vocabulary[Math.floor(random() * vocabulary.length)] as string;
    sentence += 1;
    const roll = random();
    let ends = false;
    if (sentence > 5 && roll < 0.25) {
      text += ".";
      ends = true;
    } else if (roll < 0.35) text += ",";
    else if (roll > 0.97) text = text.toUpperCase();
    const duration = Math.round(110 + 55 * text.length + random() * 120);
    out.push(word(text, at, at + duration, pid));
    at += duration;
    const gap = random();
    if (gap < 0.1) at += Math.round(60 + random() * 240);
    else if (gap < 0.14) at += Math.round(900 + random() * 1600);
    if (ends) {
      sentence = 0;
      if (random() < 0.4) pid = pid === "p1" ? "p2" : "p1";
    }
  }
  return out;
}

const SPEECH = { en: speech(EN, 400, 7), pl: speech(PL, 400, 11) };

const display = (text: string, style: CaptionStyle): string => (style.uppercase ? text.toUpperCase() : text);

describe("styles and the bundled font", () => {
  it("has four presets that all use the bundled font", () => {
    expect(CAPTION_STYLES.map((style) => style.id)).toEqual(["clean", "bold-box", "karaoke-pop", "minimal"]);
    expect(new Set(CAPTION_STYLES.map((style) => style.fontName))).toEqual(new Set(["Noto Sans"]));
    expect(captionStyleById("bold-box")?.highlightMode).toBe("word");
    expect(captionStyleById("karaoke-pop")?.highlightMode).toBe("karaoke");
    expect(captionStyleById("nope")).toBeNull();
    for (const file of CAPTION_FONT_FILES) expect(existsSync(path.join(FONTS_DIR, file))).toBe(true);
    expect(existsSync(path.join(FONTS_DIR, "OFL.txt"))).toBe(true);
  });

  it("embeds exactly the advance widths of the font files", () => {
    expect(CAPTION_ADVANCES.regular).toEqual(advanceRuns(path.join(FONTS_DIR, "NotoSans-Regular.ttf")));
    expect(CAPTION_ADVANCES.bold).toEqual(advanceRuns(path.join(FONTS_DIR, "NotoSans-Bold.ttf")));
  });

  it("has a glyph for every Polish letter in both weights", () => {
    for (const file of CAPTION_FONT_FILES) {
      const font = readFont(path.join(FONTS_DIR, file));
      for (const char of "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ") expect(font.glyphOf(char.codePointAt(0) as number), `${file} ${char}`).toBeGreaterThan(0);
    }
  });

  it("measures text with the font's own widths", () => {
    const bold = readFont(path.join(FONTS_DIR, "NotoSans-Bold.ttf"));
    const expected = [..."Zażółć gęślą"].reduce((sum, char) => sum + bold.advanceOf(char.codePointAt(0) as number), 0);
    expect(textUnits("Zażółć gęślą", true)).toBe(expected);
    expect(textUnits("a\u200bb", false)).toBe(textUnits("ab", false));
    expect(textUnits("W", true)).toBeGreaterThan(textUnits("i", true) * 2);
  });

  it("classifies the canvas aspect", () => {
    expect(aspectOf(CANVASES["16:9"] as Canvas)).toBe("16:9");
    expect(aspectOf(CANVASES["9:16"] as Canvas)).toBe("9:16");
    expect(aspectOf(CANVASES["1:1"] as Canvas)).toBe("1:1");
    expect(aspectOf(CANVASES["4:5"] as Canvas)).toBe("1:1");
  });
});

describe("line breaking and timing", () => {
  for (const [label, canvas] of Object.entries(CANVASES)) {
    for (const style of CAPTION_STYLES) {
      for (const lang of ["en", "pl"] as const) {
        it(`keeps the invariants: ${style.id}, ${label}, ${lang}`, () => {
          const input = SPEECH[lang];
          const events = layoutCaptions(input, canvas, style);
          const prepared = prepareWords(input);
          const maxChars = style.maxCharsPerLine[aspectOf(canvas)];
          const area = safeArea(canvas);
          const boxes = captionBoxes(events, canvas, style);

          // every word exactly once, in order, never split
          expect(events.flatMap((event) => event.words.map((w) => w.text))).toEqual(prepared.map((w) => w.t));
          let previousEnd = -Infinity;
          events.forEach((event, index) => {
            expect(event.lines.length).toBeGreaterThanOrEqual(1);
            expect(event.lines.length).toBeLessThanOrEqual(style.maxLines);
            expect(event.lines.join(" ")).toBe(event.words.map((w) => w.text).join(" "));
            for (const line of event.lines) {
              expect(line).not.toBe("");
              if (line.includes(" ")) expect([...display(line, style)].length, line).toBeLessThanOrEqual(maxChars);
            }
            // time: ordered, no overlap, on screen long enough unless the next event starts
            expect(event.e).toBeGreaterThan(event.s);
            expect(event.s).toBeGreaterThanOrEqual(previousEnd);
            const next = events[index + 1];
            if (next) expect(event.e - event.s >= MIN_CAPTION_MS || event.e === next.s).toBe(true);
            else expect(event.e - event.s).toBeGreaterThanOrEqual(MIN_CAPTION_MS);
            for (const w of event.words) {
              expect(w.s).toBeGreaterThanOrEqual(event.s);
              expect(w.e).toBeLessThanOrEqual(event.e);
              expect(w.e).toBeGreaterThan(w.s);
            }
            if (event.words.length > 1) expect(event.words[event.words.length - 1]?.e as number - event.s).toBeLessThanOrEqual(4500);
            previousEnd = event.e;
            // the box lies inside the safe area
            expect(insideRect(boxes[index] as NonNullable<(typeof boxes)[number]>, area), `${JSON.stringify(event.lines)} ${JSON.stringify(boxes[index])}`).toBe(true);
          });
          const durations = events.map((event) => event.e - event.s).sort((a, b) => a - b);
          const median = durations[Math.floor(durations.length / 2)] as number;
          expect(median).toBeGreaterThanOrEqual(800);
          expect(median).toBeLessThanOrEqual(3200);
        });
      }
    }
  }

  const clean = captionStyleById("clean") as CaptionStyle;
  const wide = CANVASES["16:9"] as Canvas;

  const sentence = (text: string, start: number, step = 300, pid = "p1"): TranscriptWord[] => text.split(" ").map((t, i) => word(t, start + i * step, start + (i + 1) * step, pid));

  it("breaks after a sentence end when both sentences are long enough to stand alone", () => {
    const words = [...sentence("We went to the market to buy fresh vegetables.", 0), ...sentence("Then we cooked dinner together at home tonight.", 2400)];
    const events = layoutCaptions(words, wide, clean);
    expect(events.map((event) => event.lines.join(" "))).toEqual(["We went to the market to buy fresh vegetables.", "Then we cooked dinner together at home tonight."]);
  });

  it("joins short sentences instead of flashing one word at a time", () => {
    const words = [...sentence("Yes.", 0), ...sentence("I know.", 300), ...sentence("Really?", 900)];
    const events = layoutCaptions(words, wide, clean);
    expect(events).toHaveLength(1);
  });

  it("starts a new event at a long pause", () => {
    const events = layoutCaptions([...sentence("one two three", 0), ...sentence("four five six", 1900)], wide, clean);
    expect(events.map((event) => event.lines.join(" "))).toEqual(["one two three", "four five six"]);
  });

  it("splits long text into balanced lines and prefers a clause end", () => {
    const words = sentence("alpha bravo charlie delta echo foxtrot golf hotel", 0, 200);
    const short = layoutCaptions(words.slice(0, 5), wide, clean);
    expect(short[0]?.lines).toHaveLength(1);
    const [event] = layoutCaptions(words, wide, clean);
    expect(event?.lines).toHaveLength(2); // 47 characters do not fit one 42 character line
    const [a, b] = event?.lines as [string, string];
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(6);
    const narrow = layoutCaptions(words, CANVASES["9:16"] as Canvas, clean);
    for (const part of narrow) if (part.lines.length === 2) expect(Math.abs((part.lines[0] as string).length - (part.lines[1] as string).length)).toBeLessThanOrEqual(10);
    const comma = layoutCaptions(sentence("When it rains, we stay inside and read every book", 0, 250), CANVASES["9:16"] as Canvas, clean);
    expect(comma[0]?.lines[0]?.endsWith(",")).toBe(true);
  });

  it("keeps speakers apart when asked", () => {
    const words = [...sentence("good morning everyone", 0, 300, "p1"), ...sentence("hello there", 900, 300, "p2")];
    const mixed = layoutCaptions(words, wide, clean);
    expect(mixed).toHaveLength(1);
    const apart = layoutCaptions(words, wide, clean, { speakers: true });
    expect(apart.map((event) => event.pid)).toEqual(["p1", "p2"]);
    expect(apart.map((event) => event.lines.join(" "))).toEqual(["good morning everyone", "hello there"]);
  });

  it("never splits a word that is longer than the line, and keeps it inside the safe area", () => {
    const long = "Nieprzewidywalnościamiwszechświata".repeat(2);
    const words = [word("a", 0, 200), word(long, 200, 1600), word("b", 1600, 1800)];
    for (const style of CAPTION_STYLES) {
      for (const canvas of Object.values(CANVASES)) {
        const events = layoutCaptions(words, canvas, style);
        expect(events.flatMap((event) => event.words.map((w) => w.text))).toContain(long);
        expect(events.some((event) => event.lines.includes(long))).toBe(true);
        for (const box of captionBoxes(events, canvas, style)) expect(insideRect(box, safeArea(canvas))).toBe(true);
      }
    }
  });

  it("keeps the widest glyphs inside the safe area (upper case, W and M)", () => {
    const words = ["WWWWWWWWWW", "MMMMMMMM", "WMWMWMWMWM", "mmmmmmmmmmmm"].map((t, i) => word(t, i * 400, i * 400 + 380));
    for (const style of CAPTION_STYLES) {
      for (const canvas of Object.values(CANVASES)) {
        for (const box of captionBoxes(layoutCaptions(words, canvas, style), canvas, style)) expect(insideRect(box, safeArea(canvas))).toBe(true);
      }
    }
  });

  it("returns nothing for no words and ignores empty or broken ones", () => {
    expect(layoutCaptions([], wide, clean)).toEqual([]);
    expect(layoutCaptions([word("  ", 0, 100), word("", 100, 200), word("ok", Number.NaN, 5)], wide, clean)).toEqual([]);
  });
});

describe("word repairs", () => {
  it("keeps the end of a word stretched over a silence and drops the stretched start", () => {
    const [stretched] = prepareWords([word("The", 4970, 15_890), word("report", 15_890, 16_210)]);
    expect(stretched?.e).toBe(15_890);
    expect(stretched?.s).toBe(15_890 - (450 + 110 * 3));
  });

  it("joins a hyphen or apostrophe piece to its word", () => {
    const prepared = prepareWords([word("Wi", 100, 300), word("-Fi", 300, 500), word("doorbell,", 500, 900), word("John", 1000, 1200), word("'s", 1200, 1300), word("-20,", 1300, 1500)]);
    expect(prepared.map((w) => w.t)).toEqual(["Wi-Fi", "doorbell,", "John's", "-20,"]);
    expect(prepared[0]).toMatchObject({ s: 100, e: 500 });
  });

  it("makes starts strictly increasing and ends non-overlapping", () => {
    const prepared = prepareWords([word("a", 100, 400), word("b", 100, 300, "p2"), word("c", 250, 260), word("d", 250, 700, "p2")]);
    for (let i = 1; i < prepared.length; i++) expect((prepared[i] as TranscriptWord).s).toBeGreaterThan((prepared[i - 1] as TranscriptWord).s);
    for (let i = 0; i + 1 < prepared.length; i++) expect((prepared[i] as TranscriptWord).e).toBeLessThanOrEqual((prepared[i + 1] as TranscriptWord).s);
    for (const w of prepared) expect(w.e).toBeGreaterThan(w.s);
  });
});

describe("EDL remapping", () => {
  const clean = captionStyleById("clean") as CaptionStyle;
  const canvas = CANVASES["16:9"] as Canvas;
  const words = [word("one", 0, 500), word("two", 500, 1000), word("three", 1000, 1500), word("four", 1500, 2000)];

  it("drops words inside a cut and moves the rest onto the output timeline", () => {
    const prepared = prepareWords(words, [{ s: 400, e: 1100 }]);
    expect(prepared.map((w) => [w.t, w.s, w.e])).toEqual([["one", 0, 400], ["three", 400, 800], ["four", 800, 1300]]);
    const events = layoutCaptions(words, canvas, clean, { removed: [{ s: 400, e: 1100 }] });
    expect(events.flatMap((event) => event.words.map((w) => w.text))).toEqual(["one", "three", "four"]);
    expect(events[0]?.s).toBe(0);
    expect(events[events.length - 1]?.e).toBe(1300);
  });

  it("accepts unsorted and overlapping ranges", () => {
    const prepared = prepareWords(words, [{ s: 1200, e: 1700 }, { s: 400, e: 700 }, { s: 600, e: 1100 }]);
    expect(prepared.map((w) => w.t)).toEqual(["one", "four"]);
    expect(prepared[1]?.s).toBeLessThan(1500);
  });

  it("keeps a stretched word whose repaired position survives the cut", () => {
    const prepared = prepareWords([word("before", 0, 200), word("The", 300, 5000), word("report", 5000, 5400)], [{ s: 200, e: 4600 }]);
    expect(prepared.map((w) => w.t)).toEqual(["before", "The", "report"]);
    expect(prepared[1]?.e).toBe(600);
  });

  it("moves the sidecars the same way", () => {
    const { srt, vtt } = captionSidecars(words, { removed: [{ s: 400, e: 1100 }] });
    expect(srt).toContain("00:00:00,000 --> ");
    expect(srt).toContain("one three four");
    expect(srt).not.toContain("two");
    expect(vtt).not.toContain("two");
    const lastEnd = /--> (\d\d:\d\d:\d\d,\d{3})\n/.exec(srt)?.[1];
    expect(lastEnd).toBe("00:00:01,300");
  });
});

// ---- ASS -------------------------------------------------------------------------------------------------------------

interface Dialogue {
  startMs: number;
  endMs: number;
  style: string;
  text: string;
}

const assMs = (value: string): number => {
  const match = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(value);
  if (!match) throw new Error(`bad ASS time ${value}`);
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]) * 10;
};

function dialogues(ass: string): Dialogue[] {
  return ass
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line) => {
      const parts = line.slice("Dialogue: ".length).split(",");
      return { startMs: assMs(parts[1] as string), endMs: assMs(parts[2] as string), style: parts[3] as string, text: parts.slice(9).join(",") };
    });
}

describe("ASS escaping", () => {
  it("escapes braces, backslashes and line breaks", () => {
    expect(escapeAssText("a{b}c")).toBe("a\\{b\\}c");
    expect(escapeAssText("a\nb")).toBe("a\\Nb");
    expect(escapeAssText("a\r\nb\rc")).toBe("a\\Nb\\Nc");
    // a literal backslash must not be able to form \N, \n, \h, \{ or \} with the next character
    expect(escapeAssText("x\\Ny")).toBe("x\\\u200bNy");
    expect(escapeAssText("\\{")).toBe("\\\u200b\\{");
    expect(escapeAssText("plain text, with commas: ąćę")).toBe("plain text, with commas: ąćę");
  });

  it("never leaves an unescaped override block or escape sequence in the text of an event", () => {
    const style = captionStyleById("clean") as CaptionStyle;
    const canvas = CANVASES["16:9"] as Canvas;
    const words = ["{\\an9}", "a\\Nb", "}x{", "\\", "line\nbreak"].map((t, i) => word(t, i * 300, i * 300 + 280));
    const ass = toAss(layoutCaptions(words, canvas, style), canvas, style);
    const [event] = dialogues(ass);
    const text = (event as Dialogue).text.replace(/^\{\\an\d\\pos\([\d.]+,[\d.]+\)\}/, "");
    expect(text).not.toMatch(/(^|[^\\])\{/);
    expect(text.replace(/\\\\|\\[{}]/g, "")).not.toMatch(/[{}]/);
    expect(text.replace(/\\\u200b/g, "").match(/\\./g)?.filter((escape) => escape !== "\\N" && escape !== "\\{" && escape !== "\\}")).toEqual([]);
    expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(1);
  });
});

describe("toAss", () => {
  const words = SPEECH.en.slice(0, 60);

  it("writes a complete file: PlayRes = canvas, one style, one Dialogue per event", () => {
    for (const [label, canvas] of Object.entries(CANVASES)) {
      for (const style of CAPTION_STYLES) {
        const events = layoutCaptions(words, canvas, style);
        const ass = toAss(events, canvas, style);
        expect(ass).toContain("[Script Info]");
        expect(ass).toContain(`PlayResX: ${canvas.width}\nPlayResY: ${canvas.height}`);
        expect(ass).toContain("WrapStyle: 2");
        expect(ass.match(/^Style: /gm), label).toHaveLength(1);
        expect(ass).toContain(",Noto Sans,");
        const found = dialogues(ass);
        expect(found).toHaveLength(events.length);
        found.forEach((dialogue, index) => {
          const event = events[index] as CaptionLine;
          expect(Math.abs(dialogue.startMs - event.s)).toBeLessThanOrEqual(5);
          expect(Math.abs(dialogue.endMs - event.e)).toBeLessThanOrEqual(5);
          expect(dialogue.text).not.toContain("\n");
        });
      }
    }
  });

  it("puts margins and \\pos inside the safe area", () => {
    for (const canvas of Object.values(CANVASES)) {
      const area = safeArea(canvas);
      for (const style of CAPTION_STYLES) {
        const ass = toAss(layoutCaptions(words, canvas, style), canvas, style);
        const styleLine = (/^Style: (.*)$/m.exec(ass) as RegExpExecArray)[1] as string;
        const fields = styleLine.split(",");
        // Alignment, MarginL, MarginR, MarginV are fields 18..21
        expect(Number(fields[19])).toBe(area.x);
        expect(Number(fields[20])).toBe(canvas.width - (area.x + area.w));
        if (style.position === "bottom") expect(Number(fields[21])).toBeGreaterThanOrEqual(canvas.height - (area.y + area.h));
        const alignment = { bottom: 2, center: 5, top: 8 }[style.position];
        expect(Number(fields[18])).toBe(alignment);
        for (const dialogue of dialogues(ass)) {
          const pos = /\\an(\d)\\pos\(([\d.]+),([\d.]+)\)/.exec(dialogue.text) as RegExpExecArray;
          expect(Number(pos[1])).toBe(alignment);
          expect(Number(pos[2])).toBeCloseTo(area.x + area.w / 2, 0);
          expect(Number(pos[3])).toBeGreaterThanOrEqual(area.y);
          expect(Number(pos[3])).toBeLessThanOrEqual(area.y + area.h);
        }
      }
    }
  });

  it("keeps clear of the bottom 22% and right 14% of a vertical canvas", () => {
    const canvas = CANVASES["9:16"] as Canvas;
    for (const style of CAPTION_STYLES) {
      for (const box of captionBoxes(layoutCaptions(SPEECH.pl, canvas, style), canvas, style)) {
        expect(box.y + box.h).toBeLessThanOrEqual(canvas.height * 0.78 + 1);
        expect(box.x + box.w).toBeLessThanOrEqual(canvas.width * 0.86 + 1);
      }
    }
  });

  it("scales sizes with the canvas short edge", () => {
    const style = captionStyleById("clean") as CaptionStyle;
    const size = (canvas: Canvas): number => Number(((/^Style: (.*)$/m.exec(toAss([], canvas, style)) as RegExpExecArray)[1] as string).split(",")[2]);
    expect(size({ width: 1080, height: 1920 })).toBeCloseTo(size({ width: 1920, height: 1080 }), 5);
    expect(size({ width: 2160, height: 3840 })).toBeCloseTo(2 * size({ width: 1080, height: 1920 }), 1);
    expect(size({ width: 1080, height: 1920 })).toBeCloseTo(style.fontSize * 1.362, 1);
  });

  it("writes word highlights that switch on at the word start and off at its end, within 10 ms", () => {
    const style = captionStyleById("bold-box") as CaptionStyle;
    const canvas = CANVASES["9:16"] as Canvas;
    const events = layoutCaptions(words, canvas, style);
    const found = dialogues(toAss(events, canvas, style));
    found.forEach((dialogue, index) => {
      const event = events[index] as CaptionLine;
      const transitions = [...dialogue.text.matchAll(/\\t\((\d+),(\d+),\\1c&H([0-9A-F]{6})&\)/g)];
      expect(transitions).toHaveLength(event.words.length * 2);
      event.words.forEach((w, k) => {
        const on = transitions[2 * k] as RegExpMatchArray;
        const off = transitions[2 * k + 1] as RegExpMatchArray;
        expect(on[3]).toBe("3FD2FF"); // #FFD23F in BGR
        expect(off[3]).toBe("FFFFFF");
        expect(Math.abs(dialogue.startMs + Number(on[1]) - w.s)).toBeLessThanOrEqual(10);
        expect(Math.abs(dialogue.startMs + Number(off[1]) - w.e)).toBeLessThanOrEqual(10);
        expect(Number(on[2])).toBe(Number(on[1]) + 1);
      });
    });
  });

  it("writes karaoke timing as cumulative centiseconds that land on each word start, and swaps the colours", () => {
    const style = captionStyleById("karaoke-pop") as CaptionStyle;
    const canvas = CANVASES["16:9"] as Canvas;
    const events = layoutCaptions(words, canvas, style);
    const ass = toAss(events, canvas, style);
    const styleFields = ((/^Style: (.*)$/m.exec(ass) as RegExpExecArray)[1] as string).split(",");
    expect(styleFields[3]).toBe("&H004DE1FF"); // primary = the highlight (#FFE14D)
    expect(styleFields[4]).toBe("&H00FFFFFF");
    const found = dialogues(ass);
    found.forEach((dialogue, index) => {
      const event = events[index] as CaptionLine;
      let cursor = 0;
      const starts: number[] = [];
      const durations: number[] = [];
      for (const match of dialogue.text.matchAll(/\\(k|kf)(\d+)/g)) {
        if (match[1] === "kf") {
          starts.push(cursor);
          durations.push(Number(match[2]));
        }
        cursor += Number(match[2]);
      }
      expect(starts).toHaveLength(event.words.length);
      event.words.forEach((w, k) => {
        expect(Math.abs(dialogue.startMs + (starts[k] as number) * 10 - w.s)).toBeLessThanOrEqual(15);
        expect(Math.abs(dialogue.startMs + ((starts[k] as number) + (durations[k] as number)) * 10 - w.e)).toBeLessThanOrEqual(15);
      });
      const spoken = dialogue.text.replace(/\{[^}]*\}/g, "").replace(/\\N/g, " ");
      expect(spoken).toBe(spoken.toUpperCase());
      expect(spoken).toMatch(/[A-Z]/);
    });
  });

  it("writes no highlight tags for the plain presets", () => {
    for (const id of ["clean", "minimal"]) {
      const style = captionStyleById(id) as CaptionStyle;
      const canvas = CANVASES["16:9"] as Canvas;
      for (const dialogue of dialogues(toAss(layoutCaptions(words, canvas, style), canvas, style))) expect(dialogue.text).not.toMatch(/\\t\(|\\k/);
    }
  });

  it("draws the box preset as an opaque box with its padding and opacity", () => {
    const style = captionStyleById("bold-box") as CaptionStyle;
    const canvas = CANVASES["16:9"] as Canvas;
    const fields = ((/^Style: (.*)$/m.exec(toAss([], canvas, style)) as RegExpExecArray)[1] as string).split(",");
    expect(fields[15]).toBe("3"); // BorderStyle
    expect(Number(fields[16])).toBe(12); // Outline = padding
    expect(fields[5]).toBe("&H47000000"); // box colour at 72% opacity
  });

  it("shrinks the font of an event whose widest line would not fit", () => {
    const style = captionStyleById("karaoke-pop") as CaptionStyle;
    const canvas = CANVASES["9:16"] as Canvas;
    const events = layoutCaptions([word("WWWWWWWWWWWWWWWWWWWWWWWW", 0, 1000)], canvas, style);
    expect(dialogues(toAss(events, canvas, style))[0]?.text).toMatch(/\\fs\d/);
    const normal = layoutCaptions([word("hello", 0, 1000)], canvas, style);
    expect(dialogues(toAss(normal, canvas, style))[0]?.text).not.toMatch(/\\fs\d/);
  });
});

// ---- ffmpeg filter ---------------------------------------------------------------------------------------------------

/** ffmpeg's av_get_token: a backslash escapes the next character, single quotes quote everything but a quote; stops at an unquoted, unescaped terminator. */
function getToken(input: string, from: number, terminators: string): { token: string; next: number } {
  let token = "";
  let at = from;
  while (at < input.length && !terminators.includes(input[at] as string)) {
    const char = input[at] as string;
    if (char === "\\" && at + 1 < input.length) {
      token += input[at + 1];
      at += 2;
    } else if (char === "'") {
      at += 1;
      while (at < input.length && input[at] !== "'") token += input[at++];
      at += 1;
    } else {
      token += char;
      at += 1;
    }
  }
  return { token, next: at };
}

/** The two parsing levels a filter description goes through: the graph (filter name, `=`, arguments up to `,;[]`), then the options (`key=value` pairs split at `:`). */
function parseFilter(description: string): { name: string; options: Record<string, string>; rest: string } {
  const name = getToken(description, 0, "=,;[");
  let args = "";
  let next = name.next;
  if (description[next] === "=") {
    const parsed = getToken(description, next + 1, "[],;");
    args = parsed.token;
    next = parsed.next;
  }
  const options: Record<string, string> = {};
  let at = 0;
  while (at < args.length) {
    const key = getToken(args, at, "=:");
    let value = "";
    at = key.next;
    if (args[at] === "=") {
      const parsed = getToken(args, at + 1, ":");
      value = parsed.token;
      at = parsed.next;
    }
    options[key.token] = value;
    if (args[at] === ":") at += 1;
  }
  return { name: name.token, options, rest: description.slice(next) };
}

describe("ffmpeg filter", () => {
  it("builds the plain form for ordinary paths", () => {
    expect(captionFilter("/data/post/s1/captions.ass", "/app/assets/fonts")).toBe("ass=filename='/data/post/s1/captions.ass':fontsdir='/app/assets/fonts'");
  });

  it("escapes quotes, colons and backslashes", () => {
    expect(escapeFilterValue("it's")).toBe("'it\\'\\''s'");
    expect(escapeFilterValue("C:\\dir")).toBe("'C\\:\\\\dir'");
  });

  it("round-trips awkward paths through both parsing levels", () => {
    const awkward = [
      "/plain/path.ass",
      "/with space/and,comma/file.ass",
      "/semi;colon/[brackets]/a=b.ass",
      "/it's/a \"quoted\" dir/x.ass",
      "/colon:in/path:name.ass",
      "C:\\Users\\me\\captions.ass",
      "/trailing\\",
      "/'''/:::/,,,/;;;/[[[]]]/===/\\\\\\/%/ąćę łóż.ass",
    ];
    for (const assPath of awkward) {
      for (const fontsDir of ["/fonts", ...awkward.slice(0, 3)]) {
        const filter = captionFilter(assPath, fontsDir);
        const parsed = parseFilter(filter);
        expect(parsed.name).toBe("ass");
        expect(parsed.rest, filter).toBe("");
        expect(parsed.options, filter).toEqual({ filename: assPath, fontsdir: fontsDir });
      }
    }
  });

  it("can sit in a filter chain", () => {
    const chain = `scale=1080:1920,${captionFilter("/a,b/c.ass", "/f")},format=yuv420p`;
    const afterScale = parseFilter(chain);
    expect(afterScale.name).toBe("scale");
    const second = parseFilter(afterScale.rest.slice(1));
    expect(second.options.filename).toBe("/a,b/c.ass");
    expect(second.rest).toBe(",format=yuv420p");
  });
});

// ---- sidecars --------------------------------------------------------------------------------------------------------

describe("sidecars", () => {
  it("passes the validators on real-looking speech, with and without cuts and speaker names", () => {
    for (const lang of ["en", "pl"] as const) {
      const input = SPEECH[lang];
      const lastEnd = (input[input.length - 1] as TranscriptWord).e;
      for (const removed of [undefined, [{ s: 5000, e: 9000 }, { s: 20_000, e: 26_000 }, { s: 40_000, e: lastEnd - 5000 }]]) {
        for (const speakers of [false, true]) {
          const { srt, vtt } = captionSidecars(input, { removed, speakers, nameOf: (pid) => (pid === "p1" ? "Anna" : "Bartek") });
          expect(validateSrt(srt)).toEqual([]);
          expect(validateVtt(vtt)).toEqual([]);
          if (speakers) {
            expect(srt).toContain("Anna: ");
            expect(vtt).toContain("<v Anna>");
          } else expect(srt).not.toContain("Anna: ");
        }
      }
    }
  });

  it("stays valid when words start at the same time", () => {
    const { srt, vtt } = captionSidecars([word("a", 100, 400), word("b", 100, 300, "p2"), word("c", 120, 500), word("d", 130, 600, "p2")]);
    expect(validateSrt(srt)).toEqual([]);
    expect(validateVtt(vtt)).toEqual([]);
  });

  it("gives an empty SRT and a header-only VTT for no words", () => {
    expect(captionSidecars([])).toEqual({ srt: "", vtt: "WEBVTT\n\n" });
    expect(captionSidecars([word("gone", 100, 200)], { removed: [{ s: 0, e: 1000 }] }).srt).toBe("");
  });
});
