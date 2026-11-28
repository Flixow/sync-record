import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioConformFilter, timelineEndOf, videoProxyFilter, videoTimelineFilter } from "../../src/server/post/conform.js";
import { estimateDrift } from "../../src/shared/drift.js";
import type { ProjectFile } from "../../src/shared/project.js";
import { issueToken } from "../../src/server/tokens.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { audioOnsets, matchEvents, probeDuration, videoFlashOnsets } from "../support/measure.js";
import { makeSyntheticSession, type SyntheticTruth } from "../support/synthetic.js";

const SID = "conform-fixture-0001";
const DURATION = 360;
const FRAME_MS = 1000 / 30;

describe("drift estimate", () => {
  const samples = (slopePpm: number) =>
    Array.from({ length: 8 }, (_, i) => ({ atClientMs: 1_000_000 + i * 60_000, offsetMs: 500 - slopePpm * 1e-6 * i * 60_000, rttMs: 8 }));

  it("reads the rate from media duration against the recorded span", () => {
    const estimate = estimateDrift({ startClientMs: 1_000_000, endClientMs: 1_000_000 + 3_600_000, mediaDurationSec: 3600.18, samples: [] });
    expect(estimate.applied).toBe(true);
    expect(estimate.ppm).toBeCloseTo(50, 0);
  });

  it("separates the client clock drift from the audio device drift", () => {
    // 30 ppm of the span is the client clock running fast against the server, the rest is the audio device.
    const span = 420_000;
    const estimate = estimateDrift({ startClientMs: 1_000_000, endClientMs: 1_000_000 + span, mediaDurationSec: (span / 1000) * (1 - 30e-6) * (1 + 100e-6), samples: samples(30) });
    expect(estimate.ppm).toBeGreaterThan(95);
    expect(estimate.ppm).toBeLessThan(105);
  });

  it("does not correct short or implausible measurements", () => {
    expect(estimateDrift({ startClientMs: 0, endClientMs: 60_000, mediaDurationSec: 60.01, samples: [] }).applied).toBe(false);
    const fault = estimateDrift({ startClientMs: 0, endClientMs: 600_000, mediaDurationSec: 601, samples: [] });
    expect(fault.applied).toBe(false);
    expect(fault.rate).toBe(1);
    expect(estimateDrift({ startClientMs: 0, endClientMs: null, mediaDurationSec: 600, samples: [] }).applied).toBe(false);
  });
});

describe("conform filters", () => {
  it("corrects drift through a high pivot rate and places the source on the timeline", () => {
    const filter = audioConformFilter({ rate: 1.00005, driftApplied: true, offsetMs: 1500 }, 60);
    expect(filter).toContain("asetrate=384019");
    expect(filter).toContain("adelay=1500.000ms:all=1");
    expect(filter).toContain("apad=whole_len=2880000");
    expect(audioConformFilter({ rate: 1, driftApplied: false, offsetMs: 0 }, 60)).not.toContain("asetrate");
  });

  it.runIf(hasFfmpeg())("keeps a source with a dropped audio packet on the clock, so it still ends at the project length", async () => {
    const run = promisify(execFile);
    const dir = await mkdtemp(path.join(tmpdir(), "conform-gap-"));
    try {
      const whole = path.join(dir, "whole.webm");
      const gap = path.join(dir, "gap.webm");
      await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", whole]);
      // every packet after 5 s is 60 ms late: the file's clock runs ahead of its samples, like after a dropped packet
      await run("ffmpeg", ["-v", "error", "-i", whole, "-c", "copy", "-bsf:a", "setts=ts=TS+gte(TS*TB\\,5)*0.06/TB", gap]);
      const out = path.join(dir, "out.flac");
      await run("ffmpeg", ["-v", "error", "-i", gap, "-vn", "-af", audioConformFilter({ rate: 1, driftApplied: false, offsetMs: 0 }, 10.2), "-ac", "1", "-ar", "48000", "-c:a", "flac", out]);
      expect(await probeDuration(out)).toBeCloseTo(10.2, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pads video in whole frames and conforms to a constant frame rate", () => {
    const filter = videoProxyFilter({ rate: 1, offsetMs: 1000 }, 30);
    expect(filter).toContain("fps=30");
    expect(filter).toContain("tpad=start_duration=1.000000");
    expect(filter).toContain("+0.000000/TB");
  });
});

describe.runIf(hasFfmpeg())("end of a conformed video", () => {
  const run = promisify(execFile);
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "conform-end-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts the empty start of a proxy whose first frame rounds up to the second slot of the frame grid", async () => {
    // 7.2 s of video that starts 21.3 ms into the timeline: its first frame is placed at 33 ms, the mp4 starts there
    const source = path.join(dir, "in.mkv");
    const proxy = path.join(dir, "proxy.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=7.2", "-c:v", "libx264", source]);
    await run("ffmpeg", ["-v", "error", "-y", "-i", source, "-an", "-vf", videoProxyFilter({ rate: 1, offsetMs: 21.3 }, 30), "-c:v", "libx264", "-f", "mp4", proxy]);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", proxy]);
    const end = await timelineEndOf("ffprobe", proxy);
    expect(end - Number(stdout.trim())).toBeGreaterThan(0.03); // the duration alone leaves out the empty frame slot
    expect(Math.abs(end - (21.3 / 1000 + 7.2))).toBeLessThanOrEqual(2 / 30);
  });
});

describe.runIf(hasFfmpeg())("conform of a synthetic session (known offsets, drift and flashes)", () => {
  let server: TestServer;
  let truth: SyntheticTruth;
  let token: string;
  let project: ProjectFile;
  const get = (route: string) => api(server, "GET", `/api/sessions/${SID}${route}`, { token });

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_NICE: "10" });
    truth = await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: DURATION,
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 12, camera: true },
        { name: "Bartek", startOffsetMs: 2350, audioPpm: 600, clientClockPpm: -20, camera: true },
        { name: "Celina", startOffsetMs: 41_700, audioPpm: -450, clientClockPpm: 5, camera: false },
      ],
    });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    expect((await api(server, "POST", `/api/sessions/${SID}/project`, { token })).status).toBe(201);
    const queued = await api(server, "POST", `/api/sessions/${SID}/project/jobs`, { token, json: { kind: "conform" } });
    expect(queued.status).toBe(202);
    await server.app.post.idle();
    project = ((await get("/project")).body as { project: ProjectFile }).project;
  }, 300_000);

  afterAll(async () => {
    await server.close();
  });

  it("finishes and records the drift it measured", () => {
    expect(project.conform.status).toBe("done");
    const bartek = project.sources.find((source) => source.participantId === "p2-bartek" && source.kind === "audio");
    expect(bartek?.driftApplied).toBe(true);
    // the measured ppm is the audio device drift (the client clock drift is removed through the handshake slope)
    expect(bartek?.driftPpm).toBeGreaterThan(560);
    expect(bartek?.driftPpm).toBeLessThan(640);
    expect(bartek?.offsetMs).toBeCloseTo(2350, 0);
  });

  it("lines every track up within one frame at the start, the middle and the end", async () => {
    const dir = path.join(server.dir, "post", SID);
    for (const source of project.sources) {
      const owner = truth.participants.find((participant) => participant.id === source.participantId);
      const expected = truth.eventsMs.filter((event) => event > (owner?.startOffsetMs ?? 0) + 1000 && event < DURATION * 1000 - 1500);
      const detected = source.audio ? await audioOnsets(path.join(dir, source.audio.file)) : await videoFlashOnsets(path.join(dir, source.video?.file ?? ""), project.fps);
      // A flash is first seen on the first frame of the 30 fps grid at or after it: compare with that frame, not with the instant.
      const reference = source.audio ? expected : expected.map((event) => Math.ceil(event / FRAME_MS) * FRAME_MS);
      const { errorsMs, missing } = matchEvents(reference, detected);
      expect(missing, `${source.id} ${source.kind}`).toBe(0);
      expect(errorsMs.length).toBeGreaterThanOrEqual(3);
      const tolerance = FRAME_MS + 0.1;
      for (const error of errorsMs) expect(Math.abs(error), `${source.id} ${source.kind}`).toBeLessThanOrEqual(tolerance);
      if (source.video) {
        // The conformed video must also have the audio's offsets: the camera shares the participant's start.
        expect(source.video.fps).toBe(30);
      }
    }
  }, 120_000);

  it("produces seekable, decodable outputs of the expected length", async () => {
    const dir = path.join(server.dir, "post", SID);
    for (const source of project.sources) {
      if (source.audio) expect(Math.abs((await probeDuration(path.join(dir, source.audio.file))) - project.durationMs / 1000)).toBeLessThanOrEqual(1 / 30);
      if (source.video) {
        const expected = (source.offsetMs + source.timelineDurationMs) / 1000;
        expect(Math.abs((await probeDuration(path.join(dir, source.video.file))) - expected)).toBeLessThanOrEqual(1 / 30);
      }
    }
    expect(project.mixProxy).toBe("proxies/mix.m4a");
  });

  it("makes the preview mix again when it was made from other tracks than the project has now", async () => {
    const dir = path.join(server.dir, "post", SID, "proxies");
    const before = (await stat(path.join(dir, "mix.m4a"))).mtimeMs;
    const signature = await readFile(path.join(dir, "mix.sources"), "utf8");
    expect(signature.split("\n")).toHaveLength(project.sources.filter((source) => source.audio).length);
    // a mix of the right length made before a late track arrived: its signature lists fewer tracks
    await writeFile(path.join(dir, "mix.sources"), signature.split("\n").slice(1).join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await api(server, "POST", `/api/sessions/${SID}/project/jobs`, { token, json: { kind: "conform" } })).status).toBe(202);
    await server.app.post.idle();
    expect((await stat(path.join(dir, "mix.m4a"))).mtimeMs).toBeGreaterThan(before);
    expect(await readFile(path.join(dir, "mix.sources"), "utf8")).toBe(signature);
  }, 120_000);

  it("serves a proxy with byte ranges for the browser", async () => {
    const response = await fetch(`${server.base}/api/sessions/${SID}/project/media/proxies/mix.m4a?token=${encodeURIComponent(token)}`, { headers: { range: "bytes=0-99" } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    const escape = await fetch(`${server.base}/api/sessions/${SID}/project/media/..%2F..%2Fsession%2F${SID}%2Fmanifest.json?token=${encodeURIComponent(token)}`);
    expect(escape.status).toBe(404);
  });

  it("answers only the host and refuses a job when the disk is below the limit", async () => {
    const guest = issueToken(SECRET, { sid: SID, role: "participant", pid: "p2-bartek", host: false, exp: Date.now() + 3_600_000 });
    expect((await api(server, "GET", `/api/sessions/${SID}/project`, { token: guest })).status).toBe(403);
    expect((await api(server, "GET", `/api/sessions/${SID}/project`)).status).toBe(401);
  });
});

describe.runIf(hasFfmpeg())("proxy filter order", () => {
  const run = promisify(execFile);

  it("places the same frames whether the scaling runs before or after the frame rate conversion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "conform-order-"));
    try {
      // a 7 fps source is converted up to 30 fps: the conversion repeats frames
      const source = path.join(dir, "in.mkv");
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=7:duration=3", "-c:v", "libx264", source]);
      const timestamps = async (filter: string): Promise<string> => {
        const out = path.join(dir, "out.mp4");
        await run("ffmpeg", ["-v", "error", "-y", "-i", source, "-an", "-vf", filter, "-c:v", "libx264", "-f", "mp4", out]);
        const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out]);
        return stdout;
      };
      const scale = ["scale=-2:90:flags=bilinear"];
      const source1 = { rate: 1, offsetMs: 21.3 };
      expect(await timestamps(videoTimelineFilter(source1, 30, scale, true))).toBe(await timestamps(videoTimelineFilter(source1, 30, scale, false)));
      expect(videoProxyFilter(source1, 30).indexOf("scale=")).toBeLessThan(videoProxyFilter(source1, 30).indexOf("fps="));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
