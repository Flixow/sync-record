import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND, type LayoutSource } from "../../src/shared/layout.js";
import { DEFAULT_SCENE_PARAMS, applyOverrides, newPlan, type Scene, type ScenePlan } from "../../src/shared/scenes.js";
import { ApiError } from "../../src/web/lib/api.js";
import { SAVE_DELAY_MS } from "../../src/web/lib/autosave.js";
import type { ScenesBackend, ScenesBody, ScenesFile } from "../../src/web/lib/project-api.js";
import { SceneState } from "../../src/web/lib/scene-state.js";

const SOURCES: LayoutSource[] = [
  { id: "a", kind: "camera", width: 1280, height: 720 },
  { id: "b", kind: "camera", width: 1280, height: 720 },
];

/** What the server would resolve for a plan: one automatic scene over the program, the overrides on top. */
const resolve = (plan: ScenePlan): Scene[] => applyOverrides([{ s: 0, e: 10_000, layout: plan.params.layout, sources: ["a", "b"] }], plan.overrides);

const file = (rev: number, plan: ScenePlan = newPlan(), extra: Partial<ScenesBody> = {}): ScenesFile => ({
  schemaVersion: 1,
  rev,
  updatedAtMs: 0,
  plan,
  aspect: "16:9",
  background: DEFAULT_BACKGROUND,
  scenes: resolve(plan),
  sources: SOURCES,
  ...extra,
});

/** A server in memory: it checks the base revision like the real one and resolves the scenes of every plan it saves. */
function fakeBackend(initial: ScenesFile) {
  let stored = initial;
  const calls: { baseRev: number; body: ScenesBody }[] = [];
  const backend: ScenesBackend = {
    scenes: async () => stored,
    saveScenes: async (baseRev, body) => {
      calls.push({ baseRev, body });
      if (baseRev !== stored.rev) throw new ApiError(409, "scenes_conflict", { rev: stored.rev });
      stored = file(stored.rev + 1, body.plan, { aspect: body.aspect, background: body.background });
      return stored;
    },
  };
  return { backend, calls, set: (next: ScenesFile) => (stored = next) };
}

describe("scene state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a manual override at once and saves it once, after the delay", async () => {
    const server = fakeBackend(file(2));
    const state = new SceneState(server.backend, file(2));
    state.addOverride({ s: 2000, e: 4000, layout: "side-by-side" });
    expect(state.scenes.map((scene) => [scene.s, scene.e, scene.layout])).toEqual([
      [0, 2000, "solo"],
      [2000, 4000, "side-by-side"],
      [4000, 10_000, "solo"],
    ]);
    expect(state.status).toBe("dirty");
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.baseRev).toBe(2);
    expect(state.status).toBe("saved");
    expect(state.rev).toBe(3);
  });

  it("keeps the old scenes until the server has resolved a changed parameter", async () => {
    const server = fakeBackend(file(0));
    const state = new SceneState(server.backend, file(0));
    state.setParams({ layout: "grid" });
    expect(state.plan.params.layout).toBe("grid");
    expect(state.scenes[0]?.layout).toBe("solo");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(state.scenes[0]?.layout).toBe("grid");
  });

  it("undo and redo land on the scenes the server resolved before, without a request for a saved plan", async () => {
    const server = fakeBackend(file(0));
    const state = new SceneState(server.backend, file(0));
    state.addOverride({ s: 1000, e: 3000, layout: "grid" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);

    state.undo();
    expect(state.scenes).toHaveLength(1);
    expect(state.canRedo).toBe(true);
    state.redo();
    expect(state.scenes).toHaveLength(3);
    // redo returned to the saved plan: nothing to store
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    expect(state.status).toBe("saved");
  });

  it("resets the overrides of a range in one history step", async () => {
    const server = fakeBackend(file(0));
    const state = new SceneState(server.backend, file(0));
    state.addOverride({ s: 1000, e: 2000, layout: "grid" });
    state.addOverride({ s: 5000, e: 6000, layout: "side-by-side" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    state.resetRange(900, 2100);
    expect(state.plan.overrides).toEqual([{ s: 5000, e: 6000, layout: "side-by-side" }]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(state.scenes.map((scene) => scene.layout)).toEqual(["solo", "side-by-side", "solo"]);
    state.undo();
    expect(state.plan.overrides).toHaveLength(2);
  });

  it("saves the shape and the background without putting them in the undo history", async () => {
    const server = fakeBackend(file(0));
    const state = new SceneState(server.backend, file(0));
    state.setAspect("9:16");
    state.setBackground({ kind: "blur", sigma: 40 });
    expect(state.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body.aspect).toBe("9:16");
    expect(server.calls[0]?.body.background).toEqual({ kind: "blur", sigma: 40 });
    // an unchanged value is not a change
    state.setAspect("9:16");
    expect(state.status).toBe("saved");
  });

  it("takes the server's layout and drops its own history after a conflict", async () => {
    const server = fakeBackend(file(1));
    const state = new SceneState(server.backend, file(1));
    state.addOverride({ s: 0, e: 1000, layout: "grid" });
    server.set(file(5, newPlan({ ...DEFAULT_SCENE_PARAMS, layout: "side-by-side" })));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(state.conflict).toBe(true);
    expect(state.rev).toBe(5);
    expect(state.plan.params.layout).toBe("side-by-side");
    expect(state.plan.overrides).toEqual([]);
    expect(state.canUndo).toBe(false);
  });
});
