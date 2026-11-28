import { describe, expect, it } from "vitest";
import { clampZoom, commonOf, dragRange, fitPxPerSec, participantLanes, soundRuns, sourceOverride, tickStepMs, windowColumns } from "../../src/shared/episode-timeline.js";
import type { ProjectFile, ProjectSource } from "../../src/shared/project.js";
import { applyOverrides, type Scene } from "../../src/shared/scenes.js";

function source(patch: Partial<ProjectSource> & Pick<ProjectSource, "id" | "kind" | "participantId">): ProjectSource {
  const audio = patch.kind !== "screen" && patch.kind !== "camera";
  return {
    participantName: patch.participantId,
    segment: 1,
    sourceKey: patch.id,
    offsetMs: 0,
    mediaDurationSec: 60,
    rate: 1,
    driftPpm: 0,
    driftApplied: false,
    driftNote: null,
    timelineDurationMs: 60_000,
    hasAudio: audio,
    hasVideo: !audio,
    width: audio ? null : 1280,
    height: audio ? null : 720,
    audio: audio ? { file: `${patch.id}.flac`, peaks: `${patch.id}.peaks`, levels: `${patch.id}.levels` } : null,
    video: null,
    ...patch,
  };
}

describe("participantLanes", () => {
  const project = {
    participants: [
      { id: "p1-daniel", name: "Daniel", host: true },
      { id: "p2-michal", name: "Michał", host: false },
    ],
    sources: [
      source({ id: "d-mic", kind: "audio", participantId: "p1-daniel" }),
      source({ id: "d-cam", kind: "camera", participantId: "p1-daniel", offsetMs: 1000, timelineDurationMs: 50_000 }),
      source({ id: "d-screen", kind: "screen", participantId: "p1-daniel", offsetMs: 20_000, timelineDurationMs: 10_000 }),
      source({ id: "m-mic-1", kind: "audio", participantId: "p2-michal" }),
      source({ id: "m-mic-2", kind: "audio", participantId: "p2-michal", segment: 2, offsetMs: 70_000 }),
    ],
  } as ProjectFile;

  it("gives each participant the lanes of what was recorded, and a microphone-only participant sound alone", () => {
    const [daniel, michal] = participantLanes(project);
    expect(daniel).toMatchObject({ name: "Daniel", audio: ["d-mic.levels"], camera: [{ s: 1000, e: 51_000 }], screen: [{ s: 20_000, e: 30_000 }] });
    expect(michal).toMatchObject({ name: "Michał", audio: ["m-mic-1.levels", "m-mic-2.levels"], camera: [], screen: [] });
  });

  it("lists a participant that only the sources know, and none without any track", () => {
    const lanes = participantLanes({ participants: [{ id: "p3-silent", name: "Silent", host: false }], sources: [source({ id: "x", kind: "audio", participantId: "p9-late", participantName: "Late" })] } as ProjectFile);
    expect(lanes.map((lane) => lane.name)).toEqual(["Late"]);
  });
});

describe("soundRuns", () => {
  const track = (floor: number, ...parts: [number, number, number][]): Int8Array => {
    const out = new Int8Array(500).fill(floor);
    for (const [from, to, value] of parts) out.fill(value, from, to);
    return out;
  };

  it("names the participant who speaks at each moment and ignores noise", () => {
    const daniel = track(-80, [0, 50, -20], [100, 110, -55]);
    const michal = track(-80, [50, 100, -22]);
    expect(soundRuns([daniel, michal], 10_000)).toEqual([
      { s: 0, e: 1000, who: 0 },
      { s: 1000, e: 2000, who: 1 },
    ]);
  });

  it("closes a short gap inside one voice and drops a blip", () => {
    const levels = track(-80, [0, 20, -20], [25, 45, -20], [200, 204, -20]);
    expect(soundRuns([levels], 10_000)).toEqual([{ s: 0, e: 900, who: 0 }]);
  });
});

describe("zoom and ranges", () => {
  it("never zooms out past the whole recording nor in past the limit", () => {
    expect(fitPxPerSec(100_000, 1000)).toBe(10);
    expect(clampZoom(1, 100_000, 1000)).toBe(10);
    expect(clampZoom(10_000, 100_000, 1000)).toBe(240);
  });

  it("spaces the ruler ticks at a readable distance", () => {
    for (const pps of [0.5, 4, 50, 240]) expect((tickStepMs(pps) / 1000) * pps).toBeGreaterThanOrEqual(84);
  });

  it("orders and snaps a drag, and ignores a click-sized one", () => {
    expect(dragRange(5040, 2010, 30_000)).toEqual({ s: 2000, e: 5000 });
    expect(dragRange(-500, 99_000, 30_000)).toEqual({ s: 0, e: 30_000 });
    expect(dragRange(3000, 3100, 30_000)).toBeNull();
  });

  it("takes the loudest peak of each part of a window", () => {
    const peaks = new Uint8Array(200);
    peaks[150] = 90;
    expect([...windowColumns(peaks, 1000, 2000, 2)]).toEqual([0, 90]);
  });
});

describe("source override", () => {
  const scenes: Scene[] = [
    { s: 0, e: 10_000, layout: "side-by-side", sources: ["cam-a", "card-b"] },
    { s: 10_000, e: 20_000, layout: "solo", sources: ["card-b"] },
  ];

  it("puts the picked source first and keeps the others of the scene at the start behind it", () => {
    const override = sourceOverride(scenes, { s: 2000, e: 6000 }, "card-b");
    expect(override).toEqual({ s: 2000, e: 6000, sources: ["card-b", "cam-a"] });
    const result = applyOverrides(scenes, [override]);
    expect(result.map((scene) => [scene.s, scene.e, scene.sources[0]])).toEqual([[0, 2000, "cam-a"], [2000, 6000, "card-b"], [6000, 10_000, "cam-a"], [10_000, 20_000, "card-b"]]);
  });

  it("reports what a stretch of several scenes has in common", () => {
    expect(commonOf(scenes, (scene) => scene.sources[0])).toBeNull();
    expect(commonOf(scenes.slice(0, 1), (scene) => scene.layout)).toBe("side-by-side");
    expect(commonOf([], (scene) => scene.layout)).toBeNull();
  });
});
