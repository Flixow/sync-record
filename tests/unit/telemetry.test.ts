import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetry, telemetryOrigin } from "../../src/server/telemetry.js";
import { api, startServer, testConfig } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEST_KEY = "test-key-not-a-real-project-key";
const NAME = "Zofia Testowa";

interface Capture {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

interface FakePostHog {
  origin: string;
  captures: Capture[];
  paths: string[];
  /** Resolves once this many events have arrived. */
  arrived: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

async function fakePostHog(): Promise<FakePostHog> {
  const captures: Capture[] = [];
  const paths: string[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      paths.push(request.url ?? "");
      captures.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Capture);
      for (const waiter of waiting) if (captures.length >= waiter.count) waiter.resolve();
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    captures,
    paths,
    arrived: (count) => {
      if (captures.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.push({ count, resolve }));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every file under `dir` that is text, skipping what is not part of what ships. */
function files(dir: string, skip: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (skip.includes(name)) return [];
    return statSync(full).isDirectory() ? files(full, skip) : [full];
  });
}

afterEach(() => vi.restoreAllMocks());

describe("telemetry configuration", () => {
  it("is off unless both variables are set", () => {
    expect(testConfig("/tmp/x").telemetry).toBeNull();
    expect(testConfig("/tmp/x", { POSTHOG_KEY: TEST_KEY }).telemetry).toBeNull();
    expect(testConfig("/tmp/x", { POSTHOG_HOST: "https://ph.example.com" }).telemetry).toBeNull();
    expect(testConfig("/tmp/x", { POSTHOG_KEY: " ", POSTHOG_HOST: "https://ph.example.com" }).telemetry).toBeNull();
    expect(testConfig("/tmp/x", { POSTHOG_KEY: TEST_KEY, POSTHOG_HOST: "https://ph.example.com/ignored/path" }).telemetry).toEqual({ key: TEST_KEY, host: "https://ph.example.com" });
  });

  it("refuses a host that would send the key in the clear", () => {
    expect(() => testConfig("/tmp/x", { POSTHOG_KEY: TEST_KEY, POSTHOG_HOST: "http://ph.example.com" })).toThrow(/POSTHOG_HOST/);
    expect(() => testConfig("/tmp/x", { POSTHOG_KEY: TEST_KEY, POSTHOG_HOST: "nonsense" })).toThrow(/POSTHOG_HOST/);
    expect(telemetryOrigin("http://localhost:8000")).toBe("http://localhost:8000");
  });

  it("does nothing at all when off", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const off = createTelemetry(null);
    off.capture("session_created", {});
    expect(off.enabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("telemetry at runtime", () => {
  it("makes no network call to anyone when the variables are unset", async () => {
    const server = await startServer({ POST_MIN_FREE_GB: "0" });
    try {
      const spy = vi.spyOn(globalThis, "fetch");
      const created = await api(server, "POST", "/api/sessions", { json: { name: NAME } });
      expect(created.status).toBe(201);
      const sid = created.body.sessionId as string;
      expect((await api(server, "POST", `/api/sessions/${sid}/end`, { token: created.body.participantToken as string, json: {} })).status).toBe(200);
      const elsewhere = spy.mock.calls.filter(([input]) => !String(input instanceof Request ? input.url : input).startsWith(server.base));
      expect(elsewhere).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("sends only the listed events, with numbers and codes and no names, ids or messages, when both are set", async () => {
    const posthog = await fakePostHog();
    const server = await startServer({ POST_MIN_FREE_GB: "0", POSTHOG_KEY: TEST_KEY, POSTHOG_HOST: posthog.origin });
    try {
      const created = await api(server, "POST", "/api/sessions", { json: { name: NAME } });
      const sid = created.body.sessionId as string;
      const host = created.body.participantToken as string;
      const guest = (await api(server, "POST", `/api/sessions/${sid}/join`, { token: created.body.inviteToken as string, json: { name: "Gość Prywatny" } })).body.participantToken as string;
      const status = (token: string, state: string) => api(server, "POST", `/api/sessions/${sid}/status`, { token, json: { state, kinds: ["audio", "screen"] } });
      await status(host, "recording");
      await status(host, "recording"); // no change: no second event
      await status(guest, "ready");
      await status(host, "stopped");
      await api(server, "POST", `/api/sessions/${sid}/end`, { token: host, json: {} });
      await api(server, "POST", `/api/sessions/${sid}/end`, { token: host, json: {} }); // a repeated end is not a second session end
      await posthog.arrived(5);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const named = (event: string): Capture | undefined => posthog.captures.find((capture) => capture.event === event);
      expect(posthog.captures.map((capture) => capture.event).sort()).toEqual(["recording_started", "recording_stopped", "session_created", "session_ended", "session_joined"]);
      expect(new Set(posthog.paths)).toEqual(new Set(["/capture/"]));
      for (const capture of posthog.captures) {
        expect(capture.api_key).toBe(TEST_KEY);
        expect(capture.properties).toMatchObject({ $process_person_profile: false, $geoip_disable: true });
      }
      expect(named("session_joined")?.properties.participants).toBe(2);
      expect(named("recording_started")?.properties).toMatchObject({ audio: true, camera: false, screen: true });
      expect(named("session_ended")?.properties.participants).toBe(2);
      expect(new Set(posthog.captures.map((capture) => capture.distinct_id)).size).toBe(1);
      const everything = JSON.stringify(posthog.captures);
      for (const secret of [NAME, "Gość", "Prywatny", sid, created.body.participantId as string, created.body.participantToken as string, created.body.inviteToken as string]) expect(everything).not.toContain(secret);
    } finally {
      await server.close();
      await posthog.close();
    }
  });

  it("survives a telemetry host that is gone or slow", async () => {
    const posthog = await fakePostHog();
    const origin = posthog.origin;
    await posthog.close();
    const server = await startServer({ POST_MIN_FREE_GB: "0", POSTHOG_KEY: TEST_KEY, POSTHOG_HOST: origin });
    try {
      expect((await api(server, "POST", "/api/sessions", { json: { name: NAME } })).status).toBe(201);
    } finally {
      await server.close();
    }
  });
});

describe("no key or host ships", () => {
  const KEY = /phc_[A-Za-z0-9]{16,}/u;
  const HOST = /\b(?:us|eu)(?:\.i)?\.posthog\.com\b|\bapp\.posthog\.com\b/u;
  const shipped = [
    ...files(path.join(ROOT, "src")),
    ...files(path.join(ROOT, "tests")),
    ...files(path.join(ROOT, "docs")),
    ...files(path.join(ROOT, "assets")),
    ...["README.md", ".env.example", "Dockerfile", "docker-compose.example.yml", "package.json", "THIRD_PARTY.md"].map((name) => path.join(ROOT, name)).filter(existsSync),
  ];

  it("keeps a PostHog key and host out of the source, fixtures, docs and image inputs", () => {
    expect(shipped.length).toBeGreaterThan(20);
    for (const file of shipped) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      expect(KEY.test(text), file).toBe(false);
      expect(HOST.test(text), file).toBe(false);
    }
  });

  it.runIf(existsSync(path.join(ROOT, "dist")))("keeps them out of the built server and web bundle", () => {
    const built = files(path.join(ROOT, "dist"));
    expect(built.length).toBeGreaterThan(0);
    for (const file of built) {
      const text = readFileSync(file).toString("latin1");
      expect(KEY.test(text), file).toBe(false);
      expect(HOST.test(text), file).toBe(false);
    }
    // the web app has no PostHog client at all
    expect(files(path.join(ROOT, "dist", "web")).some((file) => /posthog/iu.test(readFileSync(file, "latin1")))).toBe(false);
  });
});
