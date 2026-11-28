import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import type { JobRecord } from "../../src/shared/project.js";
import { HOOK_MAX_WORDS } from "../../src/shared/thumb-style.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { probeJson } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const run = promisify(execFile);
const SID = "thumbnail-fixture-0001";
const DURATION = 60;
const TOPICS = [
  "The garden needs water every morning because the tomatoes and the roses dry out quickly in summer",
  "Our new database migration moves every customer table to the replicated cluster before the weekend",
  "Training for the marathon means long runs on Sunday and recovery swims during the week",
];

function talk(): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < 12; i++) {
    const words = (TOPICS[Math.floor(i / 4)] as string).split(" ");
    lines.push({ pid: i % 2 === 0 ? SPEAKERS.A : SPEAKERS.B, text: `${words.slice(0, 8 + (i % 4)).join(" ")}${i % 5 === 4 ? "?" : "."}`, gap: 500, pace: 300 });
  }
  return lines;
}

/** Mean luma of the part `w`x`h` at `x`,`y` of the difference of two pictures: how much they differ there. */
async function differenceIn(a: string, b: string, region: { x: number; y: number; w: number; h: number }): Promise<number> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", a, "-i", b, "-filter_complex", `[0][1]blend=all_mode=difference,crop=${region.w}:${region.h}:${region.x}:${region.y},format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-`, "-frames:v", "1", "-f", "null", "-"]);
  const match = /YAVG=([\d.]+)/u.exec(stdout);
  return Number(match?.[1]);
}

describe.runIf(hasFfmpeg())("thumbnail previews, hooks and the headline thumbnail", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;
  const projectFile = (relative: string) => path.join(server.dir, "post", SID, relative);

  async function finished(response: { status: number; body: Record<string, unknown> }): Promise<JobRecord> {
    expect(response.status).toBe(202);
    await server.app.post.idle();
    const job = server.app.post.jobs.get(SID, String(response.body.id));
    if (!job) throw new Error("no such job");
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    return job;
  }

  const sizeOf = async (file: string): Promise<[number, number]> => {
    const info = (await probeJson(file, ["-show_streams"])) as { streams: Record<string, string | number>[] };
    return [Number(info.streams[0]?.width), Number(info.streams[0]?.height)];
  };

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: DURATION,
      eventsMs: [5000, 30_000, 50_000],
      cameraSize: "1280x720",
      cameraFps: 30,
      cameraPicture: "barcode",
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false },
      ],
    });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
    const { words } = script(talk());
    await writeFile(projectFile("transcript.json"), JSON.stringify({ schemaVersion: 1, lang: "en", engine: "test", model: "test", createdAtMs: 0, speakers: [{ pid: SPEAKERS.A, name: "Anna" }, { pid: SPEAKERS.B, name: "Bartek" }], words, bleedDropped: 0, stats: { engineWallSec: 0, speechSec: 0, audioSec: 0 } }));
  }, 180_000);

  afterAll(async () => {
    await server.close();
  });

  it("renders scored preview pictures of real frames, best first", async () => {
    const job = await finished(await api(server, "POST", url("/thumbnail/previews"), { token, json: { kind: "video" } }));
    const previews = (job.result as { previews: { atMs: number; file: string; score: number; weak: string | null }[] }).previews;
    expect(previews.length).toBeGreaterThanOrEqual(3);
    expect(previews.length).toBeLessThanOrEqual(12);
    for (const preview of previews) {
      expect(preview.atMs).toBeGreaterThanOrEqual(0);
      expect(preview.atMs).toBeLessThan(DURATION * 1000);
      expect(await sizeOf(projectFile(preview.file))).toEqual([640, 360]);
      expect((await stat(projectFile(preview.file))).size).toBeGreaterThan(1000);
      expect(preview.score).toBeGreaterThan(0);
      expect(preview.score).toBeLessThanOrEqual(1);
    }
    const scores = previews.map((preview) => preview.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(previews.map((preview) => preview.atMs)).size).toBe(previews.length);
    // the files are served to the page
    const served = await fetch(`${server.base}${url(`/media/${previews[0]?.file}`)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
  }, 120_000);

  it("offers the frames just before and after a chosen one, and 9:16 previews for a Short", async () => {
    const around = 20_000;
    const near = await finished(await api(server, "POST", url("/thumbnail/previews"), { token, json: { kind: "video", around } }));
    const list = (near.result as { around: number; previews: { atMs: number; file: string }[] }).previews;
    expect(list.map((preview) => preview.atMs)).toEqual([19_200, 19_600, 20_400, 20_800]);
    expect((near.result as { around: number }).around).toBe(around);
    expect(await sizeOf(projectFile(list[0]?.file ?? ""))).toEqual([640, 360]);

    const tall = await finished(await api(server, "POST", url("/thumbnail/previews"), { token, json: { kind: "short" } }));
    const shorts = (tall.result as { previews: { file: string }[] }).previews;
    expect(shorts.length).toBeGreaterThan(0);
    expect(await sizeOf(projectFile(shorts[0]?.file ?? ""))).toEqual([360, 640]);

    expect((await api(server, "POST", url("/thumbnail/previews"), { token, json: { around: -1 } })).status).toBe(400);
    expect((await api(server, "POST", url("/thumbnail/previews"), { token, json: { around: 99_999_999 } })).status).toBe(400);
  }, 120_000);

  it("suggests hooks of at most five words that do not repeat the title, with the model off", async () => {
    const response = await api(server, "POST", url("/thumbnail/hooks"), { token, json: { atMs: 4000, llm: true } });
    expect(response.status).toBe(200);
    const body = response.body as { hooks: string[]; title: string; sentence: string; llmUsed: boolean; llmAvailable: boolean };
    expect(body.llmUsed).toBe(false);
    expect(body.llmAvailable).toBe(false);
    expect(body.hooks.length).toBeGreaterThan(0);
    expect(body.hooks.length).toBeLessThanOrEqual(3);
    for (const hook of body.hooks) {
      expect(hook.split(" ").length).toBeLessThanOrEqual(HOOK_MAX_WORDS);
      expect(hook.toLowerCase()).not.toBe(body.title.toLowerCase());
    }
    expect(body.sentence.length).toBeGreaterThan(5);
    const given = await api(server, "POST", url("/thumbnail/hooks"), { token, json: { atMs: 4000, title: "Tomatoes and roses", llm: false } });
    expect((given.body as { title: string }).title).toBe("Tomatoes and roses");
    expect((await api(server, "POST", url("/thumbnail/hooks"), { token, json: { atMs: -1 } })).status).toBe(400);
  });

  it("renders a 4K thumbnail with the headline in the chosen third and only there, and a vertical one with it on top", async () => {
    const make = async (params: Record<string, unknown>): Promise<{ file: string; bytes: number }> => {
      const job = await finished(await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params } }));
      const result = job.result as { file: string; bytes: number };
      return { file: projectFile(result.file), bytes: result.bytes };
    };
    // the face is placed opposite the text, so every side is compared with a text-free render of its own
    const plainLeft = await make({ atMs: 20_000, kind: "video", side: "left" });
    const plainRight = await make({ atMs: 20_000, kind: "video", side: "right" });
    const left = await make({ atMs: 20_000, kind: "video", text: "Why the tomatoes dry out", color: "yellow", side: "left" });
    expect(await sizeOf(left.file)).toEqual([3840, 2160]);
    expect(left.bytes).toBeLessThan(50 * 1024 * 1024);
    const leftThird = { x: 0, y: 0, w: 1280, h: 2160 };
    const rightThird = { x: 2560, y: 0, w: 1280, h: 2160 };
    expect(await differenceIn(plainLeft.file, left.file, leftThird)).toBeGreaterThan(8);
    expect(await differenceIn(plainLeft.file, left.file, rightThird)).toBeLessThan(1);

    const right = await make({ atMs: 20_000, kind: "video", text: "Why the tomatoes dry out", side: "right" });
    expect(await differenceIn(plainRight.file, right.file, rightThird)).toBeGreaterThan(8);
    expect(await differenceIn(plainRight.file, right.file, leftThird)).toBeLessThan(1);

    const tall = await make({ atMs: 20_000, kind: "short", text: "Marathon training" });
    expect(await sizeOf(tall.file)).toEqual([2160, 3840]);
    const exports = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string }[] }).exports;
    expect(exports.filter((item) => item.preset === "thumbnail-video")).toHaveLength(4);
    expect(exports.filter((item) => item.preset === "thumbnail-short")).toHaveLength(1);
    expect((await readFile(left.file)).subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 300_000);

  it("rejects a moment outside the recording", async () => {
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params: { atMs: -5 } } })).status).toBe(400);
    await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params: { atMs: 9_999_999 } } });
    await server.app.post.idle();
    const failed = server.app.post.jobs.list(SID).find((job) => job.kind === "thumbnail" && job.status === "failed");
    expect(failed?.error).toContain("outside the recording");
  });
});
