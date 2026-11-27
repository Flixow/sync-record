// The Suggest clips route with the shorts agent, end to end against a local mock of the Anthropic Messages API: provider and key
// from the environment, one request per click, the model's reels validated, the rule list as the fallback with the reason, and
// the key nowhere in what the browser gets back, in any file the server wrote, or in what it logged. No real model.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import { splitSentences } from "../../src/shared/clips.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const SID = "shorts-agent-fixture-0001";
const DURATION = 150;
const KEY = "sk-ant-route-test-key-not-real";
const TOPICS = [
  "The garden needs water every morning because the tomatoes and the roses dry out quickly in summer",
  "Our new database migration moves every customer table to the replicated cluster before the weekend",
  "Training for the marathon means long runs on Sunday and recovery swims during the week",
];

function talk(): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < 24; i++) {
    const words = (TOPICS[Math.floor(i / 8)] as string).split(" ");
    lines.push({ pid: i % 2 === 0 ? SPEAKERS.A : SPEAKERS.B, text: `${words.slice(0, 8 + (i % 4)).join(" ")}${i % 5 === 4 ? "?" : "."}`, gap: 700, pace: 330 });
  }
  return lines;
}

const { words } = script(talk());
const sentences = splitSentences(words);
const reels = [
  { startMs: (sentences[0] as { s: number }).s, endMs: (sentences[6] as { e: number }).e, title: "The garden needs water", hook: "Every morning, without fail.", reason: "A clear claim with a reason.", score: 8 },
  { startMs: (sentences[9] as { s: number }).s + 500, endMs: (sentences[16] as { e: number }).e - 300, title: "A migration in one weekend", hook: "Every customer table moves.", reason: "A small story with a deadline.", score: 9 },
];

interface Call {
  url: string | undefined;
  key: string | string[] | undefined;
  version: string | string[] | undefined;
  body: { model: string; system: string; messages: { content: string }[] };
}

interface Mock {
  url: string;
  calls: Call[];
  mode: { value: "ok" | "unauthorized" | "garbage" | "empty" };
  close: () => Promise<void>;
}

async function mockAnthropic(): Promise<Mock> {
  const calls: Call[] = [];
  const mode: Mock["mode"] = { value: "ok" };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({ url: request.url, key: request.headers["x-api-key"], version: request.headers["anthropic-version"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Call["body"] });
      response.setHeader("content-type", "application/json");
      if (request.url !== "/v1/messages" || request.headers["x-api-key"] !== KEY || mode.value === "unauthorized") {
        response.statusCode = 401;
        response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${String(request.headers["x-api-key"])}` } }));
        return;
      }
      const text = mode.value === "garbage" ? "Here are my favourite moments, in prose." : JSON.stringify({ reels: mode.value === "empty" ? [] : reels });
      response.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text }], stop_reason: "end_turn" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    mode,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Every file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    if ((await stat(full)).isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

interface Suggestion {
  s: number;
  e: number;
  title: string;
  source?: string;
  hook?: string;
  why?: string;
  reasons: string[];
}
interface SuggestBody {
  suggestions: Suggestion[];
  source: string;
  llmUsed: boolean;
  llmAvailable: boolean;
  llmFailure: string | null;
}

describe.runIf(hasFfmpeg())("Suggest clips with the shorts agent", () => {
  let mock: Mock;
  let server: TestServer;
  let off: TestServer;
  let keyless: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;
  const suggest = async (target: TestServer, json: unknown): Promise<SuggestBody> => {
    const response = await api(target, "POST", url("/clips/suggest"), { token, json });
    expect(response.status).toBe(200);
    return response.body as unknown as SuggestBody;
  };

  async function prepare(target: TestServer): Promise<void> {
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: target.dir,
      durationSec: DURATION,
      eventsMs: [5000, 60_000, 120_000],
      cameraSize: "640x360",
      cameraFps: 30,
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
      ],
    });
    await api(target, "POST", url(""), { token });
    await api(target, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await target.app.post.idle();
    await writeFile(path.join(target.dir, "post", SID, "transcript.json"), JSON.stringify({ schemaVersion: 1, lang: "en", engine: "test", model: "test", createdAtMs: 0, speakers: [{ pid: SPEAKERS.A, name: "Anna" }, { pid: SPEAKERS.B, name: "Bartek" }], words, bleedDropped: 0, stats: { engineWallSec: 0, speechSec: 0, audioSec: 0 } }));
  }

  beforeAll(async () => {
    mock = await mockAnthropic();
    const common = { POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" };
    server = await startServer({ ...common, LLM_PROVIDER: "anthropic", LLM_URL: mock.url, ANTHROPIC_API_KEY: KEY, LLM_MODEL: "test-opus", LLM_TIMEOUT_MS: "5000", SHORTS_TIMEOUT_MS: "5000" });
    off = await startServer(common);
    keyless = await startServer({ ...common, LLM_PROVIDER: "anthropic", LLM_URL: mock.url });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await Promise.all([prepare(server), prepare(off), prepare(keyless)]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([server.close(), off.close(), keyless.close()]);
    await mock.close();
  });

  it("cuts the clips with the model: valid, snapped reels with the hook and reason, source agent, one request", async () => {
    mock.calls.length = 0;
    const body = await suggest(server, { limit: 10, llm: true });
    expect(mock.calls).toHaveLength(1);
    expect(body).toMatchObject({ source: "agent", llmUsed: true, llmAvailable: true, llmFailure: null });
    expect(body.suggestions.map((clip) => clip.title)).toEqual(["A migration in one weekend", "The garden needs water"]);
    const starts = new Set(sentences.map((sentence) => sentence.s));
    const ends = new Set(sentences.map((sentence) => sentence.e));
    for (const clip of body.suggestions) {
      expect(starts.has(clip.s) && ends.has(clip.e)).toBe(true);
      expect(clip.e - clip.s).toBeGreaterThanOrEqual(20_000);
      expect(clip.e - clip.s).toBeLessThanOrEqual(90_000);
      expect(clip).toMatchObject({ source: "agent", reasons: expect.arrayContaining(["agent"]) });
      expect(clip.hook).toBeTruthy();
      expect(clip.why).toBeTruthy();
    }
    const [call] = mock.calls as [Call];
    expect(call).toMatchObject({ url: "/v1/messages", key: KEY, version: "2023-06-01" });
    expect(call.body.model).toBe("test-opus");
    // the model gets the transcript as text with exact times, with anonymous speakers
    const prompt = call.body.messages[0]?.content ?? "";
    expect(prompt).toContain(`${(sentences[0] as { s: number }).s}-${(sentences[0] as { e: number }).e} S1: `);
    expect(prompt).not.toContain("Anna");
    expect(prompt).not.toContain(SPEAKERS.A);
  });

  it("asks for at most `count` reels (5 unless told otherwise)", async () => {
    mock.calls.length = 0;
    await suggest(server, { llm: true });
    await suggest(server, { llm: true, count: 2 });
    expect(mock.calls[0]?.body.system).toContain("up to 5 stretches");
    expect(mock.calls[1]?.body.system).toContain("up to 2 stretches");
  });

  it("makes no request unless the request asks for the model, and then gives the rule-based list", async () => {
    mock.calls.length = 0;
    for (const json of [{ limit: 5 }, { limit: 5, llm: false }]) {
      const body = await suggest(server, json);
      expect(body).toMatchObject({ source: "rule", llmUsed: false, llmAvailable: true, llmFailure: null });
      expect(body.suggestions.length).toBeGreaterThan(0);
      for (const clip of body.suggestions) expect(clip.source).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("makes no request when no model or no key is configured, and says the model is not available", async () => {
    mock.calls.length = 0;
    for (const target of [off, keyless]) {
      const body = await suggest(target, { limit: 5, llm: true });
      expect(body).toMatchObject({ source: "rule", llmUsed: false, llmAvailable: false, llmFailure: null });
      expect(body.suggestions.length).toBeGreaterThan(0);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("falls back to the rules, with the failure code, when the model refuses, rambles or has nothing", async () => {
    const rule = (await suggest(off, { limit: 5 })).suggestions;
    for (const [mode, code] of [["unauthorized", "http_401"], ["garbage", "not_json"], ["empty", "no_valid_reels"]] as const) {
      mock.mode.value = mode;
      mock.calls.length = 0;
      const body = await suggest(server, { limit: 5, llm: true });
      expect(mock.calls, mode).toHaveLength(1);
      expect(body, mode).toMatchObject({ source: "rule", llmUsed: false, llmAvailable: true, llmFailure: code });
      expect(body.suggestions, mode).toEqual(rule);
    }
    mock.mode.value = "ok";
    const closed = await mockAnthropic();
    await closed.close();
    const unreachable = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all", LLM_PROVIDER: "anthropic", LLM_URL: closed.url, ANTHROPIC_API_KEY: KEY, SHORTS_TIMEOUT_MS: "2000" });
    try {
      await prepare(unreachable);
      expect(await suggest(unreachable, { limit: 5, llm: true })).toMatchObject({ source: "rule", llmFailure: "network" });
    } finally {
      await unreachable.close();
    }
  }, 120_000);

  it("keeps the key out of every response, every file the server wrote and everything it logged", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (logged.push(String(chunk)), true));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (logged.push(String(chunk)), true));
    const responses: string[] = [];
    try {
      for (const mode of ["ok", "unauthorized", "garbage"] as const) {
        mock.mode.value = mode;
        responses.push(JSON.stringify(await suggest(server, { limit: 5, llm: true })));
      }
      mock.mode.value = "ok";
      responses.push(JSON.stringify((await api(server, "GET", url(""), { token })).body));
      responses.push(JSON.stringify((await api(server, "GET", url("/jobs"), { token })).body));
      responses.push(JSON.stringify((await api(server, "GET", url("/clips"), { token })).body));
    } finally {
      for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
    }
    for (const body of responses) expect(body).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
    const project = (await api(server, "GET", url(""), { token })).body as { settings: { llm: boolean; llmRemote: boolean } };
    expect(project.settings).toMatchObject({ llm: true, llmRemote: false });
    for (const file of await filesUnder(server.dir)) {
      if (/\.(json|jsonl|log|txt|md)$/u.test(file)) expect(await readFile(file, "utf8"), file).not.toContain(KEY);
    }
  }, 120_000);
});
