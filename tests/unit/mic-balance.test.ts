import { describe, expect, it } from "vitest";
import { boostLevels, boostsDb, MAX_BOOST_DB } from "../../src/shared/mic-balance.js";
import { planScenes, DEFAULT_SCENE_PARAMS } from "../../src/shared/scenes.js";

const FRAMES = 50 * 60;
function track(speech: [number, number][], loud: number, floor: number): Int8Array {
  const levels = new Int8Array(FRAMES).fill(floor);
  for (const [from, to] of speech) levels.fill(loud, from * 50, to * 50);
  return levels;
}

describe("mic balance", () => {
  const daniel = track([[2, 8], [14, 20]], -20, -64);
  const michal = track([[8, 14], [20, 26]], -62, -88);

  it("lifts a microphone far under the loudest one, and leaves the others alone", () => {
    expect(boostsDb([daniel, michal])).toEqual([0, 42]);
    expect(boostsDb([daniel, track([[8, 14]], -26, -70)])).toEqual([0, 0]);
    expect(boostsDb([daniel, track([], -70, -70)])).toEqual([0, 0]);
    expect(boostsDb([daniel, track([[8, 14]], -90, -100)])[1]).toBeLessThanOrEqual(MAX_BOOST_DB);
  });

  it("lets the scene planner see the quiet speaker only after the lift", () => {
    const main = (a: Int8Array, b: Int8Array) => planScenes([{ id: "cam", levels: a }, { id: "card", levels: b }], 60_000, DEFAULT_SCENE_PARAMS).map((scene) => scene.sources[0]);
    expect(main(daniel, michal)).not.toContain("card");
    const [, boost] = boostsDb([daniel, michal]);
    expect(main(daniel, boostLevels(michal, boost as number))).toContain("card");
  });
});
