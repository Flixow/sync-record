import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioCutGraph } from "../../src/server/post/render-audio.js";
import { issueToken } from "../../src/server/tokens.js";
import { keptDuration } from "../../src/shared/edl.js";
import type { ProjectFile } from "../../src/shared/project.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { probeDuration } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const SID = "edl-fixture-0001";
const DURATION = 60;

describe("cut graph", () => {
  it("fades every join but not the recording's own start and end", () => {
    const graph = audioCutGraph([{ s: 0, e: 1000 }, { s: 2000, e: 3000 }, { s: 4000, e: 5000 }], 5000);
    expect(graph).toContain("concat=n=3:v=0:a=1[out]");
    expect(graph.split("\n")[0]).not.toContain("afade=t=in"); // starts at 0
    expect(graph.split("\n")[0]).toContain("afade=t=out:st=0.995000:d=0.005000");
    expect(graph.split("\n")[2]).toContain("afade=t=in");
    expect(graph.split("\n")[2]).not.toContain("afade=t=out"); // ends with the recording
  });
});

describe.runIf(hasFfmpeg())("EDL, silences and the cut preview", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0" });
    await makeSyntheticSession({ sessionId: SID, storageDir: server.dir, durationSec: DURATION, eventsMs: [5000, 20_000, 40_000], participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false }] });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  it("saves the list with a revision and refuses a stale save", async () => {
    const first = await api(server, "GET", url("/edl"), { token });
    expect(first.body).toMatchObject({ rev: 0, removed: [] });
    const saved = await api(server, "PUT", url("/edl"), { token, json: { baseRev: 0, removed: [{ s: 10_000, e: 12_000 }, { s: 11_000, e: 13_000 }] } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ rev: 1, removed: [{ s: 10_000, e: 13_000 }] });
    const stale = await api(server, "PUT", url("/edl"), { token, json: { baseRev: 0, removed: [] } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "edl_conflict", rev: 1 });
    expect((await api(server, "PUT", url("/edl"), { token, json: { baseRev: 1, removed: [{ s: 5, e: 5 }] } })).status).toBe(400);
  });

  it("finds the silences between the tone bursts", async () => {
    const found = await api(server, "GET", url("/silences?minSilenceMs=1000&keepMs=400"), { token });
    expect(found.status).toBe(200);
    const silences = (found.body as { silences: { startMs: number; endMs: number; cut: { s: number; e: number } }[] }).silences;
    expect(silences.length).toBeGreaterThanOrEqual(3);
    for (const silence of silences) {
      // no burst (120 ms at 5 s, 20 s and 40 s) is touched
      for (const at of [5000, 20_000, 40_000]) expect(silence.cut.e <= at || silence.cut.s >= at + 120).toBe(true);
      expect(silence.endMs - silence.startMs).toBeGreaterThanOrEqual(1000);
    }
    expect((await api(server, "GET", url("/silences?minSilenceMs=5"), { token })).status).toBe(400);
  });

  it("renders the cut preview with the duration of the edit", async () => {
    await api(server, "PUT", url("/edl"), { token, json: { baseRev: 1, removed: [{ s: 6000, e: 18_000 }, { s: 22_000, e: 30_000 }] } });
    const queued = await api(server, "POST", url("/jobs"), { token, json: { kind: "cut-preview" } });
    expect(queued.status).toBe(202);
    await server.app.post.idle();
    const project = ((await api(server, "GET", url(""), { token })).body as { project: ProjectFile }).project;
    const expected = keptDuration({ removed: [{ s: 6000, e: 18_000 }, { s: 22_000, e: 30_000 }] }, project.durationMs);
    const actual = (await probeDuration(path.join(server.dir, "post", SID, "proxies", "mix-cut.m4a"))) * 1000;
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1000 / 30);
  });
});
