import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/server/tokens.js";
import { gopFrames, presetById } from "../../src/shared/presets.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { validateSrt, validateVtt } from "../../src/shared/transcript.js";
import { audioOnsets, barcodeFrames, barcodeJumps, inspectMp4, probeJson, videoFlashOnsets } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const SID = "render-fixture-0001";
const SID_FLASH = "render-fixture-0002";
const DURATION = 40;
const CUTS = [{ s: 6000, e: 11_000 }, { s: 18_000, e: 19_500 }, { s: 30_000, e: 33_000 }];

describe.runIf(hasFfmpeg())("export render", () => {
  let server: TestServer;
  let token: string;
  let tokenFlash: string;
  const url = (route: string, sid = SID) => `/api/sessions/${sid}/project${route}`;
  const render = async (preset: string, params: Record<string, unknown> = {}, sid = SID) => {
    const tk = sid === SID ? token : tokenFlash;
    const queued = await api(server, "POST", url("/jobs", sid), { token: tk, json: { kind: "render", params: { preset, ...params } } });
    expect(queued.status).toBe(202);
    await server.app.post.idle();
    const list = ((await api(server, "GET", url("/exports", sid), { token: tk })).body as { exports: { id: string; preset: string; file: string; durationMs: number }[] }).exports;
    const record = list.find((item) => item.preset === preset);
    if (!record) throw new Error(`no export for ${preset}`);
    return { record, file: path.join(server.dir, "post", sid, record.file) };
  };

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_RETENTION: "keep-all" });
    await makeSyntheticSession({ sessionId: SID, storageDir: server.dir, durationSec: DURATION, eventsMs: [3000, 14_000, 25_000, 36_000], participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true }], cameraSize: "1280x720", cameraFps: 30, cameraPicture: "barcode" });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url(""), { token });
    await api(server, "POST", url("/jobs"), { token, json: { kind: "conform" } });
    await server.app.post.idle();
    await api(server, "PUT", url("/edl"), { token, json: { baseRev: 0, removed: CUTS } });
    await makeSyntheticSession({ sessionId: SID_FLASH, storageDir: server.dir, durationSec: DURATION, eventsMs: [3000, 14_000, 25_000, 36_000], participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true }], cameraSize: "1280x720", cameraFps: 30 });
    tokenFlash = issueToken(SECRET, { sid: SID_FLASH, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", url("", SID_FLASH), { token: tokenFlash });
    await api(server, "POST", url("/jobs", SID_FLASH), { token: tokenFlash, json: { kind: "conform" } });
    await server.app.post.idle();
    await api(server, "PUT", url("/edl", SID_FLASH), { token: tokenFlash, json: { baseRev: 0, removed: CUTS } });
  }, 180_000);

  afterAll(async () => {
    await server.close();
  });

  it("refuses an unknown preset", async () => {
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "nope" } } })).status).toBe(400);
  });

  it("writes a YouTube-ready MP4 whose frames are the kept ones", async () => {
    const preset = presetById("youtube-1080p30");
    if (preset?.kind !== "video") throw new Error("preset");
    const { record, file } = await render("youtube-1080p30");
    const layout = await inspectMp4(file);
    expect(layout.moovBeforeMdat).toBe(true);
    expect(layout.hasEditList).toBe(false);
    const probe = (await probeJson(file, ["-show_streams", "-show_format"])) as { streams: Record<string, string | number>[]; format: Record<string, string> };
    const v = probe.streams.find((s) => s.codec_type === "video") as Record<string, string | number>;
    const a = probe.streams.find((s) => s.codec_type === "audio") as Record<string, string | number>;
    expect([v.codec_name, v.profile, v.pix_fmt, v.width, v.height, v.r_frame_rate, v.has_b_frames]).toEqual(["h264", "High", "yuv420p", 1920, 1080, "30/1", 2]);
    expect([a.codec_name, a.sample_rate, a.channels]).toEqual(["aac", "48000", 2]);
    const expectedMs = DURATION * 1000 - CUTS.reduce((sum, cut) => sum + cut.e - cut.s, 0);
    expect(Math.abs(Number(probe.format.duration) * 1000 - expectedMs)).toBeLessThanOrEqual(1000 / 30);
    expect(Math.abs(record.durationMs - expectedMs)).toBeLessThanOrEqual(1000 / 30);
    // keyframes every half second, closed GOP
    const frames = (await probeJson(file, ["-select_streams", "v", "-show_entries", "frame=key_frame,pict_type"])) as { frames: { key_frame: number; pict_type: string }[] };
    const keys = frames.frames.map((f, i) => (f.key_frame ? i : -1)).filter((i) => i >= 0);
    expect(Math.max(...keys.slice(1).map((k, i) => k - (keys[i] as number)))).toBeLessThanOrEqual(gopFrames(preset.fps));
    // the barcode of every output frame is the source frame it came from: consecutive except at the three joins
    const codes = await barcodeFrames(file, 1.5);
    const jumps = barcodeJumps(codes).map((jump) => jump.skipped);
    expect(codes[0]).toBe(0);
    expect(jumps).toEqual(CUTS.map((cut) => Math.round(((cut.e - cut.s) / 1000) * 30)));
    expect(Math.abs(codes.length - (expectedMs / 1000) * 30)).toBeLessThanOrEqual(1);
  }, 180_000);

  it("keeps audio and video together across the cuts", async () => {
    const { file } = await render("youtube-1080p30", {}, SID_FLASH);
    const flashes = await videoFlashOnsets(file, 30);
    const tones = await audioOnsets(file);
    // events at 3 s, 14 s, 25 s, 36 s on the source timeline; each cut shifts the later ones
    const shift = (at: number) => at - CUTS.filter((cut) => cut.e <= at).reduce((sum, cut) => sum + cut.e - cut.s, 0);
    const expected = [3000, 14_000, 25_000, 36_000].filter((at) => !CUTS.some((cut) => at >= cut.s && at < cut.e)).map(shift);
    expect(flashes.length).toBe(expected.length);
    expect(tones.length).toBe(expected.length);
    flashes.forEach((flash, i) => {
      expect(Math.abs(flash - (expected[i] as number))).toBeLessThanOrEqual(1000 / 30 + 1);
      expect(Math.abs(flash - (tones[i] as number))).toBeLessThanOrEqual(1000 / 30 + 1);
    });
  }, 180_000);

  it("burns captions in, with sidecar subtitles on the cut timeline", async () => {
    const words = [["Cześć", 1000, 1400], ["wszystkim", 1500, 2100], ["tutaj", 2200, 2600], ["wycięte", 7000, 7600], ["słowo", 7700, 8100], ["kończymy", 20_000, 20_600], ["nagranie", 20_700, 21_300]].map(([text, s, e]) => ({ t: text as string, s: s as number, e: e as number, src: "p1-anna-audio", pid: "p1-anna" }));
    await writeFile(path.join(server.dir, "post", SID, "transcript.json"), JSON.stringify({ schemaVersion: 1, lang: "pl", engine: "test", model: "test", createdAtMs: 0, speakers: [{ pid: "p1-anna", name: "Anna" }], words, bleedDropped: 0, stats: { engineWallSec: 0, speechSec: 0, audioSec: 0 } }));
    const plain = await render("youtube-1080p30");
    const queued = await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "youtube-1080p30", captions: { style: "bold-box" } } } });
    expect(queued.status).toBe(202);
    await server.app.post.idle();
    const list = ((await api(server, "GET", url("/exports"), { token })).body as { exports: { id: string; file: string }[] }).exports;
    const withCaptions = path.join(server.dir, "post", SID, list[0]?.file ?? "");
    expect(withCaptions).not.toBe(plain.file);
    expect(Math.abs(Number((await probeJson(withCaptions, ["-show_format"]) as { format: Record<string, string> }).format.duration) - Number((await probeJson(plain.file, ["-show_format"]) as { format: Record<string, string> }).format.duration))).toBeLessThan(0.05);
    const srt = await readFile(withCaptions.replace(/\.mp4$/, ".srt"), "utf8");
    expect(validateSrt(srt)).toEqual([]);
    expect(validateVtt(await readFile(withCaptions.replace(/\.mp4$/, ".vtt"), "utf8"))).toEqual([]);
    expect(srt).toContain("Cześć");
    expect(srt).not.toContain("wycięte"); // inside the first cut (6 s to 11 s)
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "youtube-1080p30", captions: { style: "nope" } } } })).status).toBe(400);
  }, 180_000);

  it("renders with the cleanup chain on and keeps the loudness target", async () => {
    const { file } = await render("audio-wav", { clean: { level: true, bleedGate: true } });
    const out = spawnSync("ffmpeg", ["-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const summary = out.slice(out.lastIndexOf("Summary:"));
    expect(Math.abs(Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]) + 16)).toBeLessThan(1);
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "audio-wav", clean: { denoise: true } } } })).status).toBe(409);
    expect((await api(server, "POST", url("/jobs"), { token, json: { kind: "render", params: { preset: "audio-wav", clean: { bleedGateDb: 5 } } } })).status).toBe(400);
  }, 120_000);

  it("writes audio-only presets", async () => {
    const mp3 = await render("audio-mp3");
    const wav = await render("audio-wav");
    const m = (await probeJson(mp3.file, ["-show_streams"])) as { streams: Record<string, string>[] };
    const w = (await probeJson(wav.file, ["-show_streams"])) as { streams: Record<string, string>[] };
    expect([m.streams[0]?.codec_name, m.streams[0]?.sample_rate]).toEqual(["mp3", "48000"]);
    expect([w.streams[0]?.codec_name, w.streams[0]?.sample_rate, w.streams[0]?.channels]).toEqual(["pcm_s16le", "48000", 2]);
  }, 180_000);

  it("removes the cut-time proxies after an export by default", async () => {
    const fresh = await startServer({ POST_MIN_FREE_GB: "0" });
    try {
      await makeSyntheticSession({ sessionId: SID, storageDir: fresh.dir, durationSec: 12, eventsMs: [3000], participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false }] });
      const t = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
      await api(fresh, "POST", url(""), { token: t });
      await api(fresh, "POST", url("/jobs"), { token: t, json: { kind: "conform" } });
      await fresh.app.post.idle();
      await api(fresh, "POST", url("/jobs"), { token: t, json: { kind: "render", params: { preset: "audio-mp3" } } });
      await fresh.app.post.idle();
      const project = ((await api(fresh, "GET", url(""), { token: t })).body as { project: { mixProxy: string | null } }).project;
      expect(project.mixProxy).toBeNull();
      expect(((await api(fresh, "GET", url("/exports"), { token: t })).body as { exports: unknown[] }).exports).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  }, 120_000);
});
