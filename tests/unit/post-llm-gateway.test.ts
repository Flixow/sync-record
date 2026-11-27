// The whole path with a fake OMP gateway standing in for the broker: configuration from the environment, the bearer token,
// the three model-backed features of the project API, and what happens when the gateway refuses or is gone. No real
// model, no network beyond loopback, no paid call.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import { api, hasFfmpeg, SECRET, startServer, testConfig, type TestServer } from "./helpers.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const SID = "gateway-fixture-0001";
const DURATION = 150;
const GATEWAY_TOKEN = "gw-client-token-for-tests-only";
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

interface Call {
  authorization: string | undefined;
  app: string | undefined;
  body: { model: string; messages: { role: string; content: string }[]; response_format?: unknown };
}

/** A gateway that checks the bearer token and answers by what the system prompt asks for. */
interface FakeGateway {
  url: string;
  calls: Call[];
  mode: { value: "ok" | "garbage" | "overloaded" };
  close: () => Promise<void>;
}

async function fakeGateway(): Promise<FakeGateway> {
  const calls: Call[] = [];
  const mode: { value: "ok" | "garbage" | "overloaded" } = { value: "ok" };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call: Call = { authorization: request.headers.authorization, app: request.headers["x-omp-app"] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Call["body"] };
      calls.push(call);
      response.setHeader("content-type", "application/json");
      if (request.url !== "/v1/chat/completions" || call.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
        response.statusCode = request.url === "/v1/chat/completions" ? 401 : 404;
        response.end(JSON.stringify({ error: "refused" }));
        return;
      }
      if (mode.value === "overloaded") {
        response.statusCode = 429;
        response.end("{}");
        return;
      }
      const system = call.body.messages[0]?.content ?? "";
      const user = call.body.messages[1]?.content ?? "";
      let answer: unknown;
      if (mode.value === "garbage") answer = "I am sorry, I cannot do that.";
      else if (system.includes("plan the picture")) {
        // fence the JSON like Claude does when it is not forced into a JSON mode
        answer = "```json\n" + JSON.stringify({ segments: [{ i: 0, layout: "side-by-side", highlight: "Opening exchange" }, { i: 1, layout: "carousel" }, { i: 1, cut: "A long pause" }] }) + "\n```";
      } else if (system.includes("title the chapters")) answer = { titles: (user.match(/### Chapter \d+/gu) ?? []).map((_, index) => `Gateway chapter ${index + 1}`) };
      else if (system.includes("YouTube metadata")) answer = { titles: ["Gateway title one", "Gateway title two", "Gateway title three"], summary: "A summary written by the gateway.", tags: ["gateway"] };
      else if (system.includes("best short clips")) answer = { ratings: [] };
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("configuration of the gateway provider", () => {
  const base = { TOKEN_SIGNING_SECRET: SECRET };

  it("is off unless LLM_URL is set, whatever else is set", () => {
    expect(testConfig("/tmp/x", { LLM_PROVIDER: "omp-gateway", LLM_API_KEY: "k" }).post.llm).toBeNull();
    expect(testConfig("/tmp/x").post.llm).toBeNull();
  });

  it("reads the token from the environment or from a file, never both, and refuses to send it in the clear", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-llm-"));
    const file = path.join(dir, "token");
    await writeFile(file, `${GATEWAY_TOKEN}\n`);
    const gateway = { LLM_URL: "http://127.0.0.1:4000", LLM_PROVIDER: "omp-gateway", LLM_MODEL: "anthropic/test" };
    expect(testConfig(dir, { ...gateway, LLM_API_KEY_FILE: file }).post.llm).toMatchObject({ provider: "omp-gateway", apiKey: GATEWAY_TOKEN, model: "anthropic/test", timeoutMs: 60_000 });
    expect(testConfig(dir, { ...gateway, LLM_API_KEY: "from-env", LLM_TIMEOUT_MS: "5000" }).post.llm).toMatchObject({ apiKey: "from-env", timeoutMs: 5000 });
    expect(() => testConfig(dir, { ...gateway, LLM_API_KEY: "a", LLM_API_KEY_FILE: file })).toThrow(/not both/);
    expect(() => testConfig(dir, { ...gateway, LLM_API_KEY_FILE: path.join(dir, "missing") })).toThrow(/cannot be read/);
    expect(() => testConfig(dir, { LLM_URL: "http://127.0.0.1:4000", LLM_PROVIDER: "omp-gateway", LLM_API_KEY: "k" })).toThrow(/LLM_MODEL/);
    expect(() => testConfig(dir, { ...gateway })).toThrow(/LLM_API_KEY/);
    expect(() => testConfig(dir, { ...gateway, LLM_API_KEY: "k", LLM_URL: "http://192.168.1.10:4000" })).toThrow(/unencrypted/);
    expect(() => testConfig(dir, { ...gateway, LLM_API_KEY: "k", LLM_URL: "http://100.100.1.2:8766" })).not.toThrow();
    expect(() => testConfig(dir, { ...gateway, LLM_API_KEY: "k", LLM_URL: "https://llm.example.com" })).not.toThrow();
    expect(() => testConfig(dir, { ...gateway, LLM_PROVIDER: "carrier-pigeon", LLM_API_KEY: "k" })).toThrow(/LLM_PROVIDER/);
    expect(() => testConfig(dir, { ...base, LLM_URL: "ftp://x" })).toThrow(/http or https/);
    // a plain local server needs no key and keeps working as before
    expect(testConfig(dir, { LLM_URL: "http://127.0.0.1:8080" }).post.llm).toMatchObject({ provider: "openai-compatible", apiKey: null, model: "default" });
  });
});

describe.runIf(hasFfmpeg())("project API through a fake gateway", () => {
  let gateway: FakeGateway;
  let server: TestServer;
  let off: TestServer;
  let token: string;
  let dir: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;

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
    const { words } = script(talk());
    await writeFile(path.join(target.dir, "post", SID, "transcript.json"), JSON.stringify({ schemaVersion: 1, lang: "en", engine: "test", model: "test", createdAtMs: 0, speakers: [{ pid: SPEAKERS.A, name: "Anna" }, { pid: SPEAKERS.B, name: "Bartek" }], words, bleedDropped: 0, stats: { engineWallSec: 0, speechSec: 0, audioSec: 0 } }));
  }

  beforeAll(async () => {
    gateway = await fakeGateway();
    dir = await mkdtemp(path.join(tmpdir(), "syncrecord-llm-key-"));
    const keyFile = path.join(dir, "gateway-token");
    await writeFile(keyFile, GATEWAY_TOKEN);
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all", LLM_URL: gateway.url, LLM_PROVIDER: "omp-gateway", LLM_MODEL: "anthropic/test-model", LLM_API_KEY_FILE: keyFile, LLM_TIMEOUT_MS: "5000" });
    off = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await prepare(server);
    await prepare(off);
  }, 300_000);

  afterAll(async () => {
    await server.close();
    await off.close();
    await gateway.close();
  });

  it("sends the token only to the gateway, the model as configured, and no JSON mode", async () => {
    gateway.calls.length = 0;
    const response = await api(server, "POST", url("/publish/draft"), { token, json: { language: "en", llm: true } });
    expect(response.status).toBe(200);
    expect(gateway.calls.length).toBeGreaterThan(0);
    for (const call of gateway.calls) {
      expect(call.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(call.app).toBe("syncrecord");
      expect(call.body.model).toBe("anthropic/test-model");
      expect(call.body).not.toHaveProperty("response_format");
    }
    // the token is nowhere in what the browser gets back
    expect(JSON.stringify(response.body)).not.toContain(GATEWAY_TOKEN);
    const project = await api(server, "GET", url(""), { token });
    expect(JSON.stringify(project.body)).not.toContain(GATEWAY_TOKEN);
    expect((project.body as { settings: { llm: boolean; llmRemote: boolean } }).settings).toMatchObject({ llm: true, llmRemote: false });
  });

  it("retitles the chapters (times and count unchanged), writes the draft and says the model was used", async () => {
    const plain = (await api(server, "GET", url("/chapters"), { token })).body as { chapters: { startMs: number; title: string }[] };
    const response = await api(server, "POST", url("/publish/draft"), { token, json: { language: "en", llm: true } });
    const body = response.body as { draft: { titles: string[]; description: string }; chapters: { startMs: number; title: string }[]; validation: { ok: boolean }; llmUsed: boolean; llmFailure: string | null };
    expect(body.llmUsed).toBe(true);
    expect(body.llmFailure).toBeNull();
    expect(body.draft.titles[0]).toBe("Gateway title one");
    expect(body.chapters.map((chapter) => chapter.startMs)).toEqual(plain.chapters.map((chapter) => chapter.startMs));
    expect(body.chapters.map((chapter) => chapter.title)).toEqual(plain.chapters.map((_, index) => `Gateway chapter ${index + 1}`));
    expect(body.validation.ok).toBe(true);
    expect(body.draft.description).toContain("Gateway chapter 1");
    expect(body.draft.description).toContain("A summary written by the gateway.");
  });

  it("suggests a scene plan: valid layouts become overrides, an invalid one is dropped, a highlight is advisory, the saved plan is untouched", async () => {
    const before = (await api(server, "GET", url("/scenes"), { token })).body as { rev: number; plan: { overrides: unknown[] } };
    gateway.calls.length = 0;
    const response = await api(server, "POST", url("/scenes/suggest"), { token, json: { llm: true } });
    expect(response.status).toBe(200);
    const body = response.body as { source: string; segments: number; overrides: { s: number; e: number; layout: string; sources?: string[] }[]; highlights: { s: number; e: number; reason: string }[]; cuts: { reason: string }[]; llmFailure: string | null };
    expect(body.source).toBe("llm");
    expect(body.segments).toBeGreaterThan(0);
    expect(body.highlights).toEqual([expect.objectContaining({ reason: "Opening exchange" })]);
    // the short fixture is one segment, so the cut aimed at a second segment has nowhere to go; the unit tests cover cuts
    expect(body.cuts).toEqual([]);
    for (const override of body.overrides) {
      expect(override.layout).toBe("side-by-side");
      expect(override.e).toBeGreaterThan(override.s);
    }
    // what the model got: numbers and text per segment, not media
    const prompt = gateway.calls[0]?.body.messages[1]?.content ?? "";
    expect(prompt).toMatch(/#0 0:00-/u);
    expect(prompt).toMatch(/speech \d+%, overlap \d+%, silence \d+%/u);
    const after = (await api(server, "GET", url("/scenes"), { token })).body as { rev: number; plan: { overrides: unknown[] } };
    expect(after.rev).toBe(before.rev);
    expect(after.plan.overrides).toEqual(before.plan.overrides);
  });

  it("uses the model for the scene plan, the clips and the publish draft when the request does not say, and makes no request with llm: false", async () => {
    gateway.calls.length = 0;
    const scene = (await api(server, "POST", url("/scenes/suggest"), { token, json: {} })).body as { source: string };
    const draft = (await api(server, "POST", url("/publish/draft"), { token, json: { language: "en" } })).body as { llmUsed: boolean };
    await api(server, "POST", url("/clips/suggest"), { token, json: { limit: 3 } });
    expect(scene.source).toBe("llm");
    expect(draft.llmUsed).toBe(true);
    // the scene plan, the chapter titles, the draft and the clips: at least one request each
    expect(gateway.calls.length).toBeGreaterThanOrEqual(4);
    const calls = gateway.calls.length;
    const optedOut = (await api(server, "POST", url("/scenes/suggest"), { token, json: { llm: false } })).body as { source: string };
    expect(optedOut.source).toBe("rules");
    expect(((await api(server, "POST", url("/publish/draft"), { token, json: { language: "en", llm: false } })).body as { llmUsed: boolean }).llmUsed).toBe(false);
    await api(server, "POST", url("/clips/suggest"), { token, json: { limit: 3, llm: false } });
    expect(gateway.calls.length).toBe(calls);
  });

  it("falls back to the rules, with a reason code, when the gateway refuses, is overloaded, answers rubbish or is gone", async () => {
    const check = async (expectedFailure: string): Promise<void> => {
      const scene = (await api(server, "POST", url("/scenes/suggest"), { token, json: { llm: true } })).body as { source: string; overrides: unknown[]; llmFailure: string | null; llmAvailable: boolean };
      expect(scene.source, expectedFailure).toBe("rules");
      expect(scene.overrides, expectedFailure).toEqual([]);
      expect(scene.llmAvailable).toBe(true);
      expect(scene.llmFailure, expectedFailure).toBe(expectedFailure);
      const draft = (await api(server, "POST", url("/publish/draft"), { token, json: { language: "en", llm: true } })).body as { draft: { titles: string[] }; llmUsed: boolean; llmFailure: string | null };
      expect(draft.llmUsed, expectedFailure).toBe(false);
      expect(draft.draft.titles).toHaveLength(3);
      expect(draft.llmFailure, expectedFailure).toBe(expectedFailure);
      const clips = (await api(server, "POST", url("/clips/suggest"), { token, json: { limit: 3, llm: true } })).body as { suggestions: unknown[]; llmUsed: boolean };
      expect(clips.suggestions.length).toBeGreaterThan(0);
      expect(clips.llmUsed).toBe(false);
    };
    gateway.mode.value = "overloaded";
    await check("http_429");
    gateway.mode.value = "garbage";
    await check("not_json");
    gateway.mode.value = "ok";
    await gateway.close();
    await check("network");
  });

  it("without a configured model, or with llm: false, makes no request and still gives the rule-based lists", async () => {
    gateway = await fakeGateway();
    const calls = gateway.calls.length;
    const scene = (await api(off, "POST", url("/scenes/suggest"), { token, json: { llm: true } })).body as { source: string; overrides: unknown[]; highlights: { reason: string }[]; cuts: { s: number; e: number; reason: string }[]; llmAvailable: boolean; llmFailure: string | null };
    expect(scene).toMatchObject({ source: "rules", overrides: [], llmAvailable: false, llmFailure: null });
    expect(scene.highlights.length).toBeGreaterThan(0);
    for (const cut of scene.cuts) expect(cut.e - cut.s).toBeGreaterThanOrEqual(4000);
    const unasked = (await api(server, "POST", url("/scenes/suggest"), { token, json: { llm: false } })).body as { source: string; llmAvailable: boolean };
    expect(unasked).toMatchObject({ source: "rules", llmAvailable: true });
    expect(gateway.calls.length).toBe(calls);
    expect((await readFile(path.join(off.dir, "post", SID, "transcript.json"), "utf8")).length).toBeGreaterThan(0);
  });

  it("refuses a scene suggestion before the transcript exists", async () => {
    const empty = await startServer({ POST_MIN_FREE_GB: "0" });
    try {
      expect((await api(empty, "POST", `/api/sessions/none-0000000001/project/scenes/suggest`, { token, json: {} })).status).toBeGreaterThanOrEqual(400);
    } finally {
      await empty.close();
    }
  });
});
