import { describe, expect, it } from "vitest";
import { chapterTime, chapterTitles, chaptersForYoutube, formatChapters, segmentTopics, topKeywords, validateChapters, wordsThroughEdl, type Chapter } from "../../src/shared/chapters.js";
import { keptDuration, normalize, type Edl } from "../../src/shared/edl.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";
import { random, script, SPEAKERS, type Line } from "../support/talk.js";

const { A, B } = SPEAKERS;

interface Pools {
  nouns: string[];
  verbs: string[];
  /** Sentence frames with the slots N1..N3 and V; only stop words besides the slots. */
  frames: string[];
}

const EN_TOPICS: Pools[] = [
  { nouns: ["satellite", "phone", "antenna", "signal", "orbit", "coverage", "network", "receiver"], verbs: ["tracks", "reaches", "loses", "boosts"], frames: ["The N1 and the N2 of that N3 V the N1.", "With the N2 the N3 V all of the N1 and the N2.", "Only the N1 V that N2 with the N3."] },
  { nouns: ["pasta", "sauce", "oven", "garlic", "butter", "kitchen", "recipe", "pepper"], verbs: ["melts", "needs", "soaks", "absorbs"], frames: ["The N1 and the N2 of that N3 V the N1.", "With the N2 the N3 V all of the N1 and the N2.", "Only the N1 V that N2 with the N3."] },
  { nouns: ["football", "goal", "referee", "stadium", "keeper", "penalty", "season", "defender"], verbs: ["scores", "blocks", "wins", "misses"], frames: ["The N1 and the N2 of that N3 V the N1.", "With the N2 the N3 V all of the N1 and the N2.", "Only the N1 V that N2 with the N3."] },
];

const PL_TOPICS: Pools[] = [
  { nouns: ["satelita", "satelity", "satelitą", "telefon", "telefonu", "antena", "anteny", "sygnał", "sygnału", "zasięg", "zasięgu"], verbs: ["łapie", "traci", "wzmacnia"], frames: ["N1 oraz N2 dla N3 V N1.", "Przez N2 oraz N3 V wszystkie N1 oraz N2.", "Tylko N1 V ten N2 przez N3."] },
  { nouns: ["makaron", "makaronu", "sos", "sosem", "piekarnik", "piekarniku", "czosnek", "czosnku", "masło", "masła", "kuchnia"], verbs: ["topi", "wchłania", "potrzebuje"], frames: ["N1 oraz N2 dla N3 V N1.", "Przez N2 oraz N3 V wszystkie N1 oraz N2.", "Tylko N1 V ten N2 przez N3."] },
  { nouns: ["piłka", "piłki", "bramka", "bramkę", "sędzia", "sędziego", "stadion", "stadionie", "bramkarz", "bramkarza", "obrońca"], verbs: ["strzela", "broni", "wygrywa"], frames: ["N1 oraz N2 dla N3 V N1.", "Przez N2 oraz N3 V wszystkie N1 oraz N2.", "Tylko N1 V ten N2 przez N3."] },
];

function topicLines(pools: Pools, count: number, next: () => number): Line[] {
  const pick = (list: string[]): string => list[Math.floor(next() * list.length)] as string;
  return Array.from({ length: count }, (_, index) => {
    const frame = pools.frames[Math.floor(next() * pools.frames.length)] as string;
    const text = frame.replace(/N1/g, () => pick(pools.nouns)).replace(/N2/g, () => pick(pools.nouns)).replace(/N3/g, () => pick(pools.nouns)).replace(/\bV\b/g, () => pick(pools.verbs));
    return { pid: index % 2 === 0 ? A : B, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}`, gap: 700 };
  });
}

/** Three topics of `perTopic` sentences each; returns the words, the end and the start of each topic. */
function talk(topics: Pools[], perTopic: number, seed = 7): { words: TranscriptWord[]; endMs: number; starts: number[]; nouns: string[][] } {
  const next = random(seed);
  const lines: Line[] = [];
  const starts: number[] = [];
  let at = 1000;
  for (const pools of topics) {
    starts.push(at);
    const part = topicLines(pools, perTopic, next);
    lines.push(...part);
    at += part.reduce((sum, line) => sum + (line.gap ?? 600) + line.text.split(" ").length * 320, 0);
  }
  const { words, endMs } = script(lines);
  return { words, endMs, starts, nouns: topics.map((pools) => pools.nouns.map((noun) => noun.toLowerCase())) };
}

describe("topic segmentation", () => {
  for (const [name, topics] of [
    ["English", EN_TOPICS],
    ["Polish", PL_TOPICS],
  ] as const) {
    it(`finds the topic changes of an ${name} talk`, () => {
      const { words, endMs, starts } = talk(topics, 45);
      const result = segmentTopics(words, endMs);
      expect(result).toHaveLength(3);
      expect(result[0]?.s).toBe(0);
      expect(result[2]?.e).toBe(endMs);
      for (let k = 1; k < 3; k++) expect(Math.abs((result[k]?.s as number) - (starts[k] as number))).toBeLessThan(12_000);
      // a topic starts where the previous one ends
      expect(result[1]?.s).toBe(result[0]?.e);
      expect(result[2]?.s).toBe(result[1]?.e);
    });
  }

  it("puts boundaries on sentence starts", () => {
    const { words, endMs } = talk(EN_TOPICS, 45);
    const sentenceStarts = new Set(words.filter((word) => /^[A-Z]/.test(word.t)).map((word) => word.s));
    for (const topic of segmentTopics(words, endMs).slice(1)) expect(sentenceStarts.has(topic.s)).toBe(true);
  });

  it("keeps every topic at least minChapterMs long and honours maxChapters", () => {
    const { words, endMs } = talk([...EN_TOPICS, ...EN_TOPICS, ...EN_TOPICS], 30, 3);
    const topics = segmentTopics(words, endMs, { minChapterMs: 90_000 });
    for (const topic of topics) expect(topic.e - topic.s).toBeGreaterThanOrEqual(90_000);
    expect(segmentTopics(words, endMs, { minChapterMs: 30_000, maxChapters: 4 }).length).toBeLessThanOrEqual(4);
    expect(segmentTopics(words, endMs, { maxChapters: 1 })).toEqual([{ s: 0, e: endMs }]);
  });

  it("returns one topic for a recording that is too short or has nothing to split", () => {
    expect(segmentTopics([], 600_000)).toEqual([{ s: 0, e: 600_000 }]);
    const { words, endMs } = talk(EN_TOPICS.slice(0, 1), 8);
    expect(segmentTopics(words, endMs)).toEqual([{ s: 0, e: endMs }]);
    const { words: one, endMs: oneEnd } = talk(EN_TOPICS.slice(0, 1), 80);
    expect(segmentTopics(one, oneEnd)).toHaveLength(1);
  });

  it("is deterministic", () => {
    const { words, endMs } = talk(PL_TOPICS, 40);
    expect(segmentTopics(words, endMs)).toEqual(segmentTopics([...words].reverse(), endMs));
  });
});

describe("titles", () => {
  it("names a topic after its characteristic words, in the transcript's language", () => {
    for (const topics of [EN_TOPICS, PL_TOPICS]) {
      const { words, endMs, nouns } = talk(topics, 45);
      const parts = segmentTopics(words, endMs);
      parts.forEach((part, index) => {
        const title = chapterTitles(part, words, { index }).toLowerCase();
        expect(title.length).toBeGreaterThan(3);
        expect(title.length).toBeLessThanOrEqual(60);
        const stems = (nouns[index] as string[]).map((noun) => noun.slice(0, 4));
        expect(stems.some((stem) => title.includes(stem))).toBe(true);
      });
    }
  });

  it("starts with a capital and contains no stop words", () => {
    const { words, endMs } = talk(EN_TOPICS, 45);
    const title = chapterTitles({ s: 0, e: endMs }, words);
    expect(title).toMatch(/^[A-Z]/);
    expect(title.toLowerCase()).not.toMatch(/\b(the|and|that|with|of)\b/);
  });

  it("falls back to a numbered title when the stretch has no words", () => {
    const { words } = talk(EN_TOPICS.slice(0, 1), 10);
    expect(chapterTitles({ s: 900_000, e: 960_000 }, words, { index: 2, lang: "en" })).toBe("Part 3");
    expect(chapterTitles({ s: 900_000, e: 960_000 }, words, { index: 0, lang: "pl" })).toBe("Część 1");
  });

  it("ranks the words of the whole talk", () => {
    const { words } = talk(EN_TOPICS.slice(0, 1), 40);
    const keywords = topKeywords(words, 4);
    expect(keywords).toHaveLength(4);
    expect(keywords[0]?.score).toBeGreaterThanOrEqual(keywords[3]?.score as number);
    expect(topKeywords([], 5)).toEqual([]);
  });
});

describe("YouTube chapter rules", () => {
  const ok: Chapter[] = [
    { startMs: 0, title: "Intro" },
    { startMs: 60_000, title: "Middle" },
    { startMs: 130_000, title: "End" },
  ];

  it("accepts a valid list", () => {
    expect(validateChapters(ok, 200_000)).toEqual({ ok: true, errors: [], issues: [] });
  });

  it("reports each broken rule", () => {
    const first = (chapters: Chapter[], duration = 200_000): string[] => validateChapters(chapters, duration).errors;
    expect(first([{ startMs: 1000, title: "a" }, ...ok.slice(1)]).join()).toMatch(/00:00/);
    expect(first(ok.slice(0, 2)).join()).toMatch(/at least 3/);
    expect(first([]).join()).toMatch(/at least 3/);
    expect(first([ok[0] as Chapter, { startMs: 80_000, title: "b" }, { startMs: 70_000, title: "c" }]).join()).toMatch(/does not start after/);
    expect(first([ok[0] as Chapter, { startMs: 5000, title: "b" }, { startMs: 70_000, title: "c" }]).join()).toMatch(/less than 10 s apart/);
    expect(first([ok[0] as Chapter, { startMs: 9999, title: "b" }, { startMs: 70_000, title: "c" }]).join()).toMatch(/less than 10 s apart/);
    expect(first(ok, 135_000).join()).toMatch(/last chapter/);
    expect(first([{ startMs: 0, title: "a" }, { startMs: 20_000, title: " " }, { startMs: 60_000, title: "c" }]).join()).toMatch(/no title/);
    expect(validateChapters(ok, 140_000).ok).toBe(true);
  });

  it("lists the same problems as codes a screen can translate", () => {
    const issues = (chapters: Chapter[], duration = 200_000): unknown[] => validateChapters(chapters, duration).issues;
    expect(issues(ok.slice(0, 2))).toEqual([{ code: "too-few", count: 2 }]);
    expect(issues([{ startMs: 1000, title: "a" }, ...ok.slice(1)])).toEqual([{ code: "first-not-zero" }]);
    expect(issues([ok[0] as Chapter, { startMs: 80_000, title: "b" }, { startMs: 70_000, title: "c" }])).toEqual([{ code: "not-ascending", chapter: 3 }]);
    expect(issues([ok[0] as Chapter, { startMs: 5000, title: "b" }, { startMs: 70_000, title: "c" }])).toEqual([{ code: "too-close", chapter: 2 }]);
    expect(issues(ok, 135_000)).toEqual([{ code: "last-too-short" }]);
    expect(issues([{ startMs: 0, title: "a" }, { startMs: 20_000, title: " " }, { startMs: 60_000, title: "c" }])).toEqual([{ code: "no-title", chapter: 2 }]);
    expect(validateChapters(ok.slice(0, 2), 200_000).errors).toEqual(["needs at least 3 chapters, got 2"]);
  });

  it("measures the gaps in whole seconds, as they are written", () => {
    // 10.9 s after 0.2 s is 10 s apart once written (00:00 and 00:10)
    expect(validateChapters([{ startMs: 200, title: "a" }, { startMs: 10_900, title: "b" }, { startMs: 30_000, title: "c" }], 60_000).ok).toBe(true);
    expect(validateChapters([{ startMs: 0, title: "a" }, { startMs: 9_900, title: "b" }, { startMs: 30_000, title: "c" }], 60_000).ok).toBe(false);
  });

  it("formats lines as 00:00 Title, with hours once past an hour", () => {
    expect(formatChapters(ok)).toBe("00:00 Intro\n01:00 Middle\n02:10 End");
    expect(formatChapters([{ startMs: 0, title: "A" }, { startMs: 3_599_999, title: "B" }, { startMs: 3_600_000, title: "C" }, { startMs: 4_322_000, title: "  D\n E " }])).toBe("00:00 A\n59:59 B\n1:00:00 C\n1:12:02 D E");
    expect(chapterTime(-5)).toBe("00:00");
  });
});

describe("chapters for YouTube", () => {
  it("returns a valid list for a talk, with and without an EDL", () => {
    const { words, endMs } = talk(EN_TOPICS, 45);
    const plain = chaptersForYoutube(words, endMs);
    expect(validateChapters(plain, endMs)).toEqual({ ok: true, errors: [], issues: [] });
    expect(plain).toHaveLength(3);
    expect(plain.every((chapter) => chapter.startMs % 1000 === 0)).toBe(true);

    const edl: Edl = { removed: normalize([{ s: 100_000, e: 150_000 }, { s: 300_000, e: 320_000 }], endMs) };
    const cut = chaptersForYoutube(words, endMs, edl);
    const outputMs = keptDuration(edl, endMs);
    expect(validateChapters(cut, outputMs)).toEqual({ ok: true, errors: [], issues: [] });
    expect(cut.at(-1)?.startMs as number).toBeLessThanOrEqual(outputMs - 10_000);
    // the topics keep their order and titles; later chapters moved earlier by the cuts
    expect(cut.map((chapter) => chapter.title)).toHaveLength(cut.length);
    expect(cut[1]?.startMs as number).toBeLessThan(plain[1]?.startMs as number);
  });

  it("does not let material that was cut shape the chapters", () => {
    const first = talk(EN_TOPICS.slice(0, 2), 40, 5);
    const second = talk(EN_TOPICS.slice(2), 40, 6);
    const shift = first.endMs;
    const words = [...first.words, ...second.words.map((word) => ({ ...word, s: word.s + shift, e: word.e + shift }))];
    const duration = first.endMs + second.endMs;
    // cut out the whole second half of the talk's first two topics
    const edl: Edl = { removed: normalize([{ s: first.starts[1] as number, e: shift }], duration) };
    expect(wordsThroughEdl(words, edl).length).toBeLessThan(words.length);
    const chapters = chaptersForYoutube(words, duration, edl);
    expect(validateChapters(chapters, keptDuration(edl, duration)).ok).toBe(true);
    expect(chapters.map((chapter) => chapter.title.toLowerCase()).join(" ")).not.toMatch(/pasta|sauce|oven/);
  });

  it("pads with even splits when the transcript offers fewer than three chapters", () => {
    expect(chaptersForYoutube([], 100_000)).toEqual([
      { startMs: 0, title: "Part 1" },
      { startMs: 33_000, title: "Part 2" },
      { startMs: 66_000, title: "Part 3" },
    ]);
    const { words, endMs } = talk(EN_TOPICS.slice(0, 1), 40);
    const chapters = chaptersForYoutube(words, endMs);
    expect(chapters).toHaveLength(3);
    expect(validateChapters(chapters, endMs).ok).toBe(true);
    expect(chapters[0]?.title).toMatch(/satell|phone|antenna|signal|orbit|coverage|network|receiver/i);
  });

  it("gives an empty list for a video that cannot hold three 10-second chapters", () => {
    expect(chaptersForYoutube([], 29_999)).toEqual([]);
    expect(chaptersForYoutube([], 30_000)).toHaveLength(3);
    const { words, endMs } = talk(EN_TOPICS, 45);
    expect(chaptersForYoutube(words, endMs, { removed: [{ s: 20_000, e: endMs }] })).toEqual([]);
  });

  it("validates for every duration, cut and transcript tried", () => {
    const next = random(11);
    const durations = [30_000, 30_999, 31_000, 39_000, 40_000, 59_999, 60_000, 61_000, 95_000, 125_000, 600_000, 3_599_000, 3_600_000, 7_300_000];
    for (const duration of durations) {
      const cuts: Edl[] = [{ removed: [] }, { removed: normalize([{ s: 0, e: 10_000 }], duration) }, { removed: normalize([{ s: duration * 0.25, e: duration * 0.75 }], duration) }, { removed: normalize([{ s: duration - 12_000, e: duration }], duration) }];
      for (const edl of cuts) {
        const outputMs = keptDuration(edl, duration);
        const lines: Line[] = Array.from({ length: Math.min(400, Math.floor(duration / 6000)) }, (_, index) => ({ pid: index % 2 === 0 ? A : B, text: `${EN_TOPICS[Math.floor(next() * 3)]?.nouns[Math.floor(next() * 8)]} keeps the ${EN_TOPICS[Math.floor(next() * 3)]?.nouns[Math.floor(next() * 8)]} near that place.`, gap: 5500 }));
        const { words } = script(lines);
        for (const input of [[], words]) {
          const chapters = chaptersForYoutube(input, duration, edl);
          if (outputMs < 30_000) expect(chapters).toEqual([]);
          else expect(validateChapters(chapters, outputMs), `${duration} ${JSON.stringify(edl.removed)}`).toEqual({ ok: true, errors: [], issues: [] });
        }
      }
    }
  });
});

describe("filler words in keyword titles", () => {
  it("never make a Polish chapter title out of chatter at the start of a recording", () => {
    const text = "Noo dobra no noo dobra. Dobra noo, włączyłem nagrywanie, noo dobra. Włączyłem nagrywanie i wiesz, dobra, noo.";
    const words: TranscriptWord[] = text.split(" ").map((t, i) => ({ t, s: i * 400, e: i * 400 + 300, src: "s", pid: "a" }));
    const title = chapterTitles({ s: 0, e: words.length * 400 }, words, { lang: "pl" }).toLowerCase();
    expect(title).not.toMatch(/\b(noo?|dobra|wiesz)\b/u);
    expect(title).toContain("nagrywani");
  });
});
