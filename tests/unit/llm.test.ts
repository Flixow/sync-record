import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chaptersForYoutube } from "../../src/shared/chapters.js";
import { suggestClips, type ClipSuggestion } from "../../src/shared/clips.js";
import { draftTitleAndDescription } from "../../src/shared/publish.js";
import { createLlmClient, HttpLlmClient, llmDraft, rerankClips, rerankWithLlm, type LlmClient } from "../../src/server/post/llm.js";
import { script, SPEAKERS, type Line } from "../support/talk.js";

const { A, B } = SPEAKERS;

interface Seen {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
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
      const entry: Seen = { method: request.method, url: request.url, contentType: request.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") };
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

const lines: Line[] = Array.from({ length: 80 }, (_, index) => ({ pid: index % 2 === 0 ? A : B, text: STATEMENTS[index % STATEMENTS.length] as string }));
const { words, endMs } = script(lines);
const clips = suggestClips({ words, durationMs: endMs, limit: 4 });

const timeoutMs = 2000;
const client = (url: string | null): LlmClient => createLlmClient({ url, model: "test-model", timeoutMs });

describe("with no model configured", () => {
  it("never makes a request and resolves every call to null or the input", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const url of [null, "", "   ", "ftp://127.0.0.1:1", "not a url"]) {
      const llm = client(url);
      expect(llm.enabled).toBe(false);
      expect(await llm.rank({ system: "s", user: "u" })).toBeNull();
      expect(await rerankClips(llm, clips, words)).toBeNull();
      expect(await rerankWithLlm(clips, words, llm)).toBe(clips);
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
    const slow = new HttpLlmClient({ url: server.url, model: "m", timeoutMs: 150 });
    const started = performance.now();
    expect(await slow.rank({ system: "s", user: "u" })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("uses a 30 s timeout unless told otherwise", () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    void createLlmClient({ url: "http://127.0.0.1:1" }).rank({ system: "s", user: "u" });
    expect(spy).toHaveBeenCalledWith(30_000);
  });
});

describe("re-ranking clips", () => {
  const ids = clips.map((clip) => clip.id);

  it("orders by the model's rating, uses its titles and keeps what it left out after the rated ones", async () => {
    const server = await fake(completion({ ratings: [{ id: ids[2], rating: 9, title: "  The migration that\nfinished overnight " }, { id: ids[0], rating: 4 }, { id: ids[3], rating: 9, title: "x".repeat(200) }, { id: "invented", rating: 10 }] }));
    const result = await rerankWithLlm(clips, words, client(server.url));
    expect(result.map((clip) => clip.id)).toEqual([ids[2], ids[3], ids[0], ids[1]]);
    expect(result[0]?.title).toBe("The migration that finished overnight");
    expect(result[1]?.title.length).toBeLessThanOrEqual(70);
    expect(result[2]?.title).toBe(clips[0]?.title);
    expect(result[0]).toEqual({ ...(clips[2] as ClipSuggestion), title: "The migration that finished overnight" });
  });

  it("sends the text of the clips with neutral speaker labels, not participant ids", async () => {
    const server = await fake(completion({ ratings: [{ id: ids[0], rating: 5 }] }));
    await rerankClips(client(server.url), clips, words);
    const sent = JSON.parse((server.seen[0] as Seen).body) as { messages: { role: string; content: string }[] };
    const user = sent.messages[1]?.content as string;
    for (const id of ids) expect(user).toContain(`### ${id}`);
    expect(user).toContain("Speaker 1: ");
    expect(user).toContain("Speaker 2: ");
    expect(user).not.toContain(A);
    expect(sent.messages[0]?.content).toContain("JSON");
  });

  it("asks about at most twelve clips and needs at least two", async () => {
    const server = await fake(completion({ ratings: [{ id: ids[0], rating: 5 }] }));
    expect(await rerankClips(client(server.url), clips.slice(0, 1), words)).toBeNull();
    expect(server.seen).toHaveLength(0);
    const many = suggestClips({ words, durationMs: endMs, limit: 15, minMs: 20_000, maxMs: 25_000 });
    expect(many.length).toBeGreaterThan(12);
    await rerankClips(client(server.url), many, words);
    const user = (JSON.parse((server.seen[0] as Seen).body) as { messages: { content: string }[] }).messages[1]?.content as string;
    expect(user.match(/^### /gm)?.length).toBeLessThanOrEqual(12);
  });

  it("keeps the heuristic result when the answer has the wrong shape or the call fails", async () => {
    const bad: unknown[] = [
      { ratings: "nope" },
      { ratings: [{ id: ids[0], rating: 11 }] },
      { ratings: [{ id: ids[0], rating: "high" }] },
      { ratings: [{ id: ids[0], rating: 5, title: 7 }] },
      { ratings: [{ rating: 5 }] },
      { ratings: [] },
      { ratings: [{ id: "invented", rating: 5 }] },
      ["x"],
    ];
    for (const answer of bad) {
      const server = await fake(completion(answer));
      expect(await rerankWithLlm(clips, words, client(server.url)), JSON.stringify(answer)).toBe(clips);
    }
    const failing = await fake((_request, response) => { response.statusCode = 503; response.end(); });
    expect(await rerankWithLlm(clips, words, client(failing.url))).toBe(clips);
    const throwing: LlmClient = { enabled: true, rank: () => Promise.reject(new Error("boom")) };
    expect(await rerankWithLlm(clips, words, throwing)).toBe(clips);
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
