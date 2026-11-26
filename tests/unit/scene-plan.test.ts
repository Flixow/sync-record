import { describe, expect, it } from "vitest";
import { allowedLayouts, describeSegments, overridesFor, parseSegmentChoices, planSegments, spansFor } from "../../src/shared/scene-plan.js";
import { applyOverrides, DEFAULT_SCENE_PARAMS, planScenes, type ActivityTrack, type Scene } from "../../src/shared/scenes.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";

const FRAME = 20;
const DURATION = 240_000;

/** Two microphones taking turns every 20 s (A first), with a screen share over the whole recording when asked. */
function fixture(screen: boolean): { tracks: ActivityTrack[]; scenes: Scene[] } {
  const frames = DURATION / FRAME;
  const a = new Int8Array(frames).fill(-75);
  const b = new Int8Array(frames).fill(-75);
  for (let frame = 0; frame < frames; frame++) {
    const ms = frame * FRAME;
    const voice = -26 - (frame % 5);
    if (Math.floor(ms / 20_000) % 2 === 0) {
      a[frame] = voice;
      b[frame] = voice - 24;
    } else {
      b[frame] = voice;
      a[frame] = voice - 24;
    }
  }
  const tracks: ActivityTrack[] = [
    { id: "cam0", levels: a },
    { id: "cam1", levels: b },
    ...(screen ? [{ id: "scr0", levels: new Int8Array(0), kind: "screen" as const }] : []),
  ];
  return { tracks, scenes: planScenes(tracks, DURATION, DEFAULT_SCENE_PARAMS) };
}

/** One word per second; the speaker changes every 20 s, as on the microphones. */
const words: TranscriptWord[] = Array.from({ length: DURATION / 1000 }, (_, second) => {
  const pid = Math.floor(second / 20) % 2 === 0 ? "p1-anna" : "p2-bartek";
  return { t: `word${second}`, s: second * 1000 + 100, e: second * 1000 + 600, src: `${pid}-audio-0001`, pid };
});

describe("planSegments", () => {
  it("covers the scenes without gaps, caps the count and stays above the minimum length", () => {
    const { tracks, scenes } = fixture(false);
    const segments = planSegments(scenes, tracks, words, { maxSegments: 6, minSegmentMs: 20_000 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThanOrEqual(6);
    expect(segments[0]?.s).toBe(0);
    expect(segments[segments.length - 1]?.e).toBe(DURATION);
    segments.forEach((segment, index) => {
      expect(segment.i).toBe(index);
      expect(segment.e - segment.s).toBeGreaterThanOrEqual(20_000);
      if (index > 0) expect(segment.s).toBe((segments[index - 1] as { e: number }).e);
    });
    expect(planSegments([], tracks, words)).toEqual([]);
  });

  it("measures speech, overlap, silence, turns and screen presence from the level tracks and the words", () => {
    const { tracks, scenes } = fixture(true);
    const [first] = planSegments(scenes, tracks, words, { maxSegments: 1 });
    expect(first?.signals.screenShare).toBe(true);
    expect(first?.signals.speechPct).toBe(100);
    expect(first?.signals.silencePct).toBe(0);
    expect(first?.signals.overlapPct).toBe(0);
    expect(first?.signals.turns).toBe(11);
    expect(first?.signals.energyDb).toBeLessThan(-20);
    expect(first?.signals.energyDb).toBeGreaterThan(-40);
    expect(first?.allowed).toEqual(["solo", "side-by-side", "speaker-thumbs", "screen-camera"]);
    expect(first?.text.length).toBeGreaterThan(0);
    expect(first?.text.length).toBeLessThanOrEqual(300);
    // the same recording without the screen offers no screen layout and reports no screen
    const without = fixture(false);
    const [plain] = planSegments(without.scenes, without.tracks, words, { maxSegments: 1 });
    expect(plain?.signals.screenShare).toBe(false);
    expect(plain?.allowed).not.toContain("screen-camera");
  });

  it("reports overlap and silence when the microphones say so", () => {
    const frames = 60_000 / FRAME;
    const a = new Int8Array(frames).fill(-75);
    const b = new Int8Array(frames).fill(-75);
    for (let frame = 0; frame < frames; frame++) {
      const ms = frame * FRAME;
      if (ms < 20_000) {
        a[frame] = -26;
        b[frame] = -27;
      } else if (ms < 40_000) a[frame] = -26;
    }
    const tracks: ActivityTrack[] = [{ id: "cam0", levels: a }, { id: "cam1", levels: b }];
    const scenes = planScenes(tracks, 60_000, DEFAULT_SCENE_PARAMS);
    const [segment] = planSegments(scenes, tracks, [], { maxSegments: 1 });
    expect(segment?.signals.overlapPct).toBeGreaterThan(20);
    expect(segment?.signals.silencePct).toBeGreaterThan(20);
    expect((segment?.signals.speechPct ?? 0) + (segment?.signals.silencePct ?? 0)).toBe(100);
  });
});

describe("allowedLayouts", () => {
  it("only offers layouts that have enough pictures", () => {
    expect(allowedLayouts(0, false)).toEqual(["solo"]);
    expect(allowedLayouts(1, false)).toEqual(["solo"]);
    expect(allowedLayouts(1, true)).toEqual(["solo", "screen-camera"]);
    expect(allowedLayouts(2, false)).toEqual(["solo", "side-by-side", "speaker-thumbs"]);
    expect(allowedLayouts(3, false)).toContain("grid");
  });
});

describe("parseSegmentChoices", () => {
  const { tracks, scenes } = fixture(true);
  const segments = planSegments(scenes, tracks, words, { maxSegments: 4 });

  it("keeps valid entries, skips the others one by one and cleans free text", () => {
    const choices = parseSegmentChoices(
      {
        segments: [
          { i: 0, layout: "screen-camera", highlight: "  The\n key moment " + "x".repeat(300) },
          { i: 1, layout: "carousel" },
          { i: 1, layout: "solo", cut: "dead air" },
          { i: 1, layout: "grid" },
          { i: 99, layout: "solo" },
          { i: "2", layout: "solo" },
          { i: 2, cut: "off topic", highlight: "both given" },
          { i: 3 },
          "junk",
        ],
      },
      segments,
    );
    expect(choices?.map((choice) => choice.i)).toEqual([0, 1, 2]);
    expect(choices?.[0]?.layout).toBe("screen-camera");
    expect(choices?.[0]?.highlight?.startsWith("The key moment")).toBe(true);
    expect(choices?.[0]?.highlight?.length).toBeLessThanOrEqual(120);
    expect(choices?.[1]).toEqual({ i: 1, layout: "solo", cut: "dead air" });
    // highlight wins over cut for one segment
    expect(choices?.[2]).toEqual({ i: 2, highlight: "both given" });
  });

  it("returns null for the wrong shape or nothing usable", () => {
    for (const answer of [null, "text", 5, {}, { segments: "x" }, { segments: [] }, { segments: [{ i: 0, layout: "nope" }] }, { segments: [{ i: 7, layout: "solo" }] }]) {
      expect(parseSegmentChoices(answer, segments), JSON.stringify(answer)).toBeNull();
    }
  });
});

describe("overridesFor", () => {
  const { tracks, scenes } = fixture(true);
  const segments = planSegments(scenes, tracks, words, { maxSegments: 2 });
  const screens = new Set(["scr0"]);

  it("changes only scenes whose picture changes, so the speaker keeps leading, and the editor accepts the result", () => {
    const result = overridesFor(scenes, segments, [{ i: 0, layout: "screen-camera" }], screens);
    expect(result).toEqual([]);
    const solo = overridesFor(scenes, segments, [{ i: 0, layout: "solo" }], screens);
    expect(solo.length).toBeGreaterThan(0);
    for (const override of solo) {
      expect(override.layout).toBe("solo");
      expect(override.sources?.includes("scr0")).toBe(false);
      expect(override.s).toBeGreaterThanOrEqual(0);
      expect(override.e).toBeLessThanOrEqual(DURATION);
    }
    // applied like a hand edit: the scenes still tile the recording, the first source (the speaker) is unchanged
    const applied = applyOverrides(scenes, solo);
    expect(applied[0]?.s).toBe(0);
    expect(applied[applied.length - 1]?.e).toBe(DURATION);
    expect(applied.every((scene) => scene.layout === "solo" || scene.s >= (segments[0] as { e: number }).e)).toBe(true);
    const speakerNow = scenes[0]?.sources.find((id) => id !== "scr0");
    expect(applied[0]?.sources[0]).toBe(speakerNow);
  });

  it("ignores choices without a layout, unknown segments and a layout the scene already has", () => {
    expect(overridesFor(scenes, segments, [{ i: 0, highlight: "x" }, { i: 9, layout: "solo" }], screens)).toEqual([]);
  });
});

describe("spans and prompt", () => {
  it("turns highlight and cut choices into the time range of their segment", () => {
    const { tracks, scenes } = fixture(false);
    const segments = planSegments(scenes, tracks, words, { maxSegments: 4 });
    const { highlights, cuts } = spansFor(segments, [{ i: 1, highlight: "good" }, { i: 2, cut: "dead" }, { i: 40, cut: "ghost" }]);
    expect(highlights).toEqual([{ s: (segments[1] as { s: number }).s, e: (segments[1] as { e: number }).e, reason: "good" }]);
    expect(cuts).toEqual([{ s: (segments[2] as { s: number }).s, e: (segments[2] as { e: number }).e, reason: "dead" }]);
  });

  it("describes every segment with its numbers and text, and no raw samples", () => {
    const { tracks, scenes } = fixture(true);
    const segments = planSegments(scenes, tracks, words, { maxSegments: 3 });
    const text = describeSegments(segments);
    for (const segment of segments) expect(text).toContain(`#${segment.i} `);
    expect(text).toMatch(/speech \d+%, overlap \d+%, silence \d+%, energy -?\d+ dB, turns \d+, screen share yes/u);
    expect(text.length).toBeLessThan(segments.length * 600);
  });
});
