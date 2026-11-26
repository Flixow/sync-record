import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, hasFfmpeg, makeWebm, startServer, type TestServer } from "./helpers.js";

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const declare = (trackId: string, kind = "audio") => ({
  trackId,
  kind,
  mime: "audio/webm;codecs=opus",
  settings: { sampleRate: 48000 },
  startClientMs: 1_000_000,
  startCallClientMs: 999_990,
  offsetMs: 25,
  rttMs: 8,
  clockSamples: [{ atClientMs: 999_000, offsetMs: 24, rttMs: 10 }],
});

const finalizeBody = (totalBytes: number) => ({
  totalBytes,
  chunkCount: 3,
  endClientMs: 1_005_000,
  endReason: "stopped",
  clockSamples: [],
  markers: [{ id: "start-beep-1", kind: "start-beep", atClientMs: 1_000_100, outputLatencyMs: 12 }],
});

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.close();
});

async function session() {
  const created = await api(server, "POST", "/api/sessions", { json: { name: "Alex Żółć" } });
  expect(created.status).toBe(201);
  return created.body as { sessionId: string; participantId: string; participantToken: string; inviteToken: string };
}

describe("sessions and access", () => {
  it("creates a session whose host joins as the first participant", async () => {
    const host = await session();
    expect(host.participantId).toBe("p1-alex-zolc");
    const view = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.participantToken });
    expect(view.body).toMatchObject({ ended: false, maxParticipants: 4 });
  });

  it("renews the caller's token on every visit and keeps the host role", async () => {
    const host = await session();
    const view = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.participantToken });
    const renewed = view.body.renewedToken as string;
    expect(renewed).toBeTruthy();
    const manifest = await api(server, "GET", `/api/sessions/${host.sessionId}/manifest`, { token: renewed });
    expect(manifest.status).toBe(200); // the renewed token is still a host token
  });

  it("lets an invite join, refuses the fifth participant and keeps invite and participant roles apart", async () => {
    const host = await session();
    for (const name of ["B", "C", "D"]) {
      const joined = await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name } });
      expect(joined.status).toBe(201);
    }
    const fifth = await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "E" } });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error).toBe("session_full");

    // a participant token cannot invite, an invite token cannot read the session
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.participantToken, json: { name: "x" } })).status).toBe(403);
    expect((await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.inviteToken })).status).toBe(403);
    expect((await api(server, "GET", `/api/sessions/${host.sessionId}`)).status).toBe(401);
  });

  it("keeps the host's invite link valid: the host's visit renews the invite token, a guest's visit does not", async () => {
    await server.close();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      server = await startServer({ TOKEN_TTL_HOURS: "1" });
      const host = await session();
      vi.advanceTimersByTime(50 * 60_000);
      const view = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: host.participantToken });
      const renewedInvite = view.body.renewedInviteToken as string;
      expect(renewedInvite).toBeTruthy();
      vi.advanceTimersByTime(20 * 60_000); // the first invite is now past its hour, the renewed one is not
      expect((await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "Late" } })).status).toBe(401);
      const joined = await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: renewedInvite, json: { name: "Guest" } });
      expect(joined.status).toBe(201);
      const guestView = await api(server, "GET", `/api/sessions/${host.sessionId}`, { token: joined.body.participantToken as string });
      expect(guestView.body.renewedInviteToken).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restricts host actions to the host", async () => {
    const host = await session();
    const guest = (await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "Guest" } })).body as { participantToken: string };
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/end`, { token: guest.participantToken, json: {} })).status).toBe(403);
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/markers`, { token: guest.participantToken, json: {} })).status).toBe(403);
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/markers`, { token: host.participantToken, json: {} })).status).toBe(201);
  });

  it("gates session creation on SESSION_CREATE_KEY when configured", async () => {
    await server.close();
    server = await startServer({ SESSION_CREATE_KEY: "open-sesame" });
    expect((await api(server, "POST", "/api/sessions", { json: { name: "A" } })).status).toBe(403);
    expect((await api(server, "POST", "/api/sessions", { json: { name: "A", createKey: "wrong" } })).status).toBe(403);
    expect((await api(server, "POST", "/api/sessions", { json: { name: "A", createKey: "open-sesame" } })).status).toBe(201);
    expect((await api(server, "GET", "/api/config")).body.createKeyRequired).toBe(true);
  });

  it("answers the clock handshake with ordered server times", async () => {
    const host = await session();
    const clock = await api(server, "POST", `/api/sessions/${host.sessionId}/clock`, { token: host.participantToken });
    const { serverRecvMs, serverSendMs } = clock.body as { serverRecvMs: number; serverSendMs: number };
    expect(serverSendMs).toBeGreaterThanOrEqual(serverRecvMs);
    expect(Math.abs(serverRecvMs - Date.now())).toBeLessThan(5000);
  });
});

describe("clock in the manifest", () => {
  it("falls back to the best later sample when the handshake before the start could not run", async () => {
    const host = await session();
    const base = `/api/sessions/${host.sessionId}`;
    const trackId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    await api(server, "POST", `${base}/tracks`, {
      token: host.participantToken,
      json: { ...declare(trackId), offsetMs: 0, rttMs: 1e9, clockSamples: [{ atClientMs: 1_000_500, offsetMs: 31, rttMs: 12 }] },
    });
    const manifest = (await api(server, "GET", `${base}/manifest`, { token: host.participantToken })).body as {
      participants: { tracks: { startClientMs: number; startServerMsEstimated: number; clock: { offsetMs: number; uncertaintyMs: number | null } }[] }[];
    };
    const [item] = manifest.participants[0]?.tracks ?? [];
    expect(item?.clock.offsetMs).toBe(31);
    expect(item?.clock.uncertaintyMs).toBe(6);
    expect(item?.startServerMsEstimated).toBe((item?.startClientMs ?? 0) + 31);
  });

  it("reports an unknown uncertainty when no usable sample exists", async () => {
    const host = await session();
    const base = `/api/sessions/${host.sessionId}`;
    const trackId = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
    await api(server, "POST", `${base}/tracks`, { token: host.participantToken, json: { ...declare(trackId), offsetMs: 0, rttMs: 1e9, clockSamples: [] } });
    const manifest = (await api(server, "GET", `${base}/manifest`, { token: host.participantToken })).body as {
      participants: { tracks: { clock: { uncertaintyMs: number | null } }[] }[];
    };
    expect(manifest.participants[0]?.tracks[0]?.clock.uncertaintyMs).toBeNull();
  });
});

describe("chunk intake with resume", () => {
  async function track() {
    const host = await session();
    const trackId = "11111111-2222-3333-4444-555555555555";
    const url = `/api/sessions/${host.sessionId}/tracks/${trackId}`;
    expect((await api(server, "POST", `/api/sessions/${host.sessionId}/tracks`, { token: host.participantToken, json: declare(trackId) })).status).toBe(200);
    const put = (offset: number, body: Buffer, digest = sha(body)) =>
      api(server, "PUT", `${url}/data?offset=${offset}`, { token: host.participantToken, body, headers: { "x-sha256": digest } });
    return { host, trackId, url, put };
  }

  it("appends in order and answers with the new byte count", async () => {
    const { put } = await track();
    expect((await put(0, Buffer.from("HEADER"))).body).toEqual({ received: 6 });
    expect((await put(6, Buffer.from("-chunk2"))).body).toEqual({ received: 13 });
  });

  it("refuses a gap and tells the client where to resume, so a lost header or middle chunk is never skipped", async () => {
    const { put } = await track();
    await put(0, Buffer.from("HEADER"));
    const gap = await put(20, Buffer.from("late"));
    expect(gap.status).toBe(409);
    expect(gap.body).toEqual({ error: "offset_gap", received: 6 });
  });

  it("treats a repeated or overlapping upload as a safe retry", async () => {
    const { put, host, url } = await track();
    await put(0, Buffer.from("HEADER"));
    expect((await put(0, Buffer.from("HEADER"))).body).toEqual({ received: 6 }); // exact repeat
    expect((await put(3, Buffer.from("DERmore"))).body).toEqual({ received: 10 }); // overlap trimmed
    const state = await api(server, "GET", url, { token: host.participantToken });
    expect(state.body).toMatchObject({ received: 10, finalized: false });
  });

  it("rejects a body whose digest does not match", async () => {
    const { put } = await track();
    const bad = await put(0, Buffer.from("HEADER"), sha(Buffer.from("other")));
    expect(bad.status).toBe(422);
    expect((await put(0, Buffer.from("HEADER"))).body).toEqual({ received: 6 });
  });

  it("keeps the byte count across a collector restart", async () => {
    const { put, host, trackId } = await track();
    await put(0, Buffer.from("HEADER"));
    await put(6, Buffer.from("-more"));
    const dir = server.dir;
    await server.close();
    // same storage directory, fresh process state
    const { createApp } = await import("../../src/server/app.js");
    const { LocalStorage } = await import("../../src/server/storage/local.js");
    const { testConfig } = await import("./helpers.js");
    const config = testConfig(dir);
    const app = createApp(config, new LocalStorage(config.localDir));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const state = await fetch(`${base}/api/sessions/${host.sessionId}/tracks/${trackId}`, { headers: { authorization: `Bearer ${host.participantToken}` } });
      expect(await state.json()).toMatchObject({ received: 11, finalized: false });
    } finally {
      app.collector.close();
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
    server = await startServer(); // so afterEach has something to close
  });

  it("stores highlight markers flagged during recording and refuses unknown marker kinds", async () => {
    const { put, host, url } = await track();
    await put(0, Buffer.from("HEADER"));
    const finalize = (kind: string) =>
      api(server, "POST", `${url}/finalize`, {
        token: host.participantToken,
        json: { ...finalizeBody(6), markers: [{ id: "h-1", kind, atClientMs: 1_002_000, outputLatencyMs: null }] },
      });
    expect((await finalize("applause")).status).toBe(400);
    expect((await finalize("highlight")).status).toBe(200);
    const manifest = await api(server, "GET", `/api/sessions/${host.sessionId}/manifest`, { token: host.participantToken });
    const tracks = (manifest.body as { participants: { tracks: { markers: { kind: string; atServerMsEstimated: number }[] }[] }[] }).participants[0]?.tracks;
    expect(tracks?.[0]?.markers[0]).toMatchObject({ kind: "highlight", atServerMsEstimated: 1_002_025 });
  });

  it("does not let one participant touch another's track", async () => {
    const { host, url, trackId } = await track();
    const guest = (await api(server, "POST", `/api/sessions/${host.sessionId}/join`, { token: host.inviteToken, json: { name: "Guest" } })).body as { participantToken: string };
    const body = Buffer.from("x");
    const attempt = await api(server, "PUT", `${url}/data?offset=0`, { token: guest.participantToken, body, headers: { "x-sha256": sha(body) } });
    expect(attempt.status).toBe(403);
    expect(trackId).toBeTruthy();
  });

  it("refuses to finalize while bytes are missing", async () => {
    const { put, host, trackId } = await track();
    await put(0, Buffer.from("HEADER"));
    const early = await api(server, "POST", `/api/sessions/${host.sessionId}/tracks/${trackId}/finalize`, { token: host.participantToken, json: finalizeBody(50) });
    expect(early.status).toBe(409);
    expect(early.body).toEqual({ error: "incomplete", received: 6 });
  });
});

describe.skipIf(!hasFfmpeg())("end of session", () => {
  it("remuxes each finalized track with ffmpeg -c copy and writes the manifest", async () => {
    const host = await session();
    const media = makeWebm(3);
    const trackId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const base = `/api/sessions/${host.sessionId}`;
    await api(server, "POST", `${base}/tracks`, { token: host.participantToken, json: declare(trackId) });

    // three uneven chunks, like timeslices: only the first holds the WebM header
    const cut = [0, Math.floor(media.length / 3) + 7, Math.floor((2 * media.length) / 3) - 5, media.length];
    let offset = 0;
    for (let i = 0; i < 3; i += 1) {
      const piece = media.subarray(cut[i], cut[i + 1]);
      const response = await api(server, "PUT", `${base}/tracks/${trackId}/data?offset=${offset}`, { token: host.participantToken, body: piece, headers: { "x-sha256": sha(piece) } });
      offset = (response.body as { received: number }).received;
    }
    expect(offset).toBe(media.length);
    expect((await api(server, "POST", `${base}/tracks/${trackId}/finalize`, { token: host.participantToken, json: finalizeBody(media.length) })).status).toBe(200);

    const ended = await api(server, "POST", `${base}/end`, { token: host.participantToken, json: {} });
    expect(ended.status).toBe(200);
    await server.app.collector.idle();

    const manifest = JSON.parse((await server.storage.get(`session/${host.sessionId}/manifest.json`))?.toString("utf8") ?? "{}") as {
      schemaVersion: number;
      endedAtServerMs: number;
      participants: { participantId: string; consent: unknown; tracks: { file: string; status: string; durationSec: number; startServerMsEstimated: number; startClientMs: number; markers: unknown[] }[] }[];
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.endedAtServerMs).toBeGreaterThan(0);
    const [participant] = manifest.participants;
    const [item] = participant?.tracks ?? [];
    expect(item).toMatchObject({ file: "audio.webm", status: "ok" });
    expect(item?.durationSec).toBeGreaterThan(2.5);
    expect(item?.startServerMsEstimated).toBe((item?.startClientMs ?? 0) + 25);
    expect(item?.markers).toHaveLength(1);

    const output = await server.storage.get(`session/${host.sessionId}/${participant?.participantId}/audio.webm`);
    expect(output && output.length > 0).toBe(true);
    expect(output?.subarray(0, 4).toString("hex")).toBe("1a45dfa3"); // EBML header
  });

  it("with force, finalizes a track whose owner never came back and processes what arrived", async () => {
    const host = await session();
    const media = makeWebm(2);
    const trackId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    const base = `/api/sessions/${host.sessionId}`;
    await api(server, "POST", `${base}/tracks`, { token: host.participantToken, json: declare(trackId) });
    const body = media.subarray(0, Math.floor(media.length * 0.8));
    await api(server, "PUT", `${base}/tracks/${trackId}/data?offset=0`, { token: host.participantToken, body, headers: { "x-sha256": sha(body) } });

    const plain = await api(server, "POST", `${base}/end`, { token: host.participantToken, json: {} });
    expect((plain.body as { participants: { tracks: { status: string }[] }[] }).participants[0]?.tracks[0]?.status).toBe("receiving");

    await api(server, "POST", `${base}/end`, { token: host.participantToken, json: { force: true } });
    await server.app.collector.idle();
    const manifest = (await api(server, "GET", `${base}/manifest`, { token: host.participantToken })).body as { participants: { tracks: { status: string; endReason: string }[] }[] };
    expect(manifest.participants[0]?.tracks[0]).toMatchObject({ status: "ok", endReason: "forced" });
  });

  it("accepts no new track after the session ended", async () => {
    const host = await session();
    await api(server, "POST", `/api/sessions/${host.sessionId}/end`, { token: host.participantToken, json: {} });
    const late = await api(server, "POST", `/api/sessions/${host.sessionId}/tracks`, { token: host.participantToken, json: declare("cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee") });
    expect(late.status).toBe(409);
  });
});
