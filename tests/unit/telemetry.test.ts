import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createTelemetry, telemetrySettings } from "../../src/server/telemetry.js";
import { api, SECRET, startServer, type TestServer } from "./helpers.js";

interface Captured {
  url: string;
  body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> };
}

/** A local stand-in for the PostHog ingestion endpoint. No real service, key or host is involved. */
let stub: { server: Server; url: string; received: Captured[] };
let server: TestServer | null = null;

beforeEach(async () => {
  const received: Captured[] = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Captured["body"] });
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  stub = { server: http, url: `http://127.0.0.1:${address.port}`, received };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = null;
  stub.server.closeAllConnections();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

/** Creates a session, joins a guest, records, ends. Uses names and an agent string that must never leave the process. */
async function runSession(s: TestServer): Promise<string> {
  const host = (await api(s, "POST", "/api/sessions", { json: { name: "Alex Żółć" }, headers: { "user-agent": "SecretBrowser/9.9" } })).body as { sessionId: string; participantToken: string; inviteToken: string };
  const guest = (await api(s, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "Guest Private Name" } })).body as { participantToken: string };
  const status = (token: string, state: string) => api(s, "POST", `/api/sessions/${host.sessionId}/status`, { token, json: { state, kinds: ["audio", "camera"] } });
  await status(host.participantToken, "recording");
  await status(guest.participantToken, "recording");
  await status(host.participantToken, "stopped");
  await api(s, "POST", `/api/sessions/${host.sessionId}/end`, { token: host.participantToken, json: {} });
  return host.sessionId;
}

describe("telemetry settings", () => {
  it("is off unless both POSTHOG_KEY and POSTHOG_HOST are set", () => {
    const base = { TOKEN_SIGNING_SECRET: SECRET };
    expect(loadConfig(base).telemetry).toBeNull();
    expect(loadConfig({ ...base, POSTHOG_KEY: "stub-key" }).telemetry).toBeNull();
    expect(loadConfig({ ...base, POSTHOG_HOST: "http://127.0.0.1:1" }).telemetry).toBeNull();
    expect(loadConfig({ ...base, POSTHOG_KEY: "", POSTHOG_HOST: "" }).telemetry).toBeNull();
    expect(loadConfig({ ...base, POSTHOG_KEY: "stub-key", POSTHOG_HOST: "http://127.0.0.1:1/" }).telemetry).toEqual({ key: "stub-key", host: "http://127.0.0.1:1" });
    expect(() => telemetrySettings("stub-key", "not a url")).toThrow(/POSTHOG_HOST/);
    expect(() => telemetrySettings("stub-key", "ftp://example.test")).toThrow(/POSTHOG_HOST/);
  });
});

describe("telemetry off (the default)", () => {
  it("makes no network call other than to the collector itself, through a whole session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    server = await startServer();
    expect(server.app.telemetry.enabled).toBe(false);
    await runSession(server);
    await server.app.telemetry.flush();
    const targets = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((url) => !url.startsWith(server!.base))).toEqual([]);
    expect(stub.received).toEqual([]);
  });

  it("stays off with only half of the settings, even with the stub reachable", async () => {
    server = await startServer({ POSTHOG_HOST: stub.url });
    await runSession(server);
    await server.app.telemetry.flush();
    expect(server.app.telemetry.enabled).toBe(false);
    expect(stub.received).toEqual([]);
  });
});

describe("telemetry on", () => {
  it("sends only lifecycle events with counts, and nothing that identifies a person, a file or a session", async () => {
    server = await startServer({ POSTHOG_KEY: "stub-key", POSTHOG_HOST: stub.url });
    const sid = await runSession(server);
    await server.app.telemetry.flush();

    expect(stub.received.map((entry) => entry.body.event)).toEqual(["session_created", "session_joined", "recording_started", "recording_started", "recording_stopped", "session_ended"]);
    expect(new Set(stub.received.map((entry) => entry.url))).toEqual(new Set(["/capture/"]));
    expect(new Set(stub.received.map((entry) => entry.body.api_key))).toEqual(new Set(["stub-key"]));
    for (const { body } of stub.received) {
      expect(body.properties).toMatchObject({ $process_person_profile: false, $geoip_disable: true });
      expect(body.properties).not.toHaveProperty("$ip");
    }
    const ended = stub.received.at(-1)?.body.properties;
    expect(ended).toMatchObject({ participants: 2, audio_tracks: 0, forced: false });

    const wire = JSON.stringify(stub.received);
    for (const secret of ["Alex", "Żółć", "Guest", "Private", "SecretBrowser", sid, SECRET, "p1-alex"]) expect(wire).not.toContain(secret);
    // one stable reference per session, and not the session id
    const refs = new Set(stub.received.map((entry) => entry.body.properties.session));
    expect(refs.size).toBe(1);
  });

  it("reports recorder failures by code only, and refuses codes that are not plain identifiers", async () => {
    server = await startServer({ POSTHOG_KEY: "stub-key", POSTHOG_HOST: stub.url });
    const host = (await api(server, "POST", "/api/sessions", { json: { name: "Alex" } })).body as { sessionId: string; participantToken: string };
    const track = { trackId: "track-audio-1", kind: "audio", mime: "audio/webm", settings: {}, startClientMs: 1, startCallClientMs: 1, offsetMs: 0, rttMs: 1, clockSamples: [] };
    await api(server, "POST", `/api/sessions/${host.sessionId}/tracks`, { token: host.participantToken, json: track });
    await api(server, "POST", `/api/sessions/${host.sessionId}/tracks/track-audio-1/finalize`, {
      token: host.participantToken,
      json: { totalBytes: 0, chunkCount: 0, endClientMs: 2, endReason: "crash", clockSamples: [], markers: [] },
    });
    server.app.telemetry.capture({ name: "error", source: "http", code: "Alex <alex@example.test> failed", status: 500 });
    await server.app.telemetry.flush();
    const errors = stub.received.filter((entry) => entry.body.event === "error").map((entry) => entry.body.properties);
    expect(errors).toEqual([
      expect.objectContaining({ source: "recorder", code: "end_crash" }),
      expect.objectContaining({ source: "http", code: "unknown", status: 500 }),
    ]);
    expect(JSON.stringify(stub.received)).not.toContain("alex");
  });

  it("never fails or slows the collector when the telemetry host is unreachable", async () => {
    const dead = createTelemetry({ key: "stub-key", host: "http://127.0.0.1:1" }, SECRET, "0.0.0");
    expect(() => dead.capture({ name: "session_created", sid: "abc" })).not.toThrow();
    await expect(dead.flush()).resolves.toBeUndefined();
  });
});
