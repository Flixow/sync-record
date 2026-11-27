import { describe, expect, it } from "vitest";
import { callTiles, gridColumns, type CallMember, type VideoSource } from "../../src/web/lib/call-model.js";

const source = (): VideoSource => ({ attach: (el) => el, detach: (el) => el });
const member = (identity: string, extra: Partial<CallMember> = {}): CallMember => ({
  identity,
  name: identity,
  local: false,
  micOn: true,
  speaking: false,
  camera: null,
  screen: null,
  ...extra,
});

describe("call tiles", () => {
  it("puts remote screens first, then the local camera, then the others in join order", () => {
    const screen = source();
    const tiles = callTiles([member("p2"), member("p1", { local: true }), member("p3", { screen })]);
    expect(tiles.map((tile) => tile.key)).toEqual(["p3:screen", "p1:camera", "p2:camera", "p3:camera"]);
    expect(tiles[0]?.video).toBe(screen);
  });

  it("never draws the screen you are sharing yourself", () => {
    const tiles = callTiles([member("p1", { local: true, screen: source() })]);
    expect(tiles.map((tile) => tile.key)).toEqual(["p1:camera"]);
  });

  it("keeps a camera tile (an avatar) for a participant whose camera is off", () => {
    const [tile] = callTiles([member("p2")]);
    expect(tile).toMatchObject({ kind: "camera", video: null });
  });

  it("uses a stable key per participant and kind", () => {
    const first = callTiles([member("p1"), member("p2")]).map((tile) => tile.key);
    const second = callTiles([member("p2"), member("p1", { camera: source() })]).map((tile) => tile.key);
    expect([...first].sort()).toEqual([...second].sort());
  });
});

describe("grid columns", () => {
  it("grows with the number of cameras", () => {
    expect([0, 1, 2, 3, 4, 5, 9, 10].map(gridColumns)).toEqual([1, 1, 2, 2, 2, 3, 3, 4]);
  });
});
