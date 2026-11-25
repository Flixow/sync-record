import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import type { Scene } from "../../src/shared/scenes.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { barcodeFrames, probeJson } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const SID = "layout-fixture-0001";

describe.runIf(hasFfmpeg())("scenes and layout render", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;
  const plan = (layout: string) => ({ params: { minDwellMs: 2500, hysteresisDb: 4, hangoverMs: 600, rhythm: "balanced", layout, fallback: "keep" }, overrides: [] });

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: 24,
      eventsMs: [3000, 9000, 15_000],
      cameraSize: "640x360",
      cameraFps: 30,
      cameraPicture: "barcode",
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
      ],
    });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
  }, 180_000);

  afterAll(async () => {
    await server.close();
  });

  it("saves the plan with a revision, resolves the scenes and refuses stale or invalid saves", async () => {
    const first = await api(server, "GET", url("/scenes"), { token });
    expect(first.status).toBe(200);
    const body = first.body as { rev: number; scenes: Scene[]; sources: { id: string }[] };
    expect(body.rev).toBe(0);
    expect(body.sources).toHaveLength(2);
    expect(body.scenes[0]?.s).toBe(0);
    const saved = await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 0, plan: plan("side-by-side"), aspect: "16:9", background: { kind: "color", color: "#101010" } } });
    expect(saved.status).toBe(200);
    expect((saved.body as { rev: number; scenes: Scene[] }).scenes.every((scene) => scene.layout === "side-by-side")).toBe(true);
    expect((await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 0, plan: plan("solo"), aspect: "16:9" } })).status).toBe(409);
    expect((await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 1, plan: plan("carousel"), aspect: "16:9" } })).status).toBe(400);
    expect((await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 1, plan: plan("solo"), aspect: "4:3" } })).status).toBe(400);
  });

  const exportOf = async (preset: string): Promise<string> => {
    await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset } } });
    await server.app.post.idle();
    const list = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string }[] }).exports;
    const record = list.find((item) => item.preset === preset);
    if (!record) throw new Error(`no export for ${preset}`);
    return path.join(server.dir, "post", SID, record.file);
  };

  it("renders a two-camera layout at the 16:9 and 9:16 canvas size with every frame in order", async () => {
    const wide = await exportOf("youtube-1080p30");
    const streams = (await probeJson(wide, ["-show_streams"])) as { streams: Record<string, string | number>[] };
    expect([streams.streams[0]?.width, streams.streams[0]?.height]).toEqual([1920, 1080]);
    // side-by-side shows both pictures; the frame count is the recording length
    expect((await barcodeFrames(wide, 1)).length).toBeGreaterThanOrEqual(24 * 30 - 1);

    await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 1, plan: plan("speaker-thumbs"), aspect: "9:16", background: { kind: "blur", sigma: 40 } } });
    const tall = await exportOf("vertical-1080p30");
    const info = (await probeJson(tall, ["-show_streams", "-show_format"])) as { streams: Record<string, string | number>[]; format: Record<string, string> };
    expect([info.streams[0]?.width, info.streams[0]?.height, info.streams[0]?.profile]).toEqual([1080, 1920, "High"]);
    expect(Math.abs(Number(info.format.duration) - 24)).toBeLessThan(0.1);
  }, 240_000);
});
