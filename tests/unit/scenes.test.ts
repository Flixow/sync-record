import { describe, expect, it } from "vitest";
import { removeRange, EMPTY_EDL, keptDuration, toOutput, type Edl } from "../../src/shared/edl.js";
import {
  addOverride,
  applyOverrides,
  clearOverrides,
  commitPlan,
  DEFAULT_SCENE_PARAMS,
  effectiveMinDwellMs,
  newPlan,
  newPlanHistory,
  planScenes,
  redoPlan,
  remapScenes,
  removeOverrideAt,
  RHYTHMS,
  sameScene,
  sceneAt,
  setParams,
  undoPlan,
  type ActivityTrack,
  type Rhythm,
  type Scene,
  type SceneOverride,
  type SceneParams,
  type ScenePlan,
} from "../../src/shared/scenes.js";
import { DEFAULT_VAD } from "../../src/shared/vad.js";

const FRAME = 20;

/** Small deterministic generator so a failing sequence can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type Turn = [speaker: number, startMs: number, endMs: number];

/**
 * Microphones of a conversation: the speaker's own microphone carries the voice at `loud` dBFS (a little modulation),
 * every other microphone a copy `bleedDb` quieter, all of them a noise floor of -75 dBFS.
 */
function conversation(turns: Turn[], durationMs: number, speakers = 2, bleedDb: number | null = -24, loud = -26): ActivityTrack[] {
  const frames = Math.ceil(durationMs / FRAME);
  const levels = Array.from({ length: speakers }, () => new Int8Array(frames).fill(-75));
  for (const [speaker, startMs, endMs] of turns) {
    for (let frame = Math.floor(startMs / FRAME); frame < Math.min(frames, Math.ceil(endMs / FRAME)); frame++) {
      const voice = loud - (frame % 5);
      for (let mic = 0; mic < speakers; mic++) {
        const level = mic === speaker ? voice : bleedDb === null ? -75 : voice + bleedDb;
        (levels[mic] as Int8Array)[frame] = Math.max((levels[mic] as Int8Array)[frame] as number, level);
      }
    }
  }
  return levels.map((track, index) => ({ id: `cam${index}`, levels: track }));
}

const params = (patch: Partial<SceneParams> = {}): SceneParams => ({ ...DEFAULT_SCENE_PARAMS, ...patch });
const featuredAt = (scenes: Scene[], ms: number): string | undefined => sceneAt(scenes, ms)?.sources[0];

function expectTiling(scenes: Scene[], durationMs: number, label = ""): void {
  expect(scenes.length, label).toBeGreaterThan(0);
  expect(scenes[0]?.s, label).toBe(0);
  expect(scenes[scenes.length - 1]?.e, label).toBe(durationMs);
  scenes.forEach((scene, index) => {
    expect(scene.e, `${label} scene ${index}`).toBeGreaterThan(scene.s);
    if (index > 0) expect(scene.s, `${label} scene ${index}`).toBe((scenes[index - 1] as Scene).e);
  });
}

describe("planScenes: active speaker", () => {
  it("features the speaker whose microphone carries the voice, and tiles the timeline", () => {
    const duration = 40_000;
    const tracks = conversation([[0, 500, 9000], [1, 11_000, 19_000], [0, 21_000, 30_000], [1, 31_500, 39_000]], duration);
    const scenes = planScenes(tracks, duration, params());
    expectTiling(scenes, duration);
    expect(scenes.map((scene) => scene.sources[0])).toEqual(["cam0", "cam1", "cam0", "cam1"]);
    for (const [speaker, startMs, endMs] of [[0, 500, 9000], [1, 11_000, 19_000], [0, 21_000, 30_000], [1, 31_500, 39_000]] as Turn[]) {
      for (let ms = startMs; ms < endMs; ms += 20) expect(featuredAt(scenes, ms), `${ms}`).toBe(`cam${speaker}`);
    }
    // a scene lists every camera, the featured one first
    expect(scenes[1]?.sources).toEqual(["cam1", "cam0"]);
    expect(scenes.every((scene) => scene.layout === "solo")).toBe(true);
  });

  it("is on the next speaker a moment before their first word, and holds the last speaker through silence", () => {
    const duration = 30_000;
    const scenes = planScenes(conversation([[0, 1000, 8000], [1, 14_000, 22_000]], duration), duration, params());
    expect(scenes).toHaveLength(2);
    const cut = (scenes[0] as Scene).e;
    // cut at the first frame of speech minus the lead-in, nowhere near the end of the previous speaker
    expect(cut).toBeLessThanOrEqual(14_000);
    expect(cut).toBeGreaterThanOrEqual(14_000 - 200);
    expect(featuredAt(scenes, 11_000)).toBe("cam0");
  });

  it("does not take bleed on a quiet microphone for that person talking", () => {
    const duration = 30_000;
    // the bleed is strong enough to be above the speech threshold of the quiet microphone
    const tracks = conversation([[0, 1000, 12_000], [1, 14_000, 25_000]], duration, 2, -22, -20);
    const scenes = planScenes(tracks, duration, params());
    for (let ms = 1000; ms < 12_000; ms += 100) expect(featuredAt(scenes, ms)).toBe("cam0");
    for (let ms = 14_000; ms < 25_000; ms += 100) expect(featuredAt(scenes, ms)).toBe("cam1");
    // without the dominance test of the voice activity detector a quiet copy would count as speech on the other microphone
    const bleedFlags = planScenes(tracks, duration, params({ hysteresisDb: 0 }), { ...DEFAULT_VAD, dominanceDb: null });
    expectTiling(bleedFlags, duration);
  });

  it("ignores a silent camera and stays on the speaking ones", () => {
    const duration = 30_000;
    const tracks = [...conversation([[0, 1000, 12_000], [1, 14_000, 25_000]], duration), { id: "silent", levels: new Int8Array(duration / FRAME).fill(-100) }];
    const scenes = planScenes(tracks, duration, params());
    expect(scenes.map((scene) => scene.sources[0])).not.toContain("silent");
    expect(scenes.every((scene) => scene.sources.length === 3)).toBe(true);
  });

  it("keeps the speaker on screen when another one only interjects", () => {
    const duration = 30_000;
    // cam1 says something short at the same loudness while cam0 talks; and later 1.2 s that is a real contribution
    const turns: Turn[] = [[0, 500, 29_000]];
    const tracks = conversation(turns, duration);
    const interjection = conversation([[1, 9000, 9300]], duration, 2, null, -26);
    (tracks[1] as ActivityTrack).levels.set((interjection[1] as ActivityTrack).levels.subarray(9000 / FRAME, 9300 / FRAME), 9000 / FRAME);
    const scenes = planScenes(tracks, duration, params());
    expect(scenes).toHaveLength(1);
    expect(featuredAt(scenes, 9100)).toBe("cam0");
  });

  it("lets a louder challenger take over while both speak, and not one that is only a little louder", () => {
    const duration = 40_000;
    const loud = conversation([[0, 500, 30_000]], duration, 2, null, -30);
    const challenger = (level: number): ActivityTrack[] => {
      const tracks = loud.map((track) => ({ ...track, levels: Int8Array.from(track.levels) }));
      (tracks[1] as ActivityTrack).levels.fill(level, 12_000 / FRAME, 20_000 / FRAME);
      return tracks;
    };
    // 3 dB louder than cam0 (-30..-34): within the hysteresis of 4 dB, cam0 stays
    expect(featuredAt(planScenes(challenger(-28), duration, params()), 16_000)).toBe("cam0");
    // 12 dB louder: cam1 takes over for the time of its speech
    const taken = planScenes(challenger(-18), duration, params());
    expect(featuredAt(taken, 16_000)).toBe("cam1");
    expect(featuredAt(taken, 5000)).toBe("cam0");
    expect(featuredAt(taken, 25_000)).toBe("cam0");
  });

  it("shows everybody when nobody speaks (wide) or keeps the last speaker (keep)", () => {
    const duration = 50_000;
    const tracks = conversation([[0, 1000, 10_000], [1, 30_000, 45_000]], duration);
    const keep = planScenes(tracks, duration, params({ fallback: "keep" }));
    expect(keep.map((scene) => scene.sources[0])).toEqual(["cam0", "cam1"]);
    const wide = planScenes(tracks, duration, params({ fallback: "wide" }));
    expectTiling(wide, duration);
    const pause = sceneAt(wide, 20_000) as Scene;
    expect(pause.layout).toBe("side-by-side");
    expect([...pause.sources].sort()).toEqual(["cam0", "cam1"]);
    expect(featuredAt(wide, 5000)).toBe("cam0");
    expect(featuredAt(wide, 40_000)).toBe("cam1");
    // a pause shorter than the hangover plus the dwell does not cut away
    const quick = conversation([[0, 1000, 10_000], [1, 11_000, 20_000]], 20_500);
    expect(planScenes(quick, 20_500, params({ fallback: "wide" })).every((scene) => scene.layout === "solo")).toBe(true);
    // three and four cameras show a grid
    const four = planScenes(conversation([[0, 1000, 10_000], [3, 30_000, 45_000]], duration, 4), duration, params({ fallback: "wide" }));
    expect((sceneAt(four, 20_000) as Scene).layout).toBe("grid");
  });

  it("shows several people talking at once as wide only when they keep at it", () => {
    const duration = 40_000;
    const tracks = conversation([[0, 1000, 20_000]], duration, 2, null, -30);
    // both speak at the same level for 5 s
    (tracks[1] as ActivityTrack).levels.fill(-30, 10_000 / FRAME, 15_000 / FRAME);
    const wide = planScenes(tracks, duration, params({ fallback: "wide" }));
    expect((sceneAt(wide, 14_000) as Scene).layout).toBe("side-by-side");
    expect((sceneAt(wide, 11_000) as Scene).layout).toBe("solo");
    expect(featuredAt(wide, 5000)).toBe("cam0");
    expect(featuredAt(wide, 18_000)).toBe("cam0");
    const keep = planScenes(tracks, duration, params({ fallback: "keep" }));
    expect(keep.every((scene) => scene.sources[0] === "cam0" && scene.layout === "solo")).toBe(true);
    // 1 s of overlap is an interjection or a laugh, not a scene
    const brief = conversation([[0, 1000, 20_000]], duration, 2, null, -30);
    (brief[1] as ActivityTrack).levels.fill(-30, 10_000 / FRAME, 11_000 / FRAME);
    const briefScenes = planScenes(brief, duration, params({ fallback: "wide" }));
    for (let ms = 1000; ms < 20_000; ms += 100) expect(sceneAt(briefScenes, ms)?.layout, `${ms}`).toBe("solo");
  });

  it("scales the dwell and the interjection limit with the rhythm", () => {
    expect(effectiveMinDwellMs(params({ rhythm: "balanced" }))).toBe(2500);
    expect(effectiveMinDwellMs(params({ rhythm: "calm" }))).toBe(4000);
    expect(effectiveMinDwellMs(params({ rhythm: "lively" }))).toBe(1750);
    expect(effectiveMinDwellMs(params({ rhythm: "lively", minDwellMs: 1000 }))).toBe(700);
    expect(RHYTHMS.calm.ignoreMs).toBe(700);
    expect(RHYTHMS.balanced.ignoreMs).toBe(400);
    expect(RHYTHMS.lively.ignoreMs).toBe(250);
    // an answer that is on screen for 3 s is a scene for a balanced or lively rhythm but not for a calm one
    const duration = 40_000;
    const tracks = conversation([[0, 500, 15_000], [1, 17_000, 19_000], [0, 20_000, 38_000]], duration);
    expect(planScenes(tracks, duration, params({ rhythm: "balanced" })).map((scene) => scene.sources[0])).toEqual(["cam0", "cam1", "cam0"]);
    expect(planScenes(tracks, duration, params({ rhythm: "lively" })).map((scene) => scene.sources[0])).toEqual(["cam0", "cam1", "cam0"]);
    expect(planScenes(tracks, duration, params({ rhythm: "calm" })).map((scene) => scene.sources[0])).toEqual(["cam0"]);
    // a 400 ms interjection after a pause counts for a lively rhythm and not for a calm one
    const short = conversation([[0, 500, 10_000], [1, 12_000, 12_400], [0, 14_000, 30_000]], 32_000);
    const lively = planScenes(short, 32_000, params({ rhythm: "lively", minDwellMs: 100 }));
    const calm = planScenes(short, 32_000, params({ rhythm: "calm", minDwellMs: 100 }));
    expect(lively.map((scene) => scene.sources[0])).toEqual(["cam0", "cam1", "cam0"]);
    expect(calm.map((scene) => scene.sources[0])).toEqual(["cam0"]);
  });

  it("uses the layout of the parameters, and lists the other cameras behind the featured one", () => {
    const duration = 30_000;
    const tracks = conversation([[0, 1000, 12_000], [1, 14_000, 25_000]], duration, 3);
    const thumbs = planScenes(tracks, duration, params({ layout: "speaker-thumbs", fit: "fit" }));
    expect(thumbs.map((scene) => scene.layout)).toEqual(["speaker-thumbs", "speaker-thumbs"]);
    expect(thumbs.map((scene) => scene.sources)).toEqual([["cam0", "cam1", "cam2"], ["cam1", "cam0", "cam2"]]);
    expect(thumbs.every((scene) => scene.fit === "fit")).toBe(true);
    expect(planScenes(tracks, duration, params())[0]).not.toHaveProperty("fit");
  });

  it("is one scene when the layout shows everybody anyway, or there is one camera", () => {
    const duration = 30_000;
    const two = conversation([[0, 1000, 12_000], [1, 14_000, 25_000]], duration);
    expect(planScenes(two, duration, params({ layout: "side-by-side" }))).toEqual([{ s: 0, e: duration, layout: "side-by-side", sources: ["cam0", "cam1"] }]);
    expect(planScenes(two, duration, params({ layout: "grid" }))).toEqual([{ s: 0, e: duration, layout: "side-by-side", sources: ["cam0", "cam1"] }]);
    const solo = conversation([[0, 1000, 12_000]], duration, 1);
    expect(planScenes(solo, duration, params({ layout: "speaker-thumbs" }))).toEqual([{ s: 0, e: duration, layout: "solo", sources: ["cam0"] }]);
    expect(planScenes([], duration, params())).toEqual([]);
    expect(planScenes(two, 0, params())).toEqual([]);
  });

  it("features the screen with the speaking camera beside it", () => {
    const duration = 40_000;
    const tracks: ActivityTrack[] = [{ id: "screen", kind: "screen", levels: new Int8Array(0) }, ...conversation([[0, 1000, 15_000], [1, 17_000, 30_000]], duration)];
    for (const layout of ["solo", "speaker-thumbs", "grid"] as const) {
      const scenes = planScenes(tracks, duration, params({ layout, fallback: "wide" }));
      expectTiling(scenes, duration, layout);
      expect(scenes.every((scene) => scene.layout === "screen-camera" && scene.sources[0] === "screen"), layout).toBe(true);
      expect(scenes.map((scene) => scene.sources[1])).toEqual(["cam0", "cam1"]);
    }
    const screenAndOne = planScenes([tracks[0] as ActivityTrack, tracks[1] as ActivityTrack], duration, params());
    expect(screenAndOne).toEqual([{ s: 0, e: duration, layout: "screen-camera", sources: ["screen", "cam0"] }]);
    expect(planScenes([tracks[0] as ActivityTrack], duration, params())).toEqual([{ s: 0, e: duration, layout: "solo", sources: ["screen"] }]);
  });

  it("features the screen only while it is shared and follows the speaker before and after", () => {
    const duration = 60_000;
    const people = conversation([[0, 1000, 12_000], [1, 14_000, 26_000], [0, 28_000, 40_000], [1, 42_000, 58_000]], duration);
    const screen: ActivityTrack = { id: "screen", kind: "screen", levels: new Int8Array(0), range: { s: 13_000, e: 41_000 } };
    const scenes = planScenes([screen, ...people], duration, params());
    expectTiling(scenes, duration, "partial share");
    const during = scenes.filter((scene) => scene.s >= 13_000 && scene.e <= 41_000);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((scene) => scene.layout === "screen-camera" && scene.sources[0] === "screen")).toBe(true);
    const outside = scenes.filter((scene) => scene.e <= 13_000 || scene.s >= 41_000);
    expect(outside.every((scene) => scene.layout === "solo" && !scene.sources.includes("screen"))).toBe(true);
    expect(scenes[0]?.sources[0]).toBe("cam0");
    expect(scenes[scenes.length - 1]?.sources[0]).toBe("cam1");
    // a share that starts or ends within a second of the edges covers the recording as if it had no range
    const edge: ActivityTrack = { ...screen, range: { s: 300, e: duration - 150 } };
    expect(planScenes([edge, ...people], duration, params())).toEqual(planScenes([{ id: "screen", kind: "screen", levels: new Int8Array(0) }, ...people], duration, params()));
  });

  it("does not take the screen's own audio for a speaker", () => {
    const duration = 30_000;
    const loudScreen: ActivityTrack = { id: "screen", kind: "screen", levels: new Int8Array(duration / FRAME).fill(-10) };
    const tracks = [loudScreen, ...conversation([[0, 1000, 12_000], [1, 14_000, 25_000]], duration)];
    const scenes = planScenes(tracks, duration, params());
    expect(scenes.map((scene) => scene.sources[1])).toEqual(["cam0", "cam1"]);
  });

  it("accepts precomputed speech flags", () => {
    const duration = 20_000;
    const flags = (from: number, to: number): Uint8Array => new Uint8Array(duration / FRAME).fill(0).fill(1, from / FRAME, to / FRAME);
    const tracks: ActivityTrack[] = [
      { id: "a", levels: new Int8Array(duration / FRAME).fill(-30), speech: flags(0, 8000) },
      { id: "b", levels: new Int8Array(duration / FRAME).fill(-30), speech: flags(10_000, 20_000) },
    ];
    expect(planScenes(tracks, duration, params()).map((scene) => scene.sources[0])).toEqual(["a", "b"]);
  });
});

describe("planScenes: properties", () => {
  function randomConversation(seed: number, speakers: number, durationMs: number): ActivityTrack[] {
    const next = random(seed);
    const turns: Turn[] = [];
    let at = 0;
    while (at < durationMs) {
      const length = next() < 0.3 ? 150 + next() * 1200 : 1000 + next() * 9000;
      turns.push([Math.floor(next() * speakers), at, at + length]);
      at += length - (next() < 0.25 ? next() * 800 : 0) + (next() < 0.5 ? next() * 2500 : 0);
    }
    return conversation(turns, durationMs, speakers, next() < 0.8 ? -22 - next() * 4 : null, -34 + next() * 12);
  }

  it("tiles the timeline, never makes a scene shorter than the dwell, and is deterministic, for random activity", () => {
    const rhythms: Rhythm[] = ["calm", "balanced", "lively"];
    let scenesChecked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const speakers = 2 + (seed % 3);
      const duration = 20_000 + Math.floor(random(seed * 31)() * 150_000) + (seed % 11) * 7;
      const tracks = randomConversation(seed, speakers, duration);
      for (const rhythm of rhythms) {
        for (const fallback of ["keep", "wide"] as const) {
          for (const layout of ["solo", "speaker-thumbs"] as const) {
            const p = params({ rhythm, fallback, layout });
            const label = `seed ${seed} ${rhythm} ${fallback} ${layout}`;
            const scenes = planScenes(tracks, duration, p);
            expectTiling(scenes, duration, label);
            const dwell = effectiveMinDwellMs(p);
            for (const scene of scenes) expect(scene.e - scene.s, `${label}: ${JSON.stringify(scene)}`).toBeGreaterThanOrEqual(dwell);
            scenes.forEach((scene, index) => {
              if (index > 0) expect(sameScene(scene, scenes[index - 1] as Scene), `${label}: adjacent scenes differ`).toBe(false);
              expect(new Set(scene.sources).size).toBe(speakers);
            });
            expect(planScenes(tracks, duration, p), label).toEqual(scenes);
            scenesChecked += scenes.length;
          }
        }
      }
    }
    expect(scenesChecked).toBeGreaterThan(2000);
  });

  it("makes one scene of a recording shorter than the dwell", () => {
    const tracks = conversation([[0, 100, 1500]], 2000);
    const scenes = planScenes(tracks, 2000, params());
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ s: 0, e: 2000 });
  });

  it("ends on the duration even when it is not a whole number of frames", () => {
    const tracks = conversation([[0, 500, 9000], [1, 11_000, 19_000]], 20_000);
    const scenes = planScenes(tracks, 19_990, params());
    expectTiling(scenes, 19_990);
    expect(scenes[scenes.length - 1]?.e).toBe(19_990);
  });

  it("does not change its input", () => {
    const tracks = conversation([[0, 500, 9000], [1, 11_000, 19_000]], 20_000);
    const copy = tracks.map((track) => Int8Array.from(track.levels));
    planScenes(tracks, 20_000, params({ fallback: "wide" }));
    tracks.forEach((track, index) => expect(track.levels).toEqual(copy[index]));
  });
});

// ---- reading scenes ---------------------------------------------------------------------------------------------------

const scene = (s: number, e: number, first: string, layout: Scene["layout"] = "solo", rest: string[] = ["b"]): Scene => ({ s, e, layout, sources: [first, ...rest] });

describe("sceneAt", () => {
  const scenes = [scene(0, 1000, "a"), scene(1000, 2500, "b"), scene(2500, 2600, "a"), scene(2600, 9000, "b", "grid")];

  it("finds the scene a time is in, a boundary belonging to the scene that starts there", () => {
    expect(sceneAt(scenes, 0)).toBe(scenes[0]);
    expect(sceneAt(scenes, 999)).toBe(scenes[0]);
    expect(sceneAt(scenes, 1000)).toBe(scenes[1]);
    expect(sceneAt(scenes, 2599.5)).toBe(scenes[2]);
    expect(sceneAt(scenes, 2600)).toBe(scenes[3]);
    expect(sceneAt(scenes, 8999)).toBe(scenes[3]);
  });

  it("clamps outside the timeline and gives null for an empty list", () => {
    expect(sceneAt(scenes, -50)).toBe(scenes[0]);
    expect(sceneAt(scenes, 9000)).toBe(scenes[3]);
    expect(sceneAt(scenes, 1e9)).toBe(scenes[3]);
    expect(sceneAt([], 5)).toBeNull();
  });

  it("agrees with a linear search on random scene lists", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const next = random(seed);
      const list: Scene[] = [];
      let at = 0;
      for (let index = 0; index < 1 + Math.floor(next() * 40); index++) {
        const length = 1 + Math.floor(next() * 5000);
        list.push(scene(at, at + length, `s${index}`));
        at += length;
      }
      for (let probe = 0; probe < 100; probe++) {
        const ms = next() * (at + 200) - 100;
        const expected = ms < 0 ? list[0] : (list.find((candidate) => candidate.s <= ms && ms < candidate.e) ?? list[list.length - 1]);
        expect(sceneAt(list, ms)).toBe(expected);
      }
    }
  });
});

// ---- overrides ------------------------------------------------------------------------------------------------------------

/** What the scene at `ms` must be: the automatic one with every override that covers `ms` applied in order. */
function naive(auto: Scene[], overrides: SceneOverride[], ms: number): Scene {
  const base = auto.find((candidate) => candidate.s <= ms && ms < candidate.e) as Scene;
  const out: Scene = { ...base, sources: [...base.sources] };
  for (const override of overrides) {
    if (Math.round(override.s) <= ms && ms < Math.round(override.e)) {
      if (override.layout !== undefined) out.layout = override.layout;
      if (override.sources !== undefined) out.sources = [...override.sources];
      if (override.fit !== undefined) out.fit = override.fit;
    }
  }
  return out;
}

describe("applyOverrides", () => {
  const auto: Scene[] = [scene(0, 10_000, "a"), scene(10_000, 20_000, "b"), scene(20_000, 30_000, "a")];

  it("splits scenes at the edges of an override, which wins over the automatic scene", () => {
    const out = applyOverrides(auto, [{ s: 8000, e: 12_000, layout: "grid" }]);
    expect(out).toEqual([scene(0, 8000, "a"), scene(8000, 10_000, "a", "grid"), scene(10_000, 12_000, "b", "grid"), scene(12_000, 20_000, "b"), scene(20_000, 30_000, "a")]);
  });

  it("applies later overrides over earlier ones, field by field", () => {
    const out = applyOverrides(auto, [
      { s: 2000, e: 8000, layout: "speaker-thumbs", sources: ["b", "a"] },
      { s: 4000, e: 6000, layout: "side-by-side" },
      { s: 5000, e: 9000, fit: "fit" },
    ]);
    expect(out).toEqual([
      scene(0, 2000, "a"),
      { s: 2000, e: 4000, layout: "speaker-thumbs", sources: ["b", "a"] },
      { s: 4000, e: 5000, layout: "side-by-side", sources: ["b", "a"] },
      { s: 5000, e: 6000, layout: "side-by-side", sources: ["b", "a"], fit: "fit" },
      { s: 6000, e: 8000, layout: "speaker-thumbs", sources: ["b", "a"], fit: "fit" },
      { s: 8000, e: 9000, layout: "solo", sources: ["a", "b"], fit: "fit" },
      scene(9000, 10_000, "a"),
      scene(10_000, 20_000, "b"),
      scene(20_000, 30_000, "a"),
    ]);
  });

  it("clips to the span of the automatic scenes and ignores empty or inverted ranges", () => {
    const out = applyOverrides(auto, [{ s: -5000, e: 4000, layout: "grid" }, { s: 28_000, e: 90_000, layout: "grid" }, { s: 7000, e: 7000, layout: "grid" }, { s: 9000, e: 3000, layout: "grid" }]);
    expect(out.map((entry) => [entry.s, entry.e, entry.layout])).toEqual([[0, 4000, "grid"], [4000, 10_000, "solo"], [10_000, 20_000, "solo"], [20_000, 28_000, "solo"], [28_000, 30_000, "grid"]]);
    expect(applyOverrides(auto, [])).toEqual(auto);
    expect(applyOverrides([], [{ s: 0, e: 100, layout: "grid" }])).toEqual([]);
  });

  it("merges neighbours that show the same thing, also across an override that changes nothing", () => {
    expect(applyOverrides(auto, [{ s: 12_000, e: 18_000, layout: "solo" }])).toEqual(auto);
    // an override that makes two scenes alike joins them
    const out = applyOverrides(auto, [{ s: 10_000, e: 20_000, sources: ["a", "b"] }]);
    expect(out).toEqual([scene(0, 30_000, "a")]);
  });

  it("agrees with applying the overrides one moment at a time, for random overrides", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const next = random(seed);
      const base: Scene[] = [];
      let at = 0;
      for (let index = 0; index < 2 + Math.floor(next() * 12); index++) {
        const length = 500 + Math.floor(next() * 9000);
        base.push({ s: at, e: at + length, layout: next() < 0.5 ? "solo" : "speaker-thumbs", sources: next() < 0.5 ? ["a", "b", "c"] : ["b", "a", "c"] });
        at += length;
      }
      const overrides: SceneOverride[] = Array.from({ length: Math.floor(next() * 8) }, () => {
        const s = next() * (at + 2000) - 1000;
        const override: SceneOverride = { s, e: s + next() * 12_000 };
        if (next() < 0.5) override.layout = next() < 0.5 ? "grid" : "side-by-side";
        if (next() < 0.4) override.sources = next() < 0.5 ? ["c", "b", "a"] : ["a", "c", "b"];
        if (next() < 0.3) override.fit = next() < 0.5 ? "fit" : "fill";
        return override;
      });
      const out = applyOverrides(base, overrides);
      expectTiling(out, at, `seed ${seed}`);
      out.forEach((entry, index) => {
        if (index > 0) expect(sameScene(entry, out[index - 1] as Scene), `seed ${seed}: neighbours merged`).toBe(false);
      });
      for (let probe = 0; probe < 60; probe++) {
        const ms = Math.floor(next() * at);
        const expected = naive(base, overrides, ms);
        const got = sceneAt(out, ms) as Scene;
        expect(sameScene(got, expected), `seed ${seed} at ${ms}: ${JSON.stringify(got)} vs ${JSON.stringify(expected)}`).toBe(true);
      }
    }
  });

  it("does not change its input", () => {
    const frozen = auto.map((entry) => Object.freeze({ ...entry, sources: Object.freeze([...entry.sources]) as string[] }));
    const overrides = [Object.freeze({ s: 3000, e: 12_000, sources: Object.freeze(["b", "a"]) as string[] })];
    const out = applyOverrides(frozen, overrides);
    out[0]?.sources.push("z");
    expect(frozen[0]?.sources).toEqual(["a", "b"]);
    expect(overrides[0]?.sources).toEqual(["b", "a"]);
  });
});

describe("scene plan and its history", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
  };

  it("adds, removes and clears overrides without touching the plan it was given", () => {
    const empty = deepFreeze(newPlan());
    const one = addOverride(empty, { s: 1000.4, e: 5000.6, layout: "grid" });
    expect(one.overrides).toEqual([{ s: 1000, e: 5001, layout: "grid" }]);
    expect(empty.overrides).toEqual([]);
    const two = addOverride(deepFreeze(one), { s: 3000, e: 4000, sources: ["b", "a"] });
    expect(two.overrides).toHaveLength(2);
    expect(one.overrides).toHaveLength(1);
    expect(removeOverrideAt(deepFreeze(two), 0).overrides).toEqual([two.overrides[1]]);
    expect(removeOverrideAt(two, 5)).toBe(two);
    expect(removeOverrideAt(two, -1)).toBe(two);
    expect(clearOverrides(deepFreeze(two)).overrides).toEqual([]);
    expect(two.overrides).toHaveLength(2);
    expect(clearOverrides(empty)).toBe(empty);
    expect(addOverride(empty, { s: 500, e: 500, layout: "grid" })).toBe(empty);
    // a copy of the sources, not the caller's array
    const sources = ["b", "a"];
    const added = addOverride(empty, { s: 0, e: 10, sources });
    sources.push("c");
    expect(added.overrides[0]?.sources).toEqual(["b", "a"]);
  });

  it("drops an earlier override that a later one covers and overwrites completely", () => {
    let plan = newPlan();
    plan = addOverride(plan, { s: 2000, e: 4000, layout: "grid" });
    plan = addOverride(plan, { s: 6000, e: 8000, layout: "solo", sources: ["a"] });
    plan = addOverride(plan, { s: 1000, e: 9000, layout: "side-by-side", sources: ["b"] });
    expect(plan.overrides).toEqual([{ s: 1000, e: 9000, layout: "side-by-side", sources: ["b"] }]);
    // one that sets more than the later one stays
    plan = addOverride(newPlan(), { s: 2000, e: 4000, layout: "grid", fit: "fit" });
    plan = addOverride(plan, { s: 1000, e: 5000, layout: "solo" });
    expect(plan.overrides).toHaveLength(2);
    // and so does one that sticks out
    plan = addOverride(newPlan(), { s: 2000, e: 6000, layout: "grid" });
    plan = addOverride(plan, { s: 1000, e: 5000, layout: "solo" });
    expect(plan.overrides).toHaveLength(2);
  });

  it("changes the parameters without touching the overrides", () => {
    const plan = addOverride(newPlan(), { s: 0, e: 1000, layout: "grid" });
    const lively = setParams(plan, { rhythm: "lively" });
    expect(lively.params.rhythm).toBe("lively");
    expect(lively.overrides).toBe(plan.overrides);
    expect(plan.params.rhythm).toBe("balanced");
    expect(setParams(plan, { rhythm: "balanced" })).toBe(plan);
  });

  it("undoes and redoes every change, the way the edit decision list does", () => {
    let history = newPlanHistory(deepFreeze(newPlan()));
    const states: ScenePlan[] = [history.present];
    const steps: ((plan: ScenePlan) => ScenePlan)[] = [
      (plan) => addOverride(plan, { s: 0, e: 5000, layout: "grid" }),
      (plan) => addOverride(plan, { s: 4000, e: 9000, sources: ["b", "a"] }),
      (plan) => setParams(plan, { layout: "speaker-thumbs" }),
      (plan) => removeOverrideAt(plan, 0),
      (plan) => clearOverrides(plan),
    ];
    for (const step of steps) {
      history = commitPlan(history, deepFreeze(step(history.present)));
      states.push(history.present);
    }
    expect(history.past).toHaveLength(5);
    // a change that changes nothing is not recorded
    expect(commitPlan(history, history.present)).toBe(history);
    expect(commitPlan(history, clearOverrides(history.present))).toBe(history);
    for (let index = states.length - 2; index >= 0; index--) {
      history = undoPlan(history);
      expect(history.present).toEqual(states[index]);
    }
    expect(undoPlan(history)).toBe(history);
    expect(history.future).toHaveLength(5);
    for (let index = 1; index < states.length; index++) {
      history = redoPlan(history);
      expect(history.present).toEqual(states[index]);
    }
    expect(redoPlan(history)).toBe(history);
    // a new change after an undo drops what could have been redone
    history = undoPlan(undoPlan(history));
    history = commitPlan(history, addOverride(history.present, { s: 100, e: 200, layout: "solo" }));
    expect(history.future).toEqual([]);
    expect(redoPlan(history)).toBe(history);
  });

  it("makes overrides win over the automatic scenes and undoable", () => {
    const duration = 40_000;
    const tracks = conversation([[0, 500, 15_000], [1, 17_000, 38_000]], duration);
    let history = newPlanHistory(newPlan(params()));
    const auto = planScenes(tracks, duration, history.present.params);
    const resolved = (): Scene[] => applyOverrides(auto, history.present.overrides);
    expect(resolved()).toEqual(auto);
    history = commitPlan(history, addOverride(history.present, { s: 20_000, e: 30_000, layout: "side-by-side" }));
    expect((sceneAt(resolved(), 25_000) as Scene).layout).toBe("side-by-side");
    expect(featuredAt(resolved(), 25_000)).toBe("cam1");
    expect((sceneAt(resolved(), 35_000) as Scene).layout).toBe("solo");
    history = commitPlan(history, addOverride(history.present, { s: 24_000, e: 26_000, sources: ["cam0", "cam1"] }));
    expect(featuredAt(resolved(), 25_000)).toBe("cam0");
    history = undoPlan(history);
    expect(featuredAt(resolved(), 25_000)).toBe("cam1");
    history = undoPlan(history);
    expect(resolved()).toEqual(auto);
    history = redoPlan(redoPlan(history));
    expect(featuredAt(resolved(), 25_000)).toBe("cam0");
  });
});

// ---- the edit decision list --------------------------------------------------------------------------------------------------

describe("remapScenes", () => {
  const scenes: Scene[] = [scene(0, 10_000, "a"), scene(10_000, 20_000, "b"), scene(20_000, 30_000, "a"), scene(30_000, 40_000, "b")];
  const edlOf = (...ranges: [number, number][]): Edl => ranges.reduce((edl, [s, e]) => removeRange(edl, { s, e }, 40_000), EMPTY_EDL);

  it("is the identity without cuts", () => {
    expect(remapScenes(scenes, EMPTY_EDL)).toEqual(scenes);
  });

  it("shrinks the scene a cut falls into and shifts the ones after it", () => {
    expect(remapScenes(scenes, edlOf([12_000, 15_000]))).toEqual([scene(0, 10_000, "a"), scene(10_000, 17_000, "b"), scene(17_000, 27_000, "a"), scene(27_000, 37_000, "b")]);
  });

  it("drops a scene that is cut out entirely, merging the neighbours that now look alike", () => {
    // b (10 s..20 s) is gone: a and a meet
    expect(remapScenes(scenes, edlOf([10_000, 20_000]))).toEqual([scene(0, 20_000, "a"), scene(20_000, 30_000, "b")]);
    // a cut across several scenes
    expect(remapScenes(scenes, edlOf([5000, 35_000]))).toEqual([scene(0, 5000, "a"), scene(5000, 10_000, "b")]);
    expect(remapScenes(scenes, edlOf([0, 40_000]))).toEqual([]);
  });

  it("lets a scene become shorter than the dwell because of a cut", () => {
    const out = remapScenes(scenes, edlOf([10_500, 20_000], [20_000, 29_000]));
    // b keeps 500 ms
    expect(out).toEqual([scene(0, 10_000, "a"), scene(10_000, 10_500, "b"), scene(10_500, 11_500, "a"), scene(11_500, 21_500, "b")]);
    expect((out[1] as Scene).e - (out[1] as Scene).s).toBeLessThan(DEFAULT_SCENE_PARAMS.minDwellMs);
  });

  it("keeps the picture at every kept moment, for random cuts", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const next = random(seed);
      const base: Scene[] = [];
      let at = 0;
      for (let index = 0; index < 3 + Math.floor(next() * 15); index++) {
        const length = 800 + Math.floor(next() * 7000);
        base.push(scene(at, at + length, next() < 0.5 ? "a" : "b", next() < 0.5 ? "solo" : "grid"));
        at += length;
      }
      let edl: Edl = EMPTY_EDL;
      for (let cut = 0; cut < Math.floor(next() * 7); cut++) {
        const s = Math.floor(next() * at);
        edl = removeRange(edl, { s, e: s + 1 + Math.floor(next() * 9000) }, at);
      }
      const kept = keptDuration(edl, at);
      const out = remapScenes(base, edl);
      if (kept === 0) {
        expect(out).toEqual([]);
        continue;
      }
      expectTiling(out, kept, `seed ${seed}`);
      out.forEach((entry, index) => {
        if (index > 0) expect(sameScene(entry, out[index - 1] as Scene), `seed ${seed}: neighbours merged`).toBe(false);
      });
      for (let probe = 0; probe < 60; probe++) {
        const ms = Math.floor(next() * at);
        if (edl.removed.some((range) => range.s <= ms && ms < range.e)) continue;
        expect(sameScene(sceneAt(out, toOutput(edl, ms)) as Scene, sceneAt(base, ms) as Scene), `seed ${seed} at ${ms}`).toBe(true);
      }
    }
  });
});
