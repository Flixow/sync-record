import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chaptersForYoutube } from "../../src/shared/chapters.js";
import { draftTitleAndDescription } from "../../src/shared/publish.js";
import { createLlmClient, HttpLlmClient, llmChapterTitles, llmDraft, llmTransport, type LlmClient } from "../../src/server/post/llm.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Fake {
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}

const servers: Server[] = [];

function stop(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A server on an ephemeral loopback port; `answer` decides the response of each request. */
async function fake(answer: (request: Seen, response: ServerResponse) => void): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = { method: request.method, url: request.url, contentType: request.headers["content-type"], headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      answer(entry, response);
    });
  });
  servers.push(server);
  // the server's lib target (ES2023) has no Promise.withResolvers
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => stop(server),
  };
}

/** Answers like a chat-completions server whose model said `content`. */
const completion = (content: unknown) => (_request: Seen, response: ServerResponse) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(stop));
});

const STATEMENTS = [
  "The new model reads the whole file before it answers anything.",
  "Most of the time the slow part is the disk and not the network.",
  "We moved the cache next to the database and the latency dropped.",
  "Nobody on the team expected the migration to finish in one night.",
  "The report shows that three of the five regions are growing fast.",
  "She keeps every old version in a folder named after the release.",
];

const lines: Line[] = Array.from({ length: 80 }, (_, index) => ({ pid: index % 2 === 0 ? SPEAKERS.A : SPEAKERS.B, text: STATEMENTS[index % STATEMENTS.length] as string }));
const { words, endMs } = script(lines);

const timeoutMs = 2000;
const client = (url: string | null): LlmClient => createLlmClient({ url, model: "test-model", timeoutMs });

describe("with no model configured", () => {
  it("never makes a request and resolves every call to null or the input", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const url of [null, "", "   ", "ftp://127.0.0.1:1", "not a url"]) {
      const llm = client(url);
      expect(llm.enabled).toBe(false);
      expect(await llm.rank({ system: "s", user: "u" })).toBeNull();
      expect(await llmDraft(llm, { words, chapters: [], speakers: ["Anna"], language: "en" })).toBeNull();
    }
    expect(createLlmClient(null).enabled).toBe(false);
    expect(createLlmClient(undefined).enabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the chat-completions client", () => {
  it("posts to /v1/chat/completions with the model, both messages and temperature 0, and returns the parsed JSON", async () => {
    const server = await fake(completion({ ok: true, list: [1, 2] }));
    const llm = client(server.url);
    expect(llm.enabled).toBe(true);
    expect(await llm.rank({ system: "be brief", user: "hello", maxTokens: 50 })).toEqual({ ok: true, list: [1, 2] });
    expect(server.seen).toHaveLength(1);
    const [request] = server.seen as [Seen];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.contentType).toBe("application/json");
    expect(JSON.parse(request.body)).toMatchObject({ model: "test-model", temperature: 0, stream: false, max_tokens: 50, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }] });
  });

  it("accepts a base URL that ends with a slash or with /v1", async () => {
    const server = await fake(completion({ a: 1 }));
    expect(await client(`${server.url}/`).rank({ system: "s", user: "u" })).toEqual({ a: 1 });
    expect(await client(`${server.url}/v1`).rank({ system: "s", user: "u" })).toEqual({ a: 1 });
    expect(await client(`${server.url}/v1/`).rank({ system: "s", user: "u" })).toEqual({ a: 1 });
    expect(server.seen.map((request) => request.url)).toEqual(["/v1/chat/completions", "/v1/chat/completions", "/v1/chat/completions"]);
  });

  it("reads JSON the model wrapped in a markdown fence", async () => {
    const server = await fake(completion('```json\n{"fenced": true}\n```'));
    expect(await client(server.url).rank({ system: "s", user: "u" })).toEqual({ fenced: true });
  });

  it("resolves to null on every kind of failure", async () => {
    const closed = await fake(completion({}));
    await closed.close();
    const cases: [string, (request: Seen, response: ServerResponse) => void][] = [
      ["an HTTP error", (_request, response) => { response.statusCode = 500; response.end("boom"); }],
      ["a body that is not JSON", (_request, response) => response.end("<html>")],
      ["no choices", (_request, response) => response.end(JSON.stringify({ choices: [] }))],
      ["content that is not a string", (_request, response) => response.end(JSON.stringify({ choices: [{ message: { content: 5 } }] }))],
      ["content that is not JSON", completion("Sure! Here is my answer.")],
      ["a redirect", (_request, response) => { response.statusCode = 302; response.setHeader("location", "http://127.0.0.1:1/elsewhere"); response.end(); }],
    ];
    for (const [name, answer] of cases) {
      const server = await fake(answer);
      expect(await client(server.url).rank({ system: "s", user: "u" }), name).toBeNull();
    }
    expect(await client(closed.url).rank({ system: "s", user: "u" }), "a refused connection").toBeNull();
  });

  it("gives up after the timeout when the server never answers", async () => {
    const server = await fake(() => undefined);
    const slow = new HttpLlmClient({ url: server.url, model: "m", timeoutMs: 150, provider: "openai-compatible", apiKey: null });
    const started = performance.now();
    expect(await slow.rank({ system: "s", user: "u" })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("uses a 60 s timeout unless told otherwise", () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    void createLlmClient({ url: "http://127.0.0.1:1" }).rank({ system: "s", user: "u" });
    expect(spy).toHaveBeenCalledWith(60_000);
  });
});

const KEY = "sk-ant-test-key-not-real";
const anthropicClient = (url: string | null, extra: Partial<Parameters<typeof createLlmClient>[0] & object> = {}): LlmClient => createLlmClient({ url, model: "test-opus", timeoutMs, provider: "anthropic", apiKey: KEY, ...extra });

/** Answers like the Anthropic Messages API whose model said `text` (optionally after a thinking block). */
const messageAnswer = (text: unknown, extra: Record<string, unknown> = {}) => (_request: Seen, response: ServerResponse) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "test-opus", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }], stop_reason: "end_turn", ...extra }));
};

describe("the Anthropic Messages client", () => {
  it("posts to /v1/messages with x-api-key, the version header, system and one user message, and no sampling parameter", async () => {
    const server = await fake(messageAnswer({ reels: [] }));
    const llm = anthropicClient(server.url);
    expect(llm.enabled).toBe(true);
    expect(await llm.rank({ system: "be brief", user: "hello", maxTokens: 321 })).toEqual({ reels: [] });
    expect(server.seen).toHaveLength(1);
    const [request] = server.seen as [Seen];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.contentType).toBe("application/json");
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({ model: "test-opus", max_tokens: 321, system: "be brief", messages: [{ role: "user", content: "hello" }] });
  });

  it("reads the text blocks (a thinking block is skipped, a fence stripped) and accepts a base URL ending in /v1", async () => {
    const server = await fake(messageAnswer('```json\n{"fenced": true}\n```'));
    expect(await anthropicClient(`${server.url}/v1/`).rank({ system: "s", user: "u" })).toEqual({ fenced: true });
    expect(server.seen[0]?.url).toBe("/v1/messages");
  });

  it("talks to api.anthropic.com and the Opus 5.5 model by default, and sends the key nowhere else", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }), { status: 200 }));
    const llm = createLlmClient({ provider: "anthropic", apiKey: KEY, url: null });
    expect(llm.enabled).toBe(true);
    await llm.rank({ system: "s", user: "u" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("claude-opus-5-5");
  });

  it("is off without a key and then makes no request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const llm = createLlmClient({ provider: "anthropic", apiKey: null, url: null });
    expect(llm.enabled).toBe(false);
    expect(await llm.rank({ system: "s", user: "u" })).toBeNull();
    expect(llm.lastFailure).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves to null with a short code, never a body or the key, on every kind of failure", async () => {
    const closed = await fake(messageAnswer({}));
    await closed.close();
    const cases: [string, string, (request: Seen, response: ServerResponse) => void][] = [
      ["http_401", "an invalid key", (_request, response) => { response.statusCode = 401; response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } })); }],
      ["http_529", "an overloaded API", (_request, response) => { response.statusCode = 529; response.end("{}"); }],
      ["not_json", "an HTML page", (_request, response) => response.end("<html>")],
      ["not_json", "text that is not JSON", messageAnswer("Sure! Here are your reels.")],
      ["bad_shape", "no content list", (_request, response) => response.end(JSON.stringify({ content: "x" }))],
      ["bad_shape", "only a thinking block", (_request, response) => response.end(JSON.stringify({ content: [{ type: "thinking", thinking: "..." }], stop_reason: "end_turn" }))],
      ["bad_shape", "a text block without text", (_request, response) => response.end(JSON.stringify({ content: [{ type: "text" }], stop_reason: "end_turn" }))],
      ["truncated", "an answer cut off by max_tokens", messageAnswer('{"reels":[{"startMs":1', { stop_reason: "max_tokens" })],
      ["too_large", "a huge answer", (_request, response) => response.end(JSON.stringify({ content: [{ type: "text", text: "x".repeat(1_100_000) }] }))],
      ["network", "a redirect", (_request, response) => { response.statusCode = 302; response.setHeader("location", "http://127.0.0.1:1/elsewhere"); response.end(); }],
    ];
    for (const [code, name, answer] of cases) {
      const server = await fake(answer);
      const llm = anthropicClient(server.url);
      expect(await llm.rank({ system: "s", user: "u" }), name).toBeNull();
      expect(llm.lastFailure, name).toBe(code);
      expect(JSON.stringify(llm.lastFailure)).not.toContain(KEY);
    }
    const gone = anthropicClient(closed.url);
    expect(await gone.rank({ system: "s", user: "u" })).toBeNull();
    expect(gone.lastFailure).toBe("network");
  });

  it("gives up after the per-call timeout, which replaces the client's", async () => {
    const server = await fake(() => undefined);
    const llm = anthropicClient(server.url, { timeoutMs: 30_000 });
    const started = performance.now();
    expect(await llm.rank({ system: "s", user: "u", timeoutMs: 150 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(llm.lastFailure).toBe("timeout");
  });
});

describe("drafting titles", () => {
  const chapters = chaptersForYoutube(words, endMs);
  const input = { words, chapters, speakers: ["Anna", "Bartek"], language: "en" as const, name: "Weekly" };

  it("returns the model's titles, a description with the chapters and speakers, and tags within YouTube's limits", async () => {
    const server = await fake(completion({ titles: ["Why the migration finished overnight", "Moving the cache", "Reading logs the right way"], summary: "A talk about caches, migrations and slow disks.", tags: ["cache", "migration", "Disks", "cache"] }));
    const draft = await llmDraft(client(server.url), input);
    expect(draft?.titles).toEqual(["Why the migration finished overnight", "Moving the cache", "Reading logs the right way"]);
    expect(draft?.description.startsWith("A talk about caches, migrations and slow disks.")).toBe(true);
    expect(draft?.description).toContain("Chapters:\n00:00 ");
    expect(draft?.description.endsWith("Speakers: Anna, Bartek")).toBe(true);
    expect(draft?.tags.slice(0, 3)).toEqual(["cache", "migration", "Disks"]);
    expect(draft?.tags.every((tag) => tag.length <= 30)).toBe(true);
    const sent = JSON.parse((server.seen[0] as Seen).body) as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).toContain("English");
    expect(sent.messages[1]?.content).toContain("Weekly");
    expect(sent.messages[1]?.content).toContain("Anna, Bartek");
  });

  it("asks for Polish when the transcript is Polish", async () => {
    const server = await fake(completion({ titles: ["Tytuł"], summary: "Rozmowa o pamięci podręcznej.", tags: ["cache"] }));
    await llmDraft(client(server.url), { ...input, language: "pl" });
    expect((JSON.parse((server.seen[0] as Seen).body) as { messages: { content: string }[] }).messages[0]?.content).toContain("Polish");
  });

  it("fills missing titles from the template and cuts long ones", async () => {
    const server = await fake(completion({ titles: ["Only one", "x".repeat(250)], summary: "Short summary of the talk.", tags: [] }));
    const draft = await llmDraft(client(server.url), input);
    expect(draft?.titles).toHaveLength(3);
    expect(draft?.titles[0]).toBe("Only one");
    expect(draft?.titles.every((title) => title.length <= 100)).toBe(true);
    expect(draft?.tags).toEqual(draftTitleAndDescription(input).tags.slice(0, 15));
  });

  it("returns null for an answer that is not usable", async () => {
    const bad: unknown[] = [{}, { titles: "x", summary: "s", tags: [] }, { titles: [1], summary: "s", tags: [] }, { titles: ["t"], summary: 5, tags: [] }, { titles: ["t"], summary: "s", tags: [3] }, { titles: [], summary: "s", tags: [] }, { titles: ["t"], summary: "  ", tags: [] }, "text"];
    for (const answer of bad) {
      const server = await fake(completion(answer));
      expect(await llmDraft(client(server.url), input), JSON.stringify(answer)).toBeNull();
    }
    const throwing: LlmClient = { enabled: true, rank: () => Promise.reject(new Error("boom")) };
    expect(await llmDraft(throwing, input)).toBeNull();
  });
});

describe("providers and credentials", () => {
  const gateway = (url: string, apiKey: string | null = "gw-test-token"): LlmClient => createLlmClient({ url, model: "anthropic/test-model", timeoutMs, provider: "omp-gateway", apiKey });
  const headersOf = (request: Seen): Seen["headers"] => request.headers;

  it("sends the key as a bearer token and nothing else as a credential", async () => {
    const server = await fake(completion({ ok: true }));
    expect(await createLlmClient({ url: server.url, model: "m", timeoutMs, apiKey: "sk-test-123" }).rank({ system: "s", user: "u" })).toEqual({ ok: true });
    expect(headersOf(server.seen[0] as Seen).authorization).toBe("Bearer sk-test-123");
    expect(headersOf(server.seen[0] as Seen)["x-omp-app"]).toBeUndefined();
    await client(server.url).rank({ system: "s", user: "u" });
    expect(headersOf(server.seen[1] as Seen).authorization).toBeUndefined();
  });

  it("speaks the gateway dialect: bearer, an app name and no json_object mode, which the provider behind it lacks", async () => {
    const server = await fake(completion('```json\n{"via":"gateway"}\n```'));
    const llm = gateway(server.url);
    expect(llm.enabled).toBe(true);
    expect(await llm.rank({ system: "s", user: "u" })).toEqual({ via: "gateway" });
    const [request] = server.seen as [Seen];
    expect(request.url).toBe("/v1/chat/completions");
    expect(headersOf(request).authorization).toBe("Bearer gw-test-token");
    expect(headersOf(request)["x-omp-app"]).toBe("syncrecord");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe("anthropic/test-model");
    expect(body).not.toHaveProperty("response_format");
  });

  it("is off without a token for the gateway and makes no request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const llm = gateway("http://127.0.0.1:1", null);
    expect(llm.enabled).toBe(false);
    expect(await llm.rank({ system: "s", user: "u" })).toBeNull();
    expect(llm.lastFailure).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("never follows a redirect, so the token cannot be sent to another host", async () => {
    const elsewhere = await fake(completion({ stolen: true }));
    const redirecting = await fake((_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", `${elsewhere.url}/v1/chat/completions`);
      response.end();
    });
    expect(await gateway(redirecting.url).rank({ system: "s", user: "u" })).toBeNull();
    expect(elsewhere.seen).toHaveLength(0);
  });

  it("names why a call failed with a short code and never keeps the response body", async () => {
    const cases: [string, (request: Seen, response: ServerResponse) => void][] = [
      ["http_401", (_request, response) => { response.statusCode = 401; response.end("secret-detail gw-test-token"); }],
      ["http_429", (_request, response) => { response.statusCode = 429; response.end("{}"); }],
      ["bad_shape", completion(undefined)],
      ["not_json", (_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] })); }],
    ];
    for (const [code, answer] of cases) {
      const llm = gateway((await fake(answer)).url);
      expect(await llm.rank({ system: "s", user: "u" }), code).toBeNull();
      expect(llm.lastFailure, code).toBe(code);
    }
    const timeout = new HttpLlmClient({ url: (await fake(() => undefined)).url, model: "m", timeoutMs: 100, provider: "omp-gateway", apiKey: "k" });
    expect(await timeout.rank({ system: "s", user: "u" })).toBeNull();
    expect(timeout.lastFailure).toBe("timeout");
    const ok = gateway((await fake(completion({ a: 1 }))).url);
    await ok.rank({ system: "s", user: "u" });
    expect(ok.lastFailure).toBeNull();
  });

  it("tells a service on this machine from one that is not, and a protected path from a clear one", () => {
    const cases: [string, { local: boolean; protectedPath: boolean } | null][] = [
      ["http://127.0.0.1:8080", { local: true, protectedPath: true }],
      ["http://localhost:4000/v1", { local: true, protectedPath: true }],
      ["http://[::1]:4000", { local: true, protectedPath: true }],
      ["http://host.docker.internal:4000", { local: true, protectedPath: true }],
      ["https://api.example.com", { local: false, protectedPath: true }],
      ["http://100.64.0.1:4000", { local: false, protectedPath: true }],
      ["http://100.127.255.254:4000", { local: false, protectedPath: true }],
      ["http://100.128.0.1:4000", { local: false, protectedPath: false }],
      ["http://broker.tail1234.ts.net:4000", { local: false, protectedPath: true }],
      ["http://192.168.1.10:4000", { local: false, protectedPath: false }],
      ["ftp://127.0.0.1", null],
      ["not a url", null],
    ];
    for (const [url, expected] of cases) expect(llmTransport(url), url).toEqual(expected);
  });
});

describe("chapter titles", () => {
  const chapters = chaptersForYoutube(words, endMs);

  it("keeps the start times and the count, takes the model's titles and sends the text of each chapter", async () => {
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    const titles = chapters.map((_, index) => `  Topic ${index + 1}\n${"x".repeat(index === 0 ? 120 : 0)}`);
    const server = await fake(completion({ titles }));
    const result = await llmChapterTitles(client(server.url), chapters, words, "en");
    expect(result?.map((chapter) => chapter.startMs)).toEqual(chapters.map((chapter) => chapter.startMs));
    expect(result?.[1]?.title).toBe("Topic 2");
    expect((result?.[0]?.title.length ?? 99)).toBeLessThanOrEqual(60);
    const sent = JSON.parse((server.seen[0] as Seen).body) as { messages: { content: string }[] };
    expect(sent.messages[1]?.content).toContain("### Chapter 1");
    expect(sent.messages[1]?.content).toContain(`### Chapter ${chapters.length}`);
  });

  it("returns null for the wrong number of titles, non-strings, no change and a model that is off", async () => {
    const bad: unknown[] = [{ titles: ["only one"] }, { titles: chapters.map(() => 1) }, { titles: "x" }, {}, { titles: chapters.map((chapter) => chapter.title) }];
    for (const answer of bad) expect(await llmChapterTitles(client((await fake(completion(answer))).url), chapters, words, "en"), JSON.stringify(answer)).toBeNull();
    expect(await llmChapterTitles(client(null), chapters, words, "en")).toBeNull();
  });

  it("keeps a chapter's own title where the model gave an empty one", async () => {
    const server = await fake(completion({ titles: chapters.map((_, index) => (index === 1 ? "   " : `New ${index}`)) }));
    const result = await llmChapterTitles(client(server.url), chapters, words, "pl");
    expect(result?.[1]?.title).toBe(chapters[1]?.title);
    expect(result?.[2]?.title).toBe("New 2");
    expect((JSON.parse((server.seen[0] as Seen).body) as { messages: { content: string }[] }).messages[0]?.content).toContain("Polish");
  });
});
