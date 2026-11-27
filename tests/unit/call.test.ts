import { createHmac } from "node:crypto";
import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { callRoomName, issueCallToken, livekitOrigins, type LivekitSettings } from "../../src/server/livekit.js";
import { api, startServer, type TestServer } from "./helpers.js";

// Throw-away values for the tests only; the real key and secret live in the environment of the deployment.
const KEY = "APItestkey0001";
const SECRET = "test-livekit-secret-0123456789abcdef0123";
const settings: LivekitSettings = { url: "wss://rtc.example.test", apiKey: KEY, apiSecret: SECRET, tokenTtlSeconds: 600 };
const verifier = new TokenVerifier(KEY, SECRET);

describe("call token", () => {
  it("is a LiveKit JWT that the LiveKit SDK verifier accepts, scoped to one room and one identity", async () => {
    const issued = issueCallToken(settings, { room: callRoomName("abc123"), identity: "p2-bob", name: "Bob", host: false });
    const claims = await verifier.verify(issued.token);
    expect(claims.sub).toBe("p2-bob");
    expect(claims.name).toBe("Bob");
    expect(claims.video).toMatchObject({ room: "sr-abc123", roomJoin: true, canPublish: true, canSubscribe: true });
  });

  it("gives a guest no data channel and no room admin, and the host both", async () => {
    const guest = (await verifier.verify(issueCallToken(settings, { room: "sr-x", identity: "p2", name: "G", host: false }).token)).video;
    const host = (await verifier.verify(issueCallToken(settings, { room: "sr-x", identity: "p1", name: "H", host: true }).token)).video;
    expect(guest?.canPublishData).toBe(false);
    expect(guest?.roomAdmin).toBeUndefined();
    expect(host?.canPublishData).toBe(true);
    expect(host?.roomAdmin).toBe(true);
    for (const grant of [guest, host]) {
      expect(grant?.canPublishSources).toEqual(["microphone", "camera", "screen_share"]);
      expect(grant?.hidden).toBeUndefined();
      expect(grant?.recorder).toBeUndefined();
    }
  });

  it("expires after the configured short lifetime and not before it starts", async () => {
    const now = Date.UTC(2026, 10, 27, 12, 0, 0);
    const issued = issueCallToken({ ...settings, tokenTtlSeconds: 120 }, { room: "sr-x", identity: "p1", name: "H", host: true }, now);
    expect(issued.expiresAtMs).toBe(now + 120_000);
    const claims = await verifier.verify(issued.token, 0).catch((error: unknown) => error);
    expect(String(claims)).toMatch(/exp/); // verified "now" is far past the 2026 timestamp: expired
    const payload = JSON.parse(Buffer.from(issued.token.split(".")[1] ?? "", "base64url").toString("utf8")) as { nbf: number; exp: number };
    expect(payload.exp - payload.nbf).toBe(120);
  });

  it("is rejected when verified with another secret or key", async () => {
    const issued = issueCallToken(settings, { room: "sr-x", identity: "p1", name: "H", host: true });
    await expect(new TokenVerifier(KEY, "another-secret-0123456789abcdef012345").verify(issued.token)).rejects.toThrow();
    await expect(new TokenVerifier("APIother", SECRET).verify(issued.token)).rejects.toThrow();
    const [head, body] = issued.token.split(".");
    const forged = `${head}.${body}.${createHmac("sha256", "x").update(`${head}.${body}`).digest("base64url")}`;
    await expect(verifier.verify(forged)).rejects.toThrow();
  });
});

describe("LIVEKIT_* configuration", () => {
  const base = { TOKEN_SIGNING_SECRET: "a-long-enough-secret-value" };
  const all = { LIVEKIT_URL: "wss://rtc.example.test", LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET };

  it("is off when none is set and on when all three are", () => {
    expect(loadConfig(base).call).toBeNull();
    expect(loadConfig({ ...base, ...all }).call).toEqual({ url: "wss://rtc.example.test", apiKey: KEY, apiSecret: SECRET, tokenTtlSeconds: 600 });
  });

  it("refuses a partial configuration, a weak secret, a plain-text remote URL and an out-of-range lifetime", () => {
    expect(() => loadConfig({ ...base, LIVEKIT_URL: all.LIVEKIT_URL })).toThrow(/together/);
    expect(() => loadConfig({ ...base, ...all, LIVEKIT_API_SECRET: "short" })).toThrow(/LIVEKIT_API_SECRET/);
    expect(() => loadConfig({ ...base, ...all, LIVEKIT_URL: "ws://rtc.example.test" })).toThrow(/LIVEKIT_URL/);
    expect(() => loadConfig({ ...base, ...all, LIVEKIT_URL: "wss://rtc.example.test/path?x=1" })).toThrow(/LIVEKIT_URL/);
    expect(() => loadConfig({ ...base, ...all, LIVEKIT_TOKEN_TTL_SECONDS: "5" })).toThrow(/LIVEKIT_TOKEN_TTL_SECONDS/);
    expect(loadConfig({ ...base, ...all, LIVEKIT_URL: "ws://127.0.0.1:7880" }).call?.url).toBe("ws://127.0.0.1:7880");
  });

  it("derives the origins the page may connect to", () => {
    expect(livekitOrigins("wss://rtc.example.test")).toEqual({ ws: "wss://rtc.example.test", http: "https://rtc.example.test" });
    expect(livekitOrigins("ws://localhost:7880")).toEqual({ ws: "ws://localhost:7880", http: "http://localhost:7880" });
    expect(livekitOrigins("ftp://rtc.example.test")).toBeNull();
  });
});

describe("POST /api/sessions/:sid/call-token", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  async function start(extra: Record<string, string> = { LIVEKIT_URL: settings.url, LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET }) {
    server = await startServer(extra);
    const created = await api(server, "POST", "/api/sessions", { json: { name: "Alex" } });
    const host = created.body as { sessionId: string; participantId: string; participantToken: string; inviteToken: string };
    const joined = await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "Bea" } });
    const guest = joined.body as { participantId: string; participantToken: string };
    return { host, guest, route: `/api/sessions/${host.sessionId}/call-token` };
  }

  it("hands the host and the guest their own identity, room and grants", async () => {
    const { host, guest, route } = await start();
    const hostCall = await api(server, "POST", route, { token: host.participantToken, json: {} });
    const guestCall = await api(server, "POST", route, { token: guest.participantToken, json: {} });
    expect(hostCall.status).toBe(200);
    expect(hostCall.body).toMatchObject({ url: settings.url, room: `sr-${host.sessionId}`, identity: host.participantId, host: true });
    expect(guestCall.body).toMatchObject({ url: settings.url, room: `sr-${host.sessionId}`, identity: guest.participantId, host: false });
    const hostClaims = await verifier.verify(hostCall.body.token as string);
    const guestClaims = await verifier.verify(guestCall.body.token as string);
    expect(hostClaims).toMatchObject({ sub: host.participantId, name: "Alex" });
    expect(guestClaims).toMatchObject({ sub: guest.participantId, name: "Bea" });
    expect(hostClaims.video?.roomAdmin).toBe(true);
    expect(guestClaims.video?.roomAdmin).toBeUndefined();
    expect(hostCall.body.expiresAtMs as number).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("is for participants only: no token, an invite token or a forged token get nothing", async () => {
    const { host, route } = await start();
    expect((await api(server, "POST", route, { json: {} })).status).toBe(401);
    expect((await api(server, "POST", route, { token: host.inviteToken, json: {} })).status).toBe(403);
    expect((await api(server, "POST", route, { token: "x.y", json: {} })).status).toBe(401);
  });

  it("is refused after the session ended", async () => {
    const { host, route } = await start();
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/end`, { token: host.participantToken, json: {} })).status).toBe(200);
    const refused = await api(server, "POST", route, { token: host.participantToken, json: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("session_ended");
  });

  it("does not exist when no LiveKit server is configured, and the page is not told to offer a call", async () => {
    const { host, route } = await start({});
    const refused = await api(server, "POST", route, { token: host.participantToken, json: {} });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("call_disabled");
    const view = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.participantToken });
    expect(view.body.callEnabled).toBe(false);
    const csp = (await fetch(`${server.base}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self';");
  });

  it("tells the page the call is on and lets it connect to that one LiveKit origin only", async () => {
    const { host } = await start();
    const view = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.participantToken });
    expect(view.body.callEnabled).toBe(true);
    const csp = (await fetch(`${server.base}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' wss://rtc.example.test https://rtc.example.test;");
  });
});
