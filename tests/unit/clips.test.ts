import { describe, expect, it } from "vitest";
import { adjustClip, adjustRange, clipText, clipToEdl, normalizeWords, REASON_TEXT, snapToSentence, snapToWord, splitSentences, suggestClips, wordStep, type ClipSuggestion } from "../../src/shared/clips.js";
import { keptRanges } from "../../src/shared/edl.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";
import { random, script, SPEAKERS, type Line } from "../support/talk.js";

const { A, B } = SPEAKERS;

const STATEMENTS = [
  "The new model reads the whole file before it answers anything.",
  "Most of the time the slow part is the disk and not the network.",
  "We moved the cache next to the database and the latency dropped.",
  "Nobody on the team expected the migration to finish in one night.",
  "The report shows that three of the five regions are growing fast.",
  "She keeps every old version in a folder named after the release.",
  "Our biggest customer asked for a way to export everything at once.",
  "Reading the logs carefully usually shows the real cause of a crash.",
  "The first prototype ran on a laptop and survived the whole demo.",
  "A small change in the scheduler made the whole queue much faster.",
  "They decided to rewrite the importer because the old one was fragile.",
  "Every Monday the team looks at the slowest requests of the week.",
];

const statement = (index: number): string => STATEMENTS[index % STATEMENTS.length] as string;

/** `count` alternating statements, speakers taking turns every sentence. */
function chatter(count: number, offset = 0): Line[] {
  return Array.from({ length: count }, (_, index) => ({ pid: index % 2 === 0 ? A : B, text: statement(index + offset) }));
}

const periodOf = (line: Line): number => (line.gap ?? 600) + line.text.split(/\s+/).length * (line.pace ?? 320);

/** Whether the word starting at `ms` opens a sentence, judged from the words alone (not through splitSentences). */
function startsSentence(words: TranscriptWord[], ms: number): boolean {
  const index = words.findIndex((word) => word.s === ms);
  if (index < 0) return false;
  const word = words[index] as TranscriptWord;
  const previous = words
    .slice(0, index)
    .reverse()
    .find((other) => other.pid === word.pid);
  return previous === undefined || /[.?!…]["')\]]*$/u.test(previous.t) || word.s - previous.e > 1200;
}

/** Whether the word ending at `ms` closes a sentence, judged from the words alone. */
function endsSentenceAt(words: TranscriptWord[], ms: number): boolean {
  const index = words.findLastIndex((word) => word.e === ms);
  if (index < 0) return false;
  const word = words[index] as TranscriptWord;
  const next = words.slice(index + 1).find((other) => other.pid === word.pid);
  return /[.?!…]["')\]]*$/u.test(word.t) || next === undefined || next.s - word.e > 1200;
}

describe("sentences", () => {
  const sentencesOf = (text: string, pid = A): string[] => splitSentences(script([{ pid, text }]).words).map((sentence) => sentence.text);

  it("breaks at . ? ! and … and keeps the punctuation", () => {
    expect(sentencesOf("It works. Does it really? Yes! Maybe… we will see.")).toEqual(["It works.", "Does it really?", "Yes!", "Maybe…", "we will see."]);
  });

  it("breaks at a speaker change and at a pause longer than 1.2 s, but not at a shorter one", () => {
    const lines: Line[] = [
      { pid: A, text: "so we went there and" },
      { pid: A, text: "found the door closed.", gap: 1500 },
      { pid: A, text: "then we left", gap: 300 },
      { pid: B, text: "that was quick.", gap: 100 },
    ];
    expect(splitSentences(script(lines).words).map((sentence) => `${sentence.pid}:${sentence.text}`)).toEqual([`${A}:so we went there and`, `${A}:found the door closed.`, `${A}:then we left`, `${B}:that was quick.`]);
    expect(sentencesOf("one two three")).toEqual(["one two three"]);
  });

  it("does not split at abbreviations, initials, decimals or ordinals", () => {
    expect(sentencesOf("Dr. Smith met Mr. Jones at ten.")).toEqual(["Dr. Smith met Mr. Jones at ten."]);
    expect(sentencesOf("We use tools, e.g. a hammer, for it.")).toEqual(["We use tools, e.g. a hammer, for it."]);
    expect(sentencesOf("Ask J. Kowalski about it.")).toEqual(["Ask J. Kowalski about it."]);
    expect(sentencesOf("Version 3.5 is out. Update now.")).toEqual(["Version 3.5 is out.", "Update now."]);
    // an engine may split a decimal into pieces
    expect(sentencesOf("It costs 3. 5 euros in total.")).toEqual(["It costs 3. 5 euros in total."]);
    expect(sentencesOf("Zajął 15. miejsce w kategorii.")).toEqual(["Zajął 15. miejsce w kategorii."]);
    expect(sentencesOf("Kupiłem np. kawę, mleko itd. oraz chleb.")).toEqual(["Kupiłem np. kawę, mleko itd. oraz chleb."]);
    expect(sentencesOf("Pan prof. Nowak mieszka w ul. Długiej.")).toEqual(["Pan prof. Nowak mieszka w ul. Długiej."]);
  });

  it("splits after an abbreviation when a pause and a capital follow it, and at ordinary words", () => {
    const lines: Line[] = [
      { pid: A, text: "I met them in the U.S." },
      { pid: A, text: "Then we flew home.", gap: 800 },
      { pid: A, text: "It was 9 p.m. sharp." },
    ];
    expect(splitSentences(script(lines).words).map((sentence) => sentence.text)).toEqual(["I met them in the U.S.", "Then we flew home.", "It was 9 p.m. sharp."]);
  });

  it("marks questions and terminal sentences", () => {
    const sentences = splitSentences(script([{ pid: A, text: "Is it done? It is. And then" }]).words);
    expect(sentences.map((sentence) => [sentence.question, sentence.terminal])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
  });

  it("keeps a sentence together when the other speaker says a word in the middle", () => {
    const base = script([{ pid: A, text: "we should ship it before the end of the month, honestly." }]).words;
    const yeah: TranscriptWord = { t: "Yeah.", s: (base[4] as TranscriptWord).s, e: (base[4] as TranscriptWord).e, src: "b", pid: B };
    const sentences = splitSentences([...base.slice(0, 5), yeah, ...base.slice(5)]);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["we should ship it before the end of the month, honestly.", "Yeah."]);
  });

  it("repairs a word the engine stretched over a silence, so the sentence starts where it is spoken", () => {
    const words: TranscriptWord[] = [
      { t: "Before", s: 36_500, e: 48_700, src: "b", pid: B },
      { t: "an", s: 48_700, e: 48_900, src: "b", pid: B },
      { t: "organization", s: 48_900, e: 49_700, src: "b", pid: B },
      { t: "grows.", s: 49_700, e: 50_200, src: "b", pid: B },
    ];
    const [sentence] = splitSentences(words);
    expect(sentence?.s).toBe(48_700 - (450 + 110 * "Before".length));
    expect(sentence?.e).toBe(50_200);
    expect(normalizeWords(words).every((word) => word.e - word.s < 1500)).toBe(true);
  });

  it("cuts a very long run without punctuation at its longest pause", () => {
    const lines: Line[] = Array.from({ length: 6 }, (_, index) => ({ pid: A, text: "and this goes on and on and on without any stop at all", gap: index === 3 ? 700 : 80 }));
    const sentences = splitSentences(script(lines).words);
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every((sentence) => sentence.e - sentence.s <= 25_000)).toBe(true);
    expect(sentences.every((sentence) => !sentence.terminal)).toBe(true);
  });

  it("handles Polish text and empty input", () => {
    expect(sentencesOf("Ona wiedziała, że to prawda. Czy ty też? Tak.", B)).toEqual(["Ona wiedziała, że to prawda.", "Czy ty też?", "Tak."]);
    expect(splitSentences([])).toEqual([]);
  });
});

describe("clip suggestions", () => {
  it("returns clips of 20-90 s that start and end on sentence boundaries, with reasons and no heavy overlap", () => {
    const { words, endMs } = script(chatter(70));
    const clips = suggestClips({ words, durationMs: endMs, limit: 6 });
    expect(clips.length).toBeGreaterThan(2);
    expect(clips.length).toBeLessThanOrEqual(6);
    for (const clip of clips) {
      expect(clip.e - clip.s).toBeGreaterThanOrEqual(20_000);
      expect(clip.e - clip.s).toBeLessThanOrEqual(90_000);
      expect(startsSentence(words, clip.s)).toBe(true);
      expect(endsSentenceAt(words, clip.e)).toBe(true);
      expect(clip.reasons.length).toBeGreaterThanOrEqual(1);
      expect(clip.title.length).toBeGreaterThan(0);
      expect(clip.title.length).toBeLessThanOrEqual(70);
      expect(clip.speakers).toEqual(expect.arrayContaining([A, B]));
      expect(clip.id).toBe(`clip-${clip.s}-${clip.e}`);
    }
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i] as ClipSuggestion;
        const b = clips[j] as ClipSuggestion;
        const overlap = Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
        expect(overlap).toBeLessThanOrEqual(0.2 * Math.min(a.e - a.s, b.e - b.s));
      }
    }
    expect([...clips].sort((a, b) => b.score - a.score)).toEqual(clips);
  });

  it("is deterministic, whatever the order of the words", () => {
    const { words, endMs } = script(chatter(60));
    const first = suggestClips({ words, durationMs: endMs });
    expect(suggestClips({ words, durationMs: endMs })).toEqual(first);
    expect(suggestClips({ words: [...words].reverse(), durationMs: endMs })).toEqual(first);
  });

  it("puts a question with its answer first", () => {
    const lines = chatter(70);
    lines[34] = { pid: A, text: "Why did the first version fail so badly in production?" };
    lines[35] = { pid: B, text: "Because nobody tested it with real recordings, only with clean samples." };
    const { words, endMs } = script(lines);
    const [top] = suggestClips({ words, durationMs: endMs, limit: 1 });
    const questionAt = (words.find((word) => word.t === "Why") as TranscriptWord).s;
    expect(top?.reasons).toContain("question-answer");
    expect(top?.s).toBeLessThanOrEqual(questionAt);
    expect(top?.e).toBeGreaterThan(questionAt + 6000);
  });

  it("does not count a question that the same speaker answers, or a reaction, as question and answer", () => {
    const lines = chatter(70);
    lines[34] = { pid: A, text: "Why did the first version fail so badly in production?" };
    lines[35] = { pid: B, text: "Yeah." };
    const { words, endMs } = script(lines);
    expect(suggestClips({ words, durationMs: endMs }).some((clip) => clip.reasons.includes("question-answer"))).toBe(false);
  });

  it("gives a window with a flagged moment a strong bonus", () => {
    const { words, endMs } = script(chatter(70));
    const at = 150_000;
    const clips = suggestClips({ words, durationMs: endMs, highlights: [{ tMs: at }], limit: 3 });
    expect(clips[0]?.reasons[0]).toBe("marker");
    expect(clips[0]?.s).toBeLessThanOrEqual(at);
    expect(clips[0]?.e).toBeGreaterThanOrEqual(at);
    expect(clips.filter((clip) => clip.reasons.includes("marker")).length).toBeGreaterThanOrEqual(1);
    expect(suggestClips({ words, durationMs: endMs, limit: 3 }).some((clip) => clip.reasons.includes("marker"))).toBe(false);
  });

  it("prefers the loud stretch when levels are given, and names it", () => {
    const { words, endMs } = script(chatter(70));
    const frames = Math.ceil(endMs / 20);
    const levels = new Int8Array(frames).fill(-38);
    levels.fill(-18, Math.floor(120_000 / 20), Math.floor(190_000 / 20));
    const clips = suggestClips({
      words,
      levels: [
        { pid: A, levels },
        { pid: B, levels },
      ],
      durationMs: endMs,
      limit: 1,
    });
    const [top] = clips;
    expect(top?.reasons).toContain("high-energy");
    expect(top?.s).toBeGreaterThanOrEqual(115_000);
    expect(top?.e).toBeLessThanOrEqual(195_000);
  });

  it("works without levels (energy left out) and with levels of one speaker only", () => {
    const { words, endMs } = script(chatter(50));
    const frames = Math.ceil(endMs / 20);
    expect(suggestClips({ words, durationMs: endMs }).length).toBeGreaterThan(0);
    expect(suggestClips({ words, levels: [{ pid: A, levels: new Int8Array(frames).fill(-30) }], durationMs: endMs }).length).toBeGreaterThan(0);
  });

  it("avoids a stretch with long pauses and a stretch of one-word reactions", () => {
    const reactions: Line[] = ["Yeah.", "Mhm.", "Right.", "Okay.", "Sure.", "Yeah.", "Mhm.", "Right.", "Okay.", "Sure.", "Yeah.", "Mhm.", "Right.", "Okay.", "Sure.", "Yeah.", "Mhm."].map((text, index) => ({ pid: index % 2 === 0 ? A : B, text, gap: 1100, pace: 450 }));
    const sparse: Line[] = chatter(18).map((line) => ({ ...line, gap: 6500 }));
    const dense: Line[] = chatter(30, 5).map((line) => ({ ...line, gap: 350 }));
    const lines = [...reactions, ...sparse, ...dense];
    const { words, endMs } = script(lines);
    const reactionEnd = 1000 + reactions.reduce((sum, line) => sum + periodOf(line), 0);
    const denseStart = 1000 + [...reactions, ...sparse].reduce((sum, line) => sum + periodOf(line), 0);
    const clips = suggestClips({ words, durationMs: endMs, limit: 3 });
    expect(clips[0]?.s).toBeGreaterThanOrEqual(denseStart - 1);
    expect(clips.every((clip) => clip.e > reactionEnd)).toBe(true);
  });

  it("does not start a clip with a connective when another start is as good", () => {
    // five sentences of ten words: a window of four lasts 17.4 s, so only [0..3] and [1..4] fit between 16 and 20 s
    const base: Line[] = Array.from({ length: 5 }, (_, index) => ({ pid: index % 2 === 0 ? A : B, text: `${statement(index).split(" ").slice(0, 10).join(" ")}.`.replace(/\.\.$/, "."), gap: 1000, pace: 360 }));
    const withConnective = (index: number, first: string): Line[] => base.map((line, at) => (at === index ? { ...line, text: `${first} ${line.text.charAt(0).toLowerCase()}${line.text.slice(1)}` } : line));
    for (const [first, lang] of [
      ["But", "en"],
      ["Ale", "pl"],
      ["I", "pl"],
    ] as const) {
      const second = script(withConnective(1, first));
      const [clip] = suggestClips({ words: second.words, durationMs: second.endMs, minMs: 16_000, maxMs: 20_000, limit: 1 }, { lang });
      expect(clip?.s).toBe((second.words[0] as TranscriptWord).s);
      const swapped = script(withConnective(0, first));
      const [other] = suggestClips({ words: swapped.words, durationMs: swapped.endMs, minMs: 16_000, maxMs: 20_000, limit: 1 }, { lang });
      expect(other?.s).toBeGreaterThan((swapped.words[0] as TranscriptWord).s);
    }
    // the English pronoun "I" is not a connective
    const pronoun = script(withConnective(0, "I"));
    const [kept] = suggestClips({ words: pronoun.words, durationMs: pronoun.endMs, minMs: 16_000, maxMs: 20_000, limit: 1 }, { lang: "en" });
    expect(kept?.s).toBe((pronoun.words[0] as TranscriptWord).s);
  });

  it("prefers an edge that does not cut through a sentence of someone else", () => {
    // five 4 s sentences; the last one starts 1.5 s before the fourth ends (an interruption), so a clip ending on the fourth cuts it
    const base: Line[] = Array.from({ length: 5 }, (_, index) => ({ pid: index % 2 === 0 ? A : B, text: statement(index).split(" ").slice(0, 10).join(" ").concat("."), gap: 1000, pace: 400 }));
    const { words } = script(base);
    const fourthEnd = (words[39] as TranscriptWord).e;
    const shift = (words[40] as TranscriptWord).s - (fourthEnd - 1500);
    const interrupted = words.map((word, index) => (index >= 40 ? { ...word, s: word.s - shift, e: word.e - shift } : word));
    const endMs = (interrupted[49] as TranscriptWord).e;
    const [clip] = suggestClips({ words: interrupted, durationMs: endMs, minMs: 16_000, maxMs: 21_000, limit: 1 }, { lang: "en" });
    expect(clip?.s).toBe((interrupted[10] as TranscriptWord).s);
    expect(clip?.e).toBe(endMs);
    // without the interruption the earlier window wins the tie
    const [plain] = suggestClips({ words, durationMs: (words[49] as TranscriptWord).e, minMs: 16_000, maxMs: 21_000, limit: 1 }, { lang: "en" });
    expect(plain?.s).toBe((words[0] as TranscriptWord).s);
  });

  it("returns nothing for a recording shorter than the minimum, or without words", () => {
    const { words, endMs } = script(chatter(3));
    expect(suggestClips({ words, durationMs: endMs })).toEqual([]);
    expect(suggestClips({ words: [], durationMs: 60_000 })).toEqual([]);
    expect(suggestClips({ words, durationMs: endMs, limit: 0 })).toEqual([]);
  });

  it("honours the length and limit options", () => {
    const { words, endMs } = script(chatter(120));
    const clips = suggestClips({ words, durationMs: endMs, minMs: 30_000, maxMs: 40_000, limit: 4 });
    expect(clips).toHaveLength(4);
    for (const clip of clips) {
      expect(clip.e - clip.s).toBeGreaterThanOrEqual(30_000);
      expect(clip.e - clip.s).toBeLessThanOrEqual(40_000);
    }
  });

  it("keeps every suggestion on sentence boundaries over random conversations", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const next = random(seed);
      const lines: Line[] = [];
      let speaker = A;
      for (let i = 0; i < 160; i++) {
        if (next() < 0.55) speaker = speaker === A ? B : A;
        const count = 3 + Math.floor(next() * 22);
        const tokens = Array.from({ length: count }, (_, k) => `w${Math.floor(next() * 900)}${k % 7 === 0 ? "," : ""}`);
        const mark = next();
        const last = `${(tokens.pop() as string).replace(/,$/, "")}${mark < 0.7 ? "." : mark < 0.9 ? "?" : "!"}`;
        lines.push({ pid: speaker, text: [...tokens, last].join(" "), gap: 150 + Math.floor(next() * 2400), pace: 180 + Math.floor(next() * 300) });
      }
      const { words, endMs } = script(lines);
      const highlights = [{ tMs: Math.floor(next() * endMs) }, { tMs: Math.floor(next() * endMs) }];
      const clips = suggestClips({ words, highlights, durationMs: endMs });
      expect(clips.length).toBeGreaterThan(0);
      for (const clip of clips) {
        expect(startsSentence(words, clip.s)).toBe(true);
        expect(endsSentenceAt(words, clip.e)).toBe(true);
        expect(clip.reasons.length).toBeGreaterThanOrEqual(1);
        expect(clip.reasons.every((reason) => REASON_TEXT[reason] !== undefined)).toBe(true);
      }
    }
  });

  it("handles a three-hour recording quickly", () => {
    const { words, endMs } = script(chatter(2800).map((line) => ({ ...line, gap: 2500 })));
    const started = performance.now();
    const clips = suggestClips({ words, durationMs: endMs });
    expect(clips).toHaveLength(10);
    expect(performance.now() - started).toBeLessThan(8000);
  });

  it("describes every reason in English and Polish", () => {
    for (const [key, text] of Object.entries(REASON_TEXT)) {
      expect(key).toMatch(/^[a-z-]+$/);
      expect(text.en.length).toBeGreaterThan(5);
      expect(text.pl.length).toBeGreaterThan(5);
    }
  });
});

describe("clips as projects", () => {
  it("makes an EDL that keeps only the clip", () => {
    const edl = clipToEdl({ s: 30_000, e: 60_000 }, 120_000);
    expect(edl.removed).toEqual([
      { s: 0, e: 30_000 },
      { s: 60_000, e: 120_000 },
    ]);
    expect(keptRanges(edl, 120_000)).toEqual([{ s: 30_000, e: 60_000 }]);
    expect(clipToEdl({ s: 0, e: 120_000 }, 120_000).removed).toEqual([]);
  });

  const { words } = script(chatter(30));
  const sentences = splitSentences(words);

  it("snaps a time to the nearest sentence start or end", () => {
    const second = sentences[1] as { s: number; e: number };
    expect(snapToSentence(words, second.s + 400, "start")).toBe(second.s);
    expect(snapToSentence(words, second.e - 400, "end")).toBe(second.e);
    expect(snapToSentence([], 1234, "start")).toBe(1234);
  });

  it("snaps to the nearest word start or end", () => {
    const word = words[7] as TranscriptWord;
    expect(snapToWord(words, word.s + 50, "start")).toBe(word.s);
    expect(snapToWord(words, word.e - 50, "end")).toBe(word.e);
  });

  it("moves in and out points to word boundaries and keeps at least a second", () => {
    const first = sentences[2] as { s: number; e: number };
    const range = { s: first.s, e: (sentences[8] as { e: number }).e };
    const word = words[40] as TranscriptWord;
    const moved = adjustRange(range, words, { sMs: word.s + 90, eMs: range.e - 700 });
    expect(words.some((candidate) => candidate.s === moved.s)).toBe(true);
    expect(words.some((candidate) => candidate.e === moved.e)).toBe(true);
    expect(adjustRange(range, words, {})).toEqual(range);
    const crossed = adjustRange(range, words, { sMs: range.e + 5000 });
    expect(crossed.e).toBe(range.e);
    expect(crossed.e - crossed.s).toBeGreaterThanOrEqual(1000);
    expect(adjustRange(range, [], { sMs: 5 })).toEqual(range);
  });

  it("steps an in or out point word by word and stops at the ends of the transcript", () => {
    const clean = normalizeWords(words);
    const range = { s: (clean[10] as TranscriptWord).s, e: (clean[30] as TranscriptWord).e };
    expect(wordStep(range, words, "s", -1)).toEqual({ sMs: (clean[9] as TranscriptWord).s });
    expect(wordStep(range, words, "s", 2)).toEqual({ sMs: (clean[12] as TranscriptWord).s });
    expect(wordStep(range, words, "e", -1)).toEqual({ eMs: (clean[29] as TranscriptWord).e });
    expect(wordStep(range, words, "e", 1)).toEqual({ eMs: (clean[31] as TranscriptWord).e });
    expect(wordStep({ s: (clean[0] as TranscriptWord).s, e: range.e }, words, "s", -1)).toEqual({ sMs: (clean[0] as TranscriptWord).s });
    const last = clean[clean.length - 1] as TranscriptWord;
    expect(wordStep({ s: range.s, e: last.e }, words, "e", 1)).toEqual({ eMs: last.e });
    expect(wordStep(range, [], "e", 1)).toEqual({ eMs: range.e });
    // the step goes through adjustRange like any other change
    const next = adjustRange(range, words, wordStep(range, words, "s", 1));
    expect(next.s).toBe((clean[11] as TranscriptWord).s);
    expect(next.e).toBe(range.e);
  });

  it("keeps the score and reasons of an adjusted suggestion and follows the new range with title and speakers", () => {
    const clips = suggestClips({ words: script(chatter(70)).words, durationMs: 400_000, limit: 1 });
    const clip = clips[0] as ClipSuggestion;
    const later = splitSentences(script(chatter(70)).words).find((sentence) => sentence.s > clip.s + 5000) as { s: number };
    const adjusted = adjustClip(clip, script(chatter(70)).words, { sMs: later.s });
    expect(adjusted.s).toBe(later.s);
    expect(adjusted.e).toBe(clip.e);
    expect(adjusted.score).toBe(clip.score);
    expect(adjusted.reasons).toEqual(clip.reasons);
    expect(adjusted.id).toBe(`clip-${adjusted.s}-${adjusted.e}`);
    expect(adjusted.title).not.toBe("");
  });

  it("writes the text of a clip as one line per turn", () => {
    const text = clipText(words, { s: 0, e: 12_000 }, (pid) => (pid === A ? "Anna" : "Bartek"));
    expect(text.split("\n").every((line) => /^(Anna|Bartek): /.test(line))).toBe(true);
    expect(text).toContain(statement(0));
  });
});
