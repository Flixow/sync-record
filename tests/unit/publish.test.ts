import { describe, expect, it } from "vitest";
import { chaptersForYoutube, formatChapters, type Chapter } from "../../src/shared/chapters.js";
import { splitSentences } from "../../src/shared/clips.js";
import { assembleDescription, buildTags, draftTitleAndDescription, overlayTextLayout, summarySentences, thumbnailCandidates, thumbnailSpec } from "../../src/shared/publish.js";
import { insideRect, safeArea } from "../../src/shared/safe-area.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const { A, B } = SPEAKERS;

const EN = [
  "The satellite phone needs a clear view of the sky to find the satellite.",
  "Why does the call travel all the way up to the satellite and back down?",
  "Because the phone cannot reach a normal tower when you are in the middle of an ocean.",
  "Coverage of the satellite network is global, but the phone must stay outdoors.",
  "Yeah.",
  "The antenna points to the sky and the signal returns through the ground station.",
  "Batteries last longer when the screen stays dark during the whole expedition.",
  "Our guide carried two spare batteries and a small solar panel in the backpack.",
];

const PL = [
  "Telefon satelitarny potrzebuje czystego widoku nieba, żeby znaleźć satelitę.",
  "Dlaczego połączenie leci aż do satelity i z powrotem na ziemię?",
  "Ponieważ zwykły telefon nie złapie wieży na środku oceanu podczas rejsu.",
  "Zasięg sieci satelitarnej jest globalny, ale telefon musi być na zewnątrz.",
  "Tak.",
  "Antena wskazuje niebo, a sygnał wraca przez stację naziemną w kraju.",
  "Baterie wytrzymują dłużej, gdy ekran pozostaje ciemny przez całą wyprawę.",
  "Nasz przewodnik niósł dwie zapasowe baterie i mały panel słoneczny w plecaku.",
];

const talkOf = (sentences: string[], repeat = 6): { words: TranscriptWord[]; endMs: number } => script(Array.from({ length: sentences.length * repeat }, (_, index): Line => ({ pid: index % 2 === 0 ? A : B, text: sentences[index % sentences.length] as string })));

describe("title, description and tags", () => {
  for (const [language, sentences, chaptersLabel, speakersLabel] of [
    ["en", EN, "Chapters:", "Speakers:"],
    ["pl", PL, "Rozdziały:", "Rozmówcy:"],
  ] as const) {
    it(`drafts three titles, a description and tags in ${language}`, () => {
      const { words, endMs } = talkOf(sentences);
      const chapters = chaptersForYoutube(words, endMs);
      const draft = draftTitleAndDescription({ words, chapters, speakers: ["Anna", "Bartek"], language, name: "Weekly" });
      expect(draft.titles).toHaveLength(3);
      expect(new Set(draft.titles.map((title) => title.toLowerCase())).size).toBe(3);
      for (const title of draft.titles) {
        expect(title.length).toBeGreaterThan(0);
        expect(title.length).toBeLessThanOrEqual(100);
      }
      expect(draft.description).toContain(`${chaptersLabel}\n${formatChapters(chapters)}`);
      expect(draft.description.endsWith(`${speakersLabel} Anna, Bartek`)).toBe(true);
      expect(draft.description.length).toBeLessThanOrEqual(5000);
      // the summary is extractive: every sentence of it was said in the talk
      const summary = draft.description.split("\n\n")[0] as string;
      const said = new Set(splitSentences(words).map((sentence) => sentence.text));
      const summarised = splitSentences(script([{ pid: A, text: summary }]).words).map((sentence) => sentence.text);
      expect(summarised.length).toBeGreaterThanOrEqual(1);
      for (const sentence of summarised) expect(said.has(sentence)).toBe(true);
      expect(draft.tags.length).toBeGreaterThan(2);
      expect(new Set(draft.tags.map((tag) => tag.toLowerCase())).size).toBe(draft.tags.length);
      expect(draft.tags.every((tag) => tag.length <= 30)).toBe(true);
      expect(draft.tags.join(",").length).toBeLessThanOrEqual(500);
      expect(draft.tags).toEqual(expect.arrayContaining(["Anna", "Bartek"]));
      expect(draftTitleAndDescription({ words, chapters, speakers: ["Anna", "Bartek"], language, name: "Weekly" })).toEqual(draft);
    });
  }

  it("uses the topic words in the titles and the name of the show", () => {
    const { words, endMs } = talkOf(EN);
    const draft = draftTitleAndDescription({ words, chapters: chaptersForYoutube(words, endMs), speakers: ["Anna", "Bartek"], language: "en", name: "Weekly" });
    expect(draft.titles[0]).toMatch(/^Weekly: /);
    expect(draft.titles[1]).toMatch(/^Anna and Bartek on /);
    expect(draft.titles.join(" ").toLowerCase()).toMatch(/satellite|phone|batter/);
  });

  it("still gives three different titles with no words, no name and no speakers", () => {
    for (const language of ["en", "pl"] as const) {
      const draft = draftTitleAndDescription({ words: [], chapters: [], speakers: [], language });
      expect(draft.titles).toHaveLength(3);
      expect(new Set(draft.titles).size).toBe(3);
      expect(draft.description).toBe("");
      expect(draft.tags).toEqual([]);
    }
  });

  it("cuts a very long name to the title limit", () => {
    const { words } = talkOf(EN);
    const draft = draftTitleAndDescription({ words, chapters: [], speakers: [], language: "en", name: "x".repeat(300) });
    expect(draft.titles.every((title) => title.length <= 100)).toBe(true);
  });

  it("picks summary sentences that are complete, spread out and not repeats of each other", () => {
    const { words } = talkOf(EN, 3);
    const sentences = summarySentences(splitSentences(words), "en");
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(3);
    expect(new Set(sentences.map((sentence) => sentence.text)).size).toBe(sentences.length);
    expect(sentences.every((sentence) => sentence.terminal && sentence.words.length >= 8)).toBe(true);
    expect([...sentences].sort((a, b) => a.s - b.s)).toEqual(sentences);
  });

  it("assembles the description from its three parts and builds limited tags", () => {
    const chapters: Chapter[] = [{ startMs: 0, title: "One" }];
    expect(assembleDescription({ summary: "  A summary. ", chapters, speakers: ["Anna"], language: "en" })).toBe("A summary.\n\nChapters:\n00:00 One\n\nSpeakers: Anna");
    expect(assembleDescription({ summary: "", chapters: [], speakers: [], language: "pl" })).toBe("");
    expect(assembleDescription({ summary: "x".repeat(6000), chapters: [], speakers: [], language: "en" })).toHaveLength(5000);
    expect(buildTags(["a", "A", " b ", "x".repeat(31), "", "c"])).toEqual(["a", "b", "c"]);
    expect(buildTags(Array.from({ length: 100 }, (_, index) => `tag-number-${index}-xxxxxxxxxx`)).join(",").length).toBeLessThanOrEqual(500);
  });
});

describe("thumbnails", () => {
  it("specifies 4K sizes under 50 MB", () => {
    expect(thumbnailSpec("video")).toEqual({ width: 3840, height: 2160, maxBytes: 50 * 1024 * 1024 });
    expect(thumbnailSpec("short")).toEqual({ width: 2160, height: 3840, maxBytes: 50 * 1024 * 1024 });
  });

  it("offers markers, clip starts and loud moments, spaced apart and inside the recording", () => {
    const { words, endMs } = talkOf(EN, 12);
    const frames = Math.ceil(endMs / 20);
    const levels = new Int8Array(frames).fill(-40);
    const loudAt = 201_000;
    levels.fill(-12, Math.floor((loudAt - 500) / 20), Math.floor((loudAt + 500) / 20));
    const marker = 90_000;
    const picks = thumbnailCandidates({ durationMs: endMs, highlights: [{ tMs: marker }, { tMs: 91_000 }], words, levels: [{ pid: A, levels }] });
    expect(picks.length).toBeGreaterThan(3);
    expect(picks.length).toBeLessThanOrEqual(8);
    expect(picks[0]).toBe(marker);
    expect(picks.some((at) => Math.abs(at - loudAt) <= 1000)).toBe(true);
    for (const at of picks) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(endMs);
    }
    for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) expect(Math.abs((picks[i] as number) - (picks[j] as number))).toBeGreaterThanOrEqual(3000);
    expect(thumbnailCandidates({ durationMs: endMs, highlights: [{ tMs: marker }, { tMs: 91_000 }], words, levels: [{ pid: A, levels }] })).toEqual(picks);
  });

  it("falls back to evenly spread moments, keeps markers inside the recording and is empty for an empty one", () => {
    expect(thumbnailCandidates({ durationMs: 100_000, highlights: [], words: [] })).toEqual([10_000, 50_000, 90_000]);
    expect(thumbnailCandidates({ durationMs: 100_000, highlights: [{ tMs: 500_000 }, { tMs: -5 }], words: [] })).toEqual([0, 99_999]);
    expect(thumbnailCandidates({ durationMs: 0, highlights: [], words: [] })).toEqual([]);
  });

  for (const kind of ["video", "short"] as const) {
    describe(`text overlay on a ${kind} thumbnail`, () => {
      const spec = thumbnailSpec(kind);
      const safe = safeArea(spec);

      it("fits short and long texts inside the safe area, wrapped in at most four lines", () => {
        let previous = Infinity;
        for (const text of ["Wow", "Why it failed", "Why did the first version fail so badly in production", "Dlaczego pierwsza wersja zawiodła tak bardzo w produkcji i co z tego wynika dla całego zespołu", "word ".repeat(80)]) {
          const layout = overlayTextLayout(text.trim(), spec);
          expect(insideRect(layout.box, safe), text).toBe(true);
          expect(layout.lines.length).toBeGreaterThanOrEqual(1);
          expect(layout.lines.length).toBeLessThanOrEqual(4);
          expect(layout.box.h).toBeLessThanOrEqual(safe.h / 2);
          expect(layout.fontSize).toBeLessThanOrEqual(previous);
          previous = layout.fontSize;
        }
      });

      it("keeps every word of a text that fits and ends a text that does not with an ellipsis", () => {
        const fits = overlayTextLayout("Why did it fail", spec);
        expect(fits.lines.join(" ")).toBe("Why did it fail");
        const long = overlayTextLayout("word ".repeat(80).trim(), spec);
        expect(long.lines.join(" ").endsWith("…")).toBe(true);
        expect(long.fontSize).toBeGreaterThan(0);
      });

      it("centres the plate and copes with one huge word and with nothing", () => {
        const layout = overlayTextLayout("Short title", spec);
        expect(Math.abs(layout.box.x + layout.box.w / 2 - (safe.x + safe.w / 2))).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.box.y + layout.box.h / 2 - (safe.y + safe.h / 2))).toBeLessThanOrEqual(1);
        const huge = overlayTextLayout("Supercalifragilisticexpialidocious".repeat(8), spec);
        expect(insideRect(huge.box, safe)).toBe(true);
        expect(overlayTextLayout("", spec).lines).toEqual([]);
      });
    });
  }

  it("terminates on a canvas too small for any text", () => {
    const layout = overlayTextLayout("Some text here", { width: 40, height: 40 });
    expect(layout.lines.length).toBeGreaterThanOrEqual(1);
  });
});
