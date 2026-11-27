import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activityTracks, microphoneOf } from "../../src/server/post/layout-plan.js";
import { parseScenes } from "../../src/server/post/scenes-store.js";
import type { ProjectFile, ProjectSource } from "../../src/shared/project.js";

function source(patch: Partial<ProjectSource> & Pick<ProjectSource, "id" | "kind">): ProjectSource {
  const hasAudio = patch.kind === "audio";
  return {
    participantId: "p1",
    participantName: "Anna",
    segment: 1,
    sourceKey: patch.id,
    offsetMs: 0,
    mediaDurationSec: 60,
    rate: 1,
    driftPpm: 0,
    driftApplied: false,
    driftNote: null,
    timelineDurationMs: 60_000,
    hasAudio,
    hasVideo: patch.kind !== "audio",
    width: patch.kind === "audio" ? null : 1280,
    height: patch.kind === "audio" ? null : 720,
    audio: hasAudio ? { file: `${patch.id}.flac`, peaks: `${patch.id}.peaks`, levels: `levels/${patch.id}.bin` } : null,
    video: null,
    ...patch,
  };
}

const projectOf = (sources: ProjectSource[]): ProjectFile => ({ sources, durationMs: 300_000 }) as ProjectFile;

describe("microphoneOf", () => {
  // Anna recorded two takes: microphone and camera each twice, the second pair a few minutes later.
  const mic1 = source({ id: "mic1", kind: "audio", segment: 1, offsetMs: 0 });
  const mic2 = source({ id: "mic2", kind: "audio", segment: 2, offsetMs: 120_000 });
  const cam1 = source({ id: "cam1", kind: "camera", segment: 1, offsetMs: 0 });
  const cam2 = source({ id: "cam2", kind: "camera", segment: 2, offsetMs: 120_000 });
  const project = projectOf([mic1, cam1, mic2, cam2, source({ id: "mic-other", kind: "audio", participantId: "p2", offsetMs: 0 })]);

  it("takes the microphone of the same segment, not the participant's first one", () => {
    expect(microphoneOf(project, cam1)?.id).toBe("mic1");
    expect(microphoneOf(project, cam2)?.id).toBe("mic2");
  });

  it("follows the time the two were recording together when the segment numbers differ", () => {
    // only the camera was restarted: its segment 2 still sits over the first microphone
    const restarted = source({ id: "cam-restart", kind: "camera", segment: 2, offsetMs: 20_000, timelineDurationMs: 30_000 });
    expect(microphoneOf(projectOf([mic1, cam1, mic2, restarted]), restarted)?.id).toBe("mic1");
  });

  it("never lends another participant's microphone and falls back to an audio track that does not overlap", () => {
    const lone = source({ id: "cam-lone", kind: "camera", participantId: "p3" });
    expect(microphoneOf(project, lone)).toBeNull();
    const late = source({ id: "cam-late", kind: "camera", segment: 3, offsetMs: 250_000, timelineDurationMs: 10_000 });
    expect(microphoneOf(project, late)).not.toBeNull();
  });
});

describe("activityTracks", () => {
  it("gives every screen segment its own range and every camera its own segment's levels", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-layout-plan-"));
    await mkdir(path.join(dir, "levels"));
    await writeFile(path.join(dir, "levels", "mic1.bin"), Buffer.from(Int8Array.of(-30, -30)));
    await writeFile(path.join(dir, "levels", "mic2.bin"), Buffer.from(Int8Array.of(-40, -40)));
    const project = projectOf([
      source({ id: "mic1", kind: "audio", segment: 1 }),
      source({ id: "mic2", kind: "audio", segment: 2, offsetMs: 120_000 }),
      source({ id: "cam1", kind: "camera", segment: 1 }),
      source({ id: "cam2", kind: "camera", segment: 2, offsetMs: 120_000 }),
      source({ id: "scr1", kind: "screen", segment: 1, offsetMs: 10_000, timelineDurationMs: 20_000 }),
      source({ id: "scr2", kind: "screen", segment: 2, offsetMs: 130_000, timelineDurationMs: 15_000 }),
    ]);
    const tracks = await activityTracks(project, dir);
    const byId = new Map(tracks.map((track) => [track.id, track]));
    expect(byId.get("scr1")?.range).toEqual({ s: 10_000, e: 30_000 });
    expect(byId.get("scr2")?.range).toEqual({ s: 130_000, e: 145_000 });
    expect(Array.from(byId.get("cam1")?.levels ?? [])).toEqual([-30, -30]);
    expect(Array.from(byId.get("cam2")?.levels ?? [])).toEqual([-40, -40]);
  });
});

describe("parseScenes: the screen switch", () => {
  const body = (params: Record<string, unknown>) => ({ plan: { params: { minDwellMs: 2500, hysteresisDb: 4, hangoverMs: 600, rhythm: "balanced", layout: "solo", fallback: "keep", ...params }, overrides: [] }, aspect: "16:9" });

  it('keeps "off", leaves it out when absent and refuses anything else', () => {
    expect(parseScenes(body({ screen: "off" })).plan.params.screen).toBe("off");
    expect("screen" in parseScenes(body({})).plan.params).toBe(false);
    expect(() => parseScenes(body({ screen: "on" }))).toThrow();
    expect(() => parseScenes(body({ screen: true }))).toThrow();
  });
});
