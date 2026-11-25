import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import { validateChapters } from "../../src/shared/chapters.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { probeJson } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const SID = "publish-fixture-0001";
const DURATION = 150;
const TOPICS = [
  "The garden needs water every morning because the tomatoes and the roses dry out quickly in summer",
  "Our new database migration moves every customer table to the replicated cluster before the weekend",
  "Training for the marathon means long runs on Sunday and recovery swims during the week",
];

function talk(): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < 24; i++) {
    const topic = TOPICS[Math.floor(i / 8)] as string;
    const words = topic.split(" ");
    lines.push({ pid: i % 2 === 0 ? SPEAKERS.A : SPEAKERS.B, text: `${words.slice(0, 8 + (i % 4)).join(" ")}${i % 5 === 4 ? "?" : "."}`, gap: 700, pace: 330 });
  }
  return lines;
}

describe.runIf(hasFfmpeg())("clips, chapters, drafts and thumbnails", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({ sessionId: SID, storageDir: server.dir, durationSec: DURATION, eventsMs: [5000, 60_000, 120_000], cameraSize: "1280x720", cameraFps: 30, participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true }, { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false }] });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
    const { words } = script(talk());
    await writeFile(path.join(server.dir, "post", SID, "transcript.json"), JSON.stringify({ schemaVersion: 1, lang: "en", engine: "test", model: "test", createdAtMs: 0, speakers: [{ pid: SPEAKERS.A, name: "Anna" }, { pid: SPEAKERS.B, name: "Bartek" }], words, bleedDropped: 0, stats: { engineWallSec: 0, speechSec: 0, audioSec: 0 } }));
  }, 180_000);

  afterAll(async () => {
    await server.close();
  });

  it("suggests clips on sentence boundaries, with reasons, and works with the model off", async () => {
    const response = await api(server, "POST", url("/clips/suggest"), { token, json: { limit: 5, llm: true } });
    expect(response.status).toBe(200);
    const body = response.body as { suggestions: { s: number; e: number; reasons: string[] }[]; llmUsed: boolean; llmAvailable: boolean };
    expect(body.llmUsed).toBe(false);
    expect(body.llmAvailable).toBe(false);
    expect(body.suggestions.length).toBeGreaterThan(0);
    for (const clip of body.suggestions) {
      expect(clip.reasons.length).toBeGreaterThan(0);
      expect(clip.e - clip.s).toBeGreaterThanOrEqual(20_000);
      expect(clip.e - clip.s).toBeLessThanOrEqual(90_000);
    }
  });

  it("stores clips with a revision and refuses a stale or invalid save", async () => {
    const clip = { id: "clip-one", s: 10_000, e: 40_000, preset: "vertical-1080p30", name: "First" };
    const saved = await api(server, "PUT", url("/clips"), { token, json: { baseRev: 0, clips: [clip] } });
    expect(saved.status).toBe(200);
    expect((saved.body as { rev: number; clips: unknown[] }).rev).toBe(1);
    expect((await api(server, "PUT", url("/clips"), { token, json: { baseRev: 0, clips: [] } })).status).toBe(409);
    expect((await api(server, "PUT", url("/clips"), { token, json: { baseRev: 1, clips: [{ ...clip, preset: "nope" }] } })).status).toBe(400);
    expect((await api(server, "PUT", url("/clips"), { token, json: { baseRev: 1, clips: [{ ...clip, e: 9_999_999 }] } })).status).toBe(400);
  });

  it("makes chapters that pass YouTube's rules and a draft without a model", async () => {
    const chapters = await api(server, "GET", url("/chapters"), { token });
    const body = chapters.body as { chapters: { startMs: number; title: string }[]; validation: { ok: boolean }; text: string };
    expect(body.validation.ok).toBe(true);
    expect(body.text.startsWith("00:00 ")).toBe(true);
    expect(validateChapters(body.chapters, DURATION * 1000).ok).toBe(true);
    const draft = await api(server, "POST", url("/publish/draft"), { token, json: { language: "en", llm: true } });
    const d = draft.body as { draft: { titles: string[]; description: string }; llmUsed: boolean };
    expect(d.draft.titles).toHaveLength(3);
    expect(d.draft.titles.every((title) => title.length <= 100)).toBe(true);
    expect(d.draft.description).toContain("Chapters:");
    expect(d.llmUsed).toBe(false);
  });

  it("renders a 4K thumbnail with an overlay, a vertical one, and a clip with captions", async () => {
    const candidates = await api(server, "GET", url("/thumbnails"), { token });
    const list = (candidates.body as { candidates: number[]; spec: { width: number; height: number } });
    expect(list.spec).toMatchObject({ width: 3840, height: 2160 });
    expect(list.candidates.length).toBeGreaterThan(0);
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params: { atMs: -5 } } })).status).toBe(400);
    const sized = async (kind: "video" | "short", text: string): Promise<{ width: number; height: number; bytes: number }> => {
      await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params: { atMs: 61_000, kind, text } } });
      await server.app.post.idle();
      const exports = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string; bytes: number }[] }).exports;
      const record = exports.find((item) => item.preset === `thumbnail-${kind}`);
      if (!record) throw new Error(`no ${kind} thumbnail`);
      const info = (await probeJson(path.join(server.dir, "post", SID, record.file), ["-show_streams"])) as { streams: Record<string, string | number>[] };
      return { width: Number(info.streams[0]?.width), height: Number(info.streams[0]?.height), bytes: record.bytes };
    };
    const wide = await sized("video", "Why the tomatoes dry out");
    expect([wide.width, wide.height]).toEqual([3840, 2160]);
    expect(wide.bytes).toBeLessThan(50 * 1024 * 1024);
    const tall = await sized("short", "Marathon training");
    expect([tall.width, tall.height]).toEqual([2160, 3840]);

    await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "vertical-1080p30", range: { s: 20_000, e: 50_000 }, clip: "clip-one", captions: { style: "karaoke-pop" } } } });
    await server.app.post.idle();
    const exports = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string; durationMs: number }[] }).exports;
    const failed = server.app.post.jobs.list(SID).filter((job) => job.status === "failed").map((job) => job.error);
    const clip = exports.find((item) => item.file.includes("clip-one"));
    expect(failed).toEqual([]);
    expect(clip?.durationMs).toBeGreaterThan(29_900);
    expect(clip?.durationMs).toBeLessThan(30_100);
    const srt = await readFile(path.join(server.dir, "post", SID, (clip?.file ?? "").replace(/\.mp4$/, ".srt")), "utf8");
    expect(srt.length).toBeGreaterThan(20);
  }, 300_000);
});
