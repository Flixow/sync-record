import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import type { Scene } from "../../src/shared/scenes.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const run = promisify(execFile);
const SID = "mic-only-fixture-0001";
/** Bartek's microphone is a 1050 Hz tone (the synthetic session gives each participant 900 Hz + 150 Hz per index); Anna's is 900 Hz. */
const BARTEK_HZ = 1050;
/** The name card's panel colour, #1c2433. */
const CARD_RGB = [0x1c, 0x24, 0x33];

/** Mean colour of a region of the frame at `second` of a video. */
async function regionColor(file: string, second: number, region: { x: number; y: number; w: number; h: number }): Promise<number[]> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(second), "-i", file, "-frames:v", "1", "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=1:1:flags=area`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1024 });
  return [...stdout.subarray(0, 3)];
}

/** Peak level in dB of the part of an audio file around `hz` (a narrow band-pass, then volumedetect). */
async function peakNear(file: string, hz: number): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-af", `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, "-f", "null", "-"]);
  const max = /max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1];
  return max === undefined ? -Infinity : Number(max);
}

describe.runIf(hasFfmpeg())("a participant who recorded only a microphone", () => {
  let server: TestServer;
  let token: string;
  const url = (route: string) => `/api/sessions/${SID}/project${route}`;
  const plan = (layout: string, overrides: unknown[] = []) => ({ params: { minDwellMs: 2500, hysteresisDb: 4, hangoverMs: 600, rhythm: "balanced", layout, fallback: "keep" }, overrides });
  let cardId = "";

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: 12,
      eventsMs: [2000, 5000, 8000],
      cameraSize: "640x360",
      cameraFps: 30,
      cameraPicture: "barcode",
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false },
      ],
    });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
  }, 180_000);

  afterAll(async () => {
    await server.close();
  });

  const exportOf = async (params: Record<string, unknown>): Promise<string> => {
    await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params } });
    await server.app.post.idle();
    const list = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string }[] }).exports;
    const record = list.find((item) => item.preset === params.preset);
    if (!record) throw new Error(`no export for ${String(params.preset)}`);
    return path.join(server.dir, "post", SID, record.file);
  };

  it("offers the participant as a name card source next to the pictures, and the scenes feature it", async () => {
    const body = (await api(server, "GET", url("/scenes"), { token })).body as { scenes: Scene[]; sources: { id: string; kind: string }[] };
    expect(body.sources.map((source) => source.kind)).toEqual(["camera", "card"]);
    cardId = body.sources[1]?.id ?? "";
    expect(cardId).toMatch(/^card-/);
    // both speak in the same bursts, so the plan keeps both pictures available in every scene
    expect(body.scenes.every((scene) => scene.sources.includes(cardId))).toBe(true);
    // the card can be picked by hand: the override is saved
    const saved = await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 0, plan: plan("solo", [{ s: 0, e: 12_000, sources: [cardId] }]), aspect: "16:9" } });
    expect(saved.status).toBe(200);
    expect((saved.body as { scenes: Scene[] }).scenes[0]?.sources[0]).toBe(cardId);
  });

  it("renders the card in the export, thumbnails it, and keeps the participant's voice in the mix", async () => {
    // the whole program is the card
    const solo = await exportOf({ preset: "youtube-1080p30" });
    const full = await regionColor(solo, 6, { x: 100, y: 100, w: 200, h: 200 });
    full.forEach((value, index) => expect(Math.abs(value - (CARD_RGB[index] as number))).toBeLessThan(14));

    // both side by side: the card on the right, Anna's picture on the left
    await api(server, "PUT", url("/scenes"), { token, json: { baseRev: 1, plan: plan("side-by-side"), aspect: "16:9" } });
    const pair = await exportOf({ preset: "youtube-1080p30" });
    const card = await regionColor(pair, 6, { x: 1500, y: 900, w: 100, h: 100 });
    card.forEach((value, index) => expect(Math.abs(value - (CARD_RGB[index] as number))).toBeLessThan(14));
    const camera = await regionColor(pair, 6, { x: 100, y: 100, w: 100, h: 100 });
    expect(camera.some((value, index) => Math.abs(value - (CARD_RGB[index] as number)) > 25)).toBe(true);

    await api(server, "POST", url("/jobs"), { token, json: { kind: "thumbnail", params: { atMs: 6000 } } });
    await server.app.post.idle();
    const thumbs = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { preset: string; file: string }[] }).exports;
    expect(thumbs.some((item) => item.preset === "thumbnail-video")).toBe(true);

    // the audio of the export is the mix of both microphones: Bartek's tone stands well above the band next to it
    // (the tone bursts have clicking edges, so the control band is not silent)
    const control = await peakNear(pair, 1500);
    expect(await peakNear(pair, BARTEK_HZ)).toBeGreaterThan(control + 10);
    expect(await peakNear(pair, 900)).toBeGreaterThan(control + 10);
    const mp3 = await exportOf({ preset: "audio-mp3" });
    expect(await peakNear(mp3, BARTEK_HZ)).toBeGreaterThan(await peakNear(mp3, 1500) + 10);
  }, 240_000);
});
