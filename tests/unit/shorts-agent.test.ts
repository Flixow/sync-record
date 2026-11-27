// The shorts agent against a local mock of the Anthropic Messages API. No real model, no network beyond loopback, no key
// that is worth anything.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitSentences } from "../../src/shared/clips.js";
import { createLlmClient, type LlmClient } from "../../src/server/post/llm.js";
import { agentClips } from "../../src/server/post/shorts-agent.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const KEY = "sk-ant-test-key-not-real";
const STATEMENTS = [
  "The new model reads the whole file before it answers anything.",
  "Most of the time the slow part is the disk and not the network.",
  "We moved the cache next to the database and the latency dropped.",
  "Nobody on the team expected the migration to finish in one night.",
];
const { words, endMs } = script(Array.from({ length: 100 }, (_, index): Line => ({ pid: index % 2 === 0 ? SPEAKERS.A : SPEAKERS.B, text: STATEMENTS[index % STATEMENTS.length] as string })));
const durationMs = endMs + 3000;
const sentences = splitSentences(words);
const range = (from: number, to: number) => ({ startMs: (sentences[from] as { s: number }).s, endMs: (sentences[to] as { e: number }).e });

interface Seen {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
}

const servers: Server[] = [];

/** A server answering every request with `answer`; `seen` collects what it was sent. */
async function mock(answer: (response: ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen["body"] });
      answer(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const says = (text: unknown) => (response: ServerResponse) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }], stop_reason: "end_turn" }));
};

const llmAt = (url: string, extra: Record<string, unknown> = {}): LlmClient => createLlmClient({ url, provider: "anthropic", apiKey: KEY, model: "test-opus", timeoutMs: 2000, ...extra });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe("agentClips", () => {
  it("sends the transcript text and its timings with the key in x-api-key, and returns the validated reels", async () => {
    const reels = [{ ...range(10, 17), title: "Why the migration finished overnight", hook: "Nobody expected it.", reason: "A complete story.", score: 9 }, { ...range(40, 47), title: "The slow part is the disk", hook: "It is not the network.", reason: "A clear claim.", score: 7 }];
    const server = await mock(says("```json\n" + JSON.stringify({ reels }) + "\n```"));
    const result = await agentClips(llmAt(server.url), { words, durationMs, highlights: [{ tMs: (sentences[12] as { s: number }).s }], timeoutMs: 5000 });
    expect(result.failure).toBeNull();
    expect(result.compression).toBe("none");
    expect(result.clips.map((clip) => clip.title)).toEqual(["Why the migration finished overnight", "The slow part is the disk"]);
    expect(result.clips[0]).toMatchObject({ source: "agent", reasons: ["agent", "marker"], hook: "Nobody expected it." });
    // exactly one request, to the Messages API
    expect(server.seen).toHaveLength(1);
    const [request] = server.seen as [Seen];
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.body.model).toBe("test-opus");
    expect(request.body.max_tokens).toBeGreaterThanOrEqual(4000);
    // what the model saw: text and numbers, no audio or media, no participant ids, no key
    const sent = JSON.stringify(request.body);
    expect(request.body.messages).toHaveLength(1);
    expect(request.body.messages[0]?.content).toContain(`${(sentences[0] as { s: number }).s}-${(sentences[0] as { e: number }).e} S1: ${STATEMENTS[0]}`);
    expect(request.body.messages[0]?.content).toContain("M @ ");
    expect(sent).not.toContain(SPEAKERS.A);
    expect(sent).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("uses the shorts timeout for the call, not the general one", async () => {
    const server = await mock(() => undefined);
    const started = performance.now();
    const result = await agentClips(llmAt(server.url, { timeoutMs: 30_000 }), { words, durationMs, timeoutMs: 150 });
    expect(result).toEqual({ clips: [], failure: "timeout", compression: "none" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reports why there is no list: refused key, overloaded, not JSON, no list, nothing usable", async () => {
    const cases: [string, (response: ServerResponse) => void][] = [
      ["http_401", (response) => { response.statusCode = 401; response.end(JSON.stringify({ type: "error", error: { message: `bad key ${KEY}` } })); }],
      ["http_529", (response) => { response.statusCode = 529; response.end("{}"); }],
      ["not_json", says("I would pick the part about the cache.")],
      ["bad_shape", (response) => response.end(JSON.stringify({ content: [] }))],
      ["bad_shape", says({ answer: "no reels here" })],
      ["no_valid_reels", says({ reels: [] })],
      ["no_valid_reels", says({ reels: [{ startMs: -50_000, endMs: -1, title: "x" }, { ...range(5, 12), title: "" }, { startMs: "1", endMs: "2", title: "x" }] })],
      ["no_valid_reels", says({ reels: [{ startMs: range(5, 12).startMs, endMs: durationMs + 500_000, title: "Past the end" }] })],
    ];
    for (const [code, answer] of cases) {
      const server = await mock(answer);
      const result = await agentClips(llmAt(server.url), { words, durationMs });
      expect(result.clips, code).toEqual([]);
      expect(result.failure, code).toBe(code);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it("makes no request with no model, with no key, or with no speech", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect((await agentClips(createLlmClient(null), { words, durationMs })).failure).toBe("disabled");
    expect((await agentClips(createLlmClient({ provider: "anthropic", apiKey: null, url: null }), { words, durationMs })).failure).toBe("disabled");
    const server = await mock(says({ reels: [] }));
    expect((await agentClips(llmAt(server.url), { words: [], durationMs: 60_000 })).failure).toBe("no_speech");
    expect(server.seen).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("turns a client that throws into a failure instead of an exception", async () => {
    const throwing: LlmClient = { enabled: true, rank: () => Promise.reject(new Error("boom")) };
    expect(await agentClips(throwing, { words, durationMs })).toEqual({ clips: [], failure: "failed", compression: "none" });
  });

  it("works with any provider, since the prompt asks for JSON only", async () => {
    const server = await mock((response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reels: [{ ...range(10, 17), title: "Through a chat-completions server", score: 6 }] }) } }] }));
    });
    const result = await agentClips(createLlmClient({ url: server.url, model: "local", timeoutMs: 2000 }), { words, durationMs });
    expect(result.clips.map((clip) => clip.title)).toEqual(["Through a chat-completions server"]);
    expect(server.seen[0]?.url).toBe("/v1/chat/completions");
  });
});
