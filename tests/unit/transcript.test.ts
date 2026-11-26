import { describe, expect, it } from "vitest";
import { buildCues, dedupeBleed, duplicateRate, searchWords, timestamp, toSrt, toTxt, toVtt, validateSrt, validateVtt, wrapLines, type TranscriptWord } from "../../src/shared/transcript.js";

const word = (t: string, s: number, e: number, src = "a", pid = "p1"): TranscriptWord => ({ t, s, e, src, pid });

describe("bleed de-duplication", () => {
  const loud = new Int8Array(100).fill(-20);
  const quiet = new Int8Array(100).fill(-45);
  const levels = (src: string) => (src === "a" ? loud : src === "b" ? quiet : null);

  it("keeps the louder copy of a word heard on two tracks", () => {
    const result = dedupeBleed([word("Hello,", 1000, 1300, "a"), word("hello", 1040, 1340, "b", "p2"), word("world.", 1400, 1800, "a")], levels);
    expect(result.dropped).toBe(1);
    expect(result.words.map((w) => w.src)).toEqual(["a", "a"]);
  });

  it("keeps both when the levels are close (real crosstalk) or the words differ", () => {
    const same = (src: string) => (src === "a" || src === "b" ? loud : null);
    expect(dedupeBleed([word("yes", 1000, 1200, "a"), word("yes", 1010, 1210, "b", "p2")], same).dropped).toBe(0);
    expect(dedupeBleed([word("yes", 1000, 1200, "a"), word("no", 1010, 1210, "b", "p2")], levels).dropped).toBe(0);
  });

  it("measures the duplicate rate across tracks", () => {
    expect(duplicateRate([word("a", 0, 100, "x"), word("a", 50, 150, "y", "p2"), word("b", 5000, 5100, "x")])).toBeCloseTo(2 / 3);
    expect(duplicateRate([])).toBe(0);
  });
});

describe("cues and formats", () => {
  const words = [
    word("Hello", 1000, 1400), word("there,", 1450, 1900), word("how", 2000, 2200), word("are", 2250, 2400), word("you?", 2450, 2900),
    word("Fine.", 3500, 3900, "b", "p2"),
    word("Thanks", 9000, 9400, "b", "p2"),
  ];
  const names = (pid: string) => (pid === "p1" ? "Anna" : "Bartek");

  it("makes one cue per speaker turn and splits at long pauses", () => {
    const cues = buildCues(words, names);
    expect(cues.map((cue) => cue.speaker)).toEqual(["Anna", "Bartek", "Bartek"]);
    expect(cues[0]?.lines.join(" ")).toBe("Hello there, how are you?");
    expect(cues[0]?.startMs).toBe(1000);
  });

  it("wraps long text into two balanced lines and refuses text that does not fit", () => {
    const text = "the quick brown fox jumps over the lazy dog again and again".split(" ");
    const lines = wrapLines(text, 42, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines ?? []) expect(line.length).toBeLessThanOrEqual(42);
    expect(wrapLines(Array(30).fill("word"), 42, 2)).toBeNull();
  });

  it("writes SRT and WebVTT that validate", () => {
    const cues = buildCues(words, names);
    const srt = toSrt(cues, true);
    expect(srt).toContain("00:00:01,000 --> 00:00:02,900");
    expect(srt).toContain("Anna: Hello there, how are you?");
    expect(validateSrt(srt)).toEqual([]);
    const vtt = toVtt(cues, true);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("<v Bartek>Fine.");
    expect(validateVtt(vtt)).toEqual([]);
  });

  it("keeps cues apart when two speakers start within a few milliseconds of each other", () => {
    const together = [word("Hello,", 1000, 1500, "a", "p1"), word("hello,", 1040, 1540, "b", "p2"), word("world.", 1600, 2100, "a", "p1"), word("world.", 1640, 2140, "b", "p2")];
    const cues = buildCues(together, names);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.endMs).toBeGreaterThan(cue.startMs);
    expect(validateSrt(toSrt(cues, true))).toEqual([]);
    expect(validateVtt(toVtt(cues, true))).toEqual([]);
  });

  it("detects broken subtitle files", () => {
    expect(validateSrt("1\n00:00:02,000 --> 00:00:01,000\nx\n")).not.toEqual([]);
    expect(validateSrt("2\n00:00:01,000 --> 00:00:02,000\nx\n")).not.toEqual([]);
    expect(validateVtt("00:00:01.000 --> 00:00:02.000\nx")).not.toEqual([]);
  });

  it("formats timestamps and a plain text transcript with turns", () => {
    expect(timestamp(3_723_456, ",")).toBe("01:02:03,456");
    const txt = toTxt(words, names);
    expect(txt).toContain("[00:00:01] Anna: Hello there, how are you?");
    expect(txt).toContain("[00:00:03] Bartek: Fine.");
  });

  it("escapes markup in WebVTT text", () => {
    expect(toVtt([{ startMs: 0, endMs: 1000, speaker: "A", lines: ["a < b & c"] }])).toContain("a &lt; b &amp; c");
  });
});

describe("transcript search", () => {
  const list = ["Hello,", "world.", "Zażółć", "gęślą", "jaźń"].map((t) => ({ t }));
  it("ignores case and punctuation and matches phrases and prefixes", () => {
    expect(searchWords(list, "HELLO")).toEqual([0]);
    expect(searchWords(list, "hello world")).toEqual([0]);
    expect(searchWords(list, "zażółć gęś")).toEqual([2]);
    expect(searchWords(list, "wor")).toEqual([1]);
    expect(searchWords(list, "  ")).toEqual([]);
  });
});
