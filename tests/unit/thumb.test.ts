import { describe, expect, it } from "vitest";
import { splitSentences } from "../../src/shared/clips.js";
import type { Scene, ActivityTrack } from "../../src/shared/scenes.js";
import { HOOK_COUNT, cleanHook, fallbackHooks, leadClause, mergeHooks, repeatsTitle, validateHooks } from "../../src/shared/thumb-hooks.js";
import { midSpeech, neighbourMoments, previewMoments, sentenceContext, subjectAt, PREVIEW_LIMIT } from "../../src/shared/thumb-moments.js";
import { BACKING_LUMA, measureFrom, parseSignalStats, scoreFrames, textBackingNeeded, type FrameMeasure } from "../../src/shared/thumb-score.js";
import { FACE_TARGET, HOOK_MAX_CHARS, HOOK_MAX_WORDS, THUMBNAIL_FOCUS, defaultTextSide, normalizeHook, parseThumbnailStyle, thumbnailFraming } from "../../src/shared/thumb-style.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const { A, B } = SPEAKERS;
const wordCount = (text: string): number => text.split(" ").length;

const SENTENCES = [
  "The garden needs water every morning because the tomatoes and the roses dry out quickly in summer.",
  "Why did the first version of the migration fail in production?",
  "Our new database migration moves every customer table to the replicated cluster before the weekend.",
  "Training for the marathon means long runs on Sunday and recovery swims during the week.",
];
const talkOf = (repeat: number): { words: TranscriptWord[]; endMs: number } => script(Array.from({ length: SENTENCES.length * repeat }, (_, index): Line => ({ pid: index % 2 === 0 ? A : B, text: SENTENCES[index % SENTENCES.length] as string })));

describe("thumbnail framing and style", () => {
  const canvas = { width: 640, height: 360 };

  it("zooms a video thumbnail and puts the face opposite the text, inside the picture", () => {
    for (const focus of [THUMBNAIL_FOCUS, { x: 0.3, y: 0.3 }, { x: 0.9, y: 0.7 }]) {
      for (const side of ["left", "right"] as const) {
        const { compose, crop } = thumbnailFraming(canvas, "video", side, focus);
        expect(compose.width).toBe(800);
        expect(compose.height).toBe(450);
        if (!crop) throw new Error("no crop");
        expect([crop.w, crop.h]).toEqual([640, 360]);
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.w).toBeLessThanOrEqual(compose.width);
        expect(crop.y + crop.h).toBeLessThanOrEqual(compose.height);
        expect(crop.x % 2).toBe(0);
        expect(crop.y % 2).toBe(0);
      }
    }
    const faceX = (side: "left" | "right"): number => {
      const { compose, crop } = thumbnailFraming(canvas, "video", side);
      return (THUMBNAIL_FOCUS.x * compose.width - (crop?.x ?? 0)) / canvas.width;
    };
    expect(faceX("left")).toBeGreaterThan(0.5);
    expect(faceX("right")).toBeLessThan(0.5);
    expect(Math.abs(faceX("left") - FACE_TARGET.x)).toBeLessThan(0.05);
    expect(Math.abs(faceX("right") - (1 - FACE_TARGET.x))).toBeLessThan(0.05);
  });

  it("leaves a Short unzoomed and picks the side away from the face", () => {
    expect(thumbnailFraming({ width: 360, height: 640 }, "short", "left")).toEqual({ compose: { width: 360, height: 640 }, crop: null });
    expect(defaultTextSide()).toBe("left");
    expect(defaultTextSide({ x: 0.3, y: 0.4 })).toBe("right");
  });

  it("cleans a headline to at most five words and sixty characters", () => {
    expect(normalizeHook("  “Why   the\ttomatoes\ndry out”  ")).toBe("Why the tomatoes dry out");
    expect(normalizeHook("one two three four five six seven")).toBe("one two three four five");
    expect(normalizeHook("supercalifragilistic ".repeat(5)).length).toBeLessThanOrEqual(HOOK_MAX_CHARS);
    expect(normalizeHook("a\u0000b\u200bc")).toBe("a b c");
    expect(normalizeHook("   ")).toBe("");
    expect(wordCount(normalizeHook("x ".repeat(20)))).toBe(HOOK_MAX_WORDS);
  });

  it("reads the style of a job leniently", () => {
    expect(parseThumbnailStyle({})).toEqual({ text: "", color: "white", side: null });
    expect(parseThumbnailStyle({ text: " Hello there ", color: "yellow", side: "right" })).toEqual({ text: "Hello there", color: "yellow", side: "right" });
    expect(parseThumbnailStyle({ text: 5, color: "red", side: "top" })).toEqual({ text: "", color: "white", side: null });
  });
});

describe("frame scoring", () => {
  const good: FrameMeasure = { yAvg: 120, yLow: 50, yHigh: 200, satAvg: 40, edge: 0.1 };

  it("parses the last frame of a signalstats dump and ignores other lines", () => {
    const dump = ["frame:0    pts:0       pts_time:0", "lavfi.signalstats.YAVG=10.5", "lavfi.signalstats.YLOW=2", "frame:1    pts:1       pts_time:0.04", "lavfi.signalstats.YAVG=104.5", "lavfi.signalstats.YLOW=40", "lavfi.signalstats.SATAVG=33.1", "lavfi.signalstats.TOUT=0.000000", "lavfi.signalstats.HUEMED=nan"].join("\n");
    expect(parseSignalStats(dump)).toEqual({ YAVG: 104.5, YLOW: 40, SATAVG: 33.1, TOUT: 0 });
    expect(parseSignalStats("")).toEqual({});
  });

  it("builds a measure from the two dumps and refuses incomplete ones", () => {
    expect(measureFrom({ YAVG: 100, YLOW: 30, YHIGH: 200, SATAVG: 20 }, { YAVG: 25.5 })).toEqual({ yAvg: 100, yLow: 30, yHigh: 200, satAvg: 20, edge: 0.1 });
    expect(measureFrom({ YAVG: 100, YLOW: 30, YHIGH: 200 }, { YAVG: 25.5 })).toBeNull();
    expect(measureFrom({ YAVG: 100, YLOW: 30, YHIGH: 200, SATAVG: 20 }, {})).toBeNull();
  });

  it("drops dark, bright, flat and blurry frames and ranks the rest best first", () => {
    const scores = scoreFrames([
      good,
      { ...good, yAvg: 20 },
      { ...good, yAvg: 240 },
      { ...good, yLow: 100, yHigh: 120 },
      { ...good, edge: 0.01 },
      { ...good, yAvg: 90, satAvg: 10, yLow: 70, yHigh: 130, edge: 0.08 },
      { ...good, edge: 0.12 },
    ]);
    expect(scores.map((entry) => entry.reject)).toEqual([null, "dark", "bright", "flat", "blurry", null, null]);
    for (const { score } of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect(scores[6]?.score).toBeGreaterThan(scores[0]?.score ?? 1);
    expect(scores[0]?.score).toBeGreaterThan(scores[5]?.score ?? 1);
    expect(scores[0]?.score).toBeGreaterThan(scores[1]?.score ?? 1);
  });

  it("judges sharpness against the other frames and copes with no edges at all and with no frames", () => {
    expect(scoreFrames([{ ...good, edge: 0 }, { ...good, edge: 0 }]).every((entry) => entry.reject === null)).toBe(true);
    expect(scoreFrames([])).toEqual([]);
    const soft = scoreFrames([{ ...good, edge: 0.02 }, { ...good, edge: 0.02 }, { ...good, edge: 0.02 }]);
    expect(soft.every((entry) => entry.reject === null)).toBe(true);
  });

  it("asks for a dark backing only behind a bright background", () => {
    expect(textBackingNeeded(BACKING_LUMA - 1)).toBe(false);
    expect(textBackingNeeded(BACKING_LUMA + 1)).toBe(true);
  });
});

describe("hooks", () => {
  it("cleans a model's answer: no emoji, markdown or quotes, at most five words", () => {
    expect(cleanHook("**Why it failed** 🚀")).toBe("Why it failed");
    expect(cleanHook('"The truth about tomatoes, finally told"')).toBe("The truth about tomatoes, finally");
    expect(cleanHook("  … Watch this –")).toBe("Watch this");
    expect(cleanHook("Why did it fail?")).toBe("Why did it fail?");
  });

  it("keeps the hooks of any list that are usable: strings, new, not the title, three at most", () => {
    const hooks = validateHooks(["Why it failed", 5, null, "why it failed", "  ", "Product launch story", "One two three four five six", "Another idea", "A fourth idea"], "Product launch");
    expect(hooks).toEqual(["Why it failed", "One two three four five", "Another idea"]);
    for (const hook of hooks ?? []) expect(wordCount(hook)).toBeLessThanOrEqual(HOOK_MAX_WORDS);
    expect(hooks?.length).toBeLessThanOrEqual(HOOK_COUNT);
    expect(validateHooks("Why it failed", "")).toBeNull();
    expect(validateHooks([], "")).toBeNull();
    expect(validateHooks(["Product launch"], "The Product Launch")).toBeNull();
    expect(repeatsTitle("Product launch", "Our product launch story")).toBe(true);
    expect(repeatsTitle("Something else", "Our product launch story")).toBe(false);
    expect(mergeHooks([["Alpha beta"], ["Alpha beta", "Gamma delta"]], "")).toEqual(["Alpha beta", "Gamma delta"]);
    expect(mergeHooks([[]], "")).toEqual([]);
  });

  it("takes the first complete thought of the spoken sentence as a hook", () => {
    expect(leadClause("Why did it fail?", "en")).toBe("Why did it fail?");
    expect(leadClause("Well, the cluster was too small for all of that data", "en")).toBeNull();
    expect(leadClause("This sentence has far too many words to be a headline", "en")).toBeNull();
    expect(leadClause("Dlaczego to zawiodło?", "pl")).toBe("Dlaczego to zawiodło?");
  });

  for (const [language, sentence, keywords] of [
    ["en", "Why did it fail?", ["version", "production"]],
    ["pl", "Dlaczego to zawiodło?", ["wersja", "produkcja"]],
  ] as const) {
    it(`offers up to ${HOOK_COUNT} short hooks in ${language} without a model, none repeating the title`, () => {
      const hooks = fallbackHooks({ sentence, title: "Weekly talk", keywords: [...keywords], language });
      expect(hooks.length).toBeGreaterThan(0);
      expect(hooks.length).toBeLessThanOrEqual(HOOK_COUNT);
      expect(hooks[0]).toBe(sentence);
      for (const hook of hooks) {
        expect(wordCount(hook)).toBeLessThanOrEqual(HOOK_MAX_WORDS);
        expect(repeatsTitle(hook, "Weekly talk")).toBe(false);
      }
      expect(fallbackHooks({ sentence, title: sentence.replace("?", ""), keywords: [...keywords], language })[0]).not.toBe(sentence);
      expect(fallbackHooks({ sentence: "", title: "", keywords: [], language }).length).toBeGreaterThan(0);
    });
  }
});

describe("moments and subjects", () => {
  it("moves a moment to the middle of the word spoken there or just near it", () => {
    const words = [
      { s: 1000, e: 1400, w: "one" },
      { s: 5000, e: 5600, w: "two" },
    ] as unknown as TranscriptWord[];
    expect(midSpeech(words, 1100)).toBe(1200);
    expect(midSpeech(words, 2000)).toBe(1200);
    expect(midSpeech(words, 3000)).toBe(3000);
    expect(midSpeech(words, 5300)).toBe(5300);
    expect(midSpeech([], 700)).toBe(700);
  });

  it("offers up to twelve preview moments inside the recording, spaced apart and the same every time", () => {
    const { words, endMs } = talkOf(14);
    const input = { durationMs: endMs, highlights: [{ tMs: 40_000 }], words, language: "en" as const };
    const moments = previewMoments(input);
    expect(moments.length).toBeGreaterThan(3);
    expect(moments.length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    for (const at of moments) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(endMs);
    }
    for (let i = 0; i < moments.length; i++) for (let j = i + 1; j < moments.length; j++) expect(Math.abs((moments[i] as number) - (moments[j] as number))).toBeGreaterThanOrEqual(2500);
    expect(previewMoments(input)).toEqual(moments);
    expect(previewMoments(input, 2)).toEqual(moments.slice(0, 2));
    expect(previewMoments({ durationMs: 0, highlights: [], words: [], language: "en" })).toEqual([]);
    expect(previewMoments({ durationMs: 60_000, highlights: [], words: [], language: "pl" }).length).toBeGreaterThan(0);
  });

  it("offers the frames a few tenths of a second around a chosen one, inside the recording", () => {
    expect(neighbourMoments(20_000, 60_000)).toEqual([19_200, 19_600, 20_400, 20_800]);
    expect(neighbourMoments(300, 60_000)).toEqual([700, 1100]);
    expect(neighbourMoments(59_900, 60_000)).toEqual([59_100, 59_500]);
    expect(neighbourMoments(0, 0)).toEqual([]);
  });

  it("finds what is said at a moment, with the sentences around it", () => {
    const { words } = talkOf(2);
    const sentences = splitSentences(words);
    const second = sentences[1];
    if (!second) throw new Error("no sentence");
    const at = Math.round((second.s + second.e) / 2);
    const found = sentenceContext(words, at);
    expect(found.sentence).toBe(second.text);
    expect(found.context).toBe(sentences.slice(0, 3).map((sentence) => sentence.text).join(" "));
    expect(sentenceContext(words, 0).sentence).toBe(sentences[0]?.text);
    expect(sentenceContext([], 1000)).toEqual({ sentence: "", context: "" });
  });

  describe("whose picture a frame shows", () => {
    const source = (id: string, kind: "camera" | "screen", offsetMs = 0, durationMs = 100_000): Parameters<typeof subjectAt>[0]["sources"][number] => ({ id, kind, hasVideo: true, width: 1280, height: 720, offsetMs, timelineDurationMs: durationMs });
    const track = (id: string, db: number): ActivityTrack => ({ id, levels: new Int8Array(5000).fill(db) });
    const scene = (sources: string[]): Scene => ({ s: 0, e: 100_000, layout: "solo", sources });

    it("is the camera of the loudest microphone", () => {
      const sources = [source("cam-a", "camera"), source("cam-b", "camera")];
      const tracks = [track("cam-a", -50), track("cam-b", -20)];
      expect(subjectAt({ sources, tracks, scene: scene(["cam-a", "cam-b"]), atMs: 10_000 })).toEqual({ id: "cam-b", kind: "camera", screenFeatured: false });
      expect(subjectAt({ sources, tracks: [track("cam-a", -30), track("cam-b", -30)], scene: scene(["cam-b", "cam-a"]), atMs: 10_000 })?.id).toBe("cam-b");
    });

    it("skips a camera that is not recording then, and falls back to the screen, then to nothing", () => {
      const late = [source("cam-a", "camera", 50_000), source("screen", "screen")];
      expect(subjectAt({ sources: late, tracks: [track("cam-a", -20)], scene: scene(["screen"]), atMs: 10_000 })).toEqual({ id: "screen", kind: "screen", screenFeatured: true });
      expect(subjectAt({ sources: late, tracks: [track("cam-a", -20)], scene: scene(["cam-a"]), atMs: 60_000 })).toEqual({ id: "cam-a", kind: "camera", screenFeatured: false });
      expect(subjectAt({ sources: [source("cam-a", "camera", 50_000)], tracks: [], scene: null, atMs: 10_000 })).toBeNull();
      expect(subjectAt({ sources: [{ ...source("cam-a", "camera"), hasVideo: false }], tracks: [], scene: null, atMs: 10_000 })).toBeNull();
    });

    it("marks a frame taken while a screen is on show", () => {
      const sources = [source("cam-a", "camera"), source("screen", "screen")];
      expect(subjectAt({ sources, tracks: [track("cam-a", -20)], scene: scene(["screen", "cam-a"]), atMs: 1000 })).toEqual({ id: "cam-a", kind: "camera", screenFeatured: true });
    });
  });
});
