import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityTracks } from "../../src/server/post/layout-plan.js";
import { issueToken } from "../../src/server/tokens.js";
import { referenceDb } from "../../src/shared/mic-balance.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const run = promisify(execFile);
const SID = "quiet-mic-fixture-0001";
const ANNA_HZ = 900;
const BARTEK_HZ = 1050;

async function peakNear(file: string, hz: number): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-af", `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, "-f", "null", "-"]);
  const max = /max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1];
  return max === undefined ? -Infinity : Number(max);
}

describe.runIf(hasFfmpeg())("a microphone recorded about 45 dB under the other one", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: 12,
      eventsMs: [2000, 5000, 8000],
      cameraSize: "640x360",
      cameraFps: 30,
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, gainDb: -45 },
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

  it("is lifted for the scene planner, so its owner counts as speaking", async () => {
    const project = await server.app.post.store.require(SID);
    const tracks = await activityTracks(project, server.app.post.store.dir(SID));
    const [camera, card] = tracks.map((track) => referenceDb(track.levels));
    expect(camera).not.toBeNull();
    expect(Math.abs((card ?? -100) - (camera ?? 0))).toBeLessThan(4);
  });

  it("is audible in the preview mix and in the export", async () => {
    const mix = path.join(server.dir, "post", SID, "proxies", "mix.m4a");
    expect(await peakNear(mix, BARTEK_HZ)).toBeGreaterThan((await peakNear(mix, ANNA_HZ)) - 10);
    await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "audio-mp3" } } });
    await server.app.post.idle();
    const list = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string }[] }).exports;
    const file = path.join(server.dir, "post", SID, list.find((item) => item.preset === "audio-mp3")?.file ?? "");
    expect(await peakNear(file, BARTEK_HZ)).toBeGreaterThan((await peakNear(file, ANNA_HZ)) - 10);
  }, 240_000);
});
