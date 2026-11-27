import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioConformFilter, audioEndToleranceSec, durationCheck } from "../../src/server/post/conform.js";
import type { ProjectFile } from "../../src/shared/project.js";
import { issueToken } from "../../src/server/tokens.js";
import { probeDuration } from "../support/measure.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";

const run = promisify(execFile);
const FPS = 30;

describe("duration check of a conformed audio file", () => {
  it("fails the 60 ms surplus of the failed montage preparation and any other real mismatch", () => {
    const tolerance = audioEndToleranceSec(FPS);
    expect(durationCheck("conformed/a.flac", 932.11, 932.17, tolerance).inTolerance).toBe(false);
    expect(durationCheck("conformed/a.flac", 932.11, 932.05, tolerance).inTolerance).toBe(false);
    expect(durationCheck("conformed/a.flac", 932.11, 931.11, tolerance).inTolerance).toBe(false);
    expect(durationCheck("conformed/a.flac", 932.11, 0, tolerance).inTolerance).toBe(false);
    expect(durationCheck("conformed/a.flac", 932.11, Number.NaN, tolerance).inTolerance).toBe(false);
  });

  it("accepts a file that ends within a frame of the project", () => {
    const tolerance = audioEndToleranceSec(FPS);
    expect(durationCheck("conformed/a.flac", 932.11, 932.11, tolerance).inTolerance).toBe(true);
    expect(durationCheck("conformed/a.flac", 932.11, 932.13, tolerance).inTolerance).toBe(true);
    expect(durationCheck("conformed/a.flac", 932.11, 932.09, tolerance).inTolerance).toBe(true);
  });
});

/** Starts of 0.1 s silences in a file (the markers `markedTone` puts every 10 s). */
async function silenceStarts(file: string): Promise<number[]> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=n=-50dB:d=0.05", "-f", "null", "-"]);
  return [...stderr.matchAll(/silence_start: ([0-9.]+)/g)].map((match) => Number(match[1])).filter((start) => start > 1);
}

describe.runIf(hasFfmpeg())("conform of audio whose timestamps do not match its samples", () => {
  const PROJECT_SEC = 39.11;
  let dir: string;
  const out = (name: string): string => path.join(dir, `${name}.flac`);
  const conform = async (input: string, name: string, source: { rate?: number; driftApplied?: boolean; offsetMs?: number } = {}): Promise<number> => {
    const filter = audioConformFilter({ rate: source.rate ?? 1, driftApplied: source.driftApplied ?? false, offsetMs: source.offsetMs ?? 0 }, PROJECT_SEC);
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-map", "0:a:0", "-vn", "-af", filter, "-ac", "1", "-ar", "48000", "-c:a", "flac", out(name)]);
    return probeDuration(out(name));
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "conform-duration-"));
    // 40.5 s of tone with a 0.1 s silence at every full 10 s, as long as a browser recording that runs past the project
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=40.5,volume=enable='lt(mod(t,10),0.1)':volume=0", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", path.join(dir, "whole.webm")]);
    // every packet after 25 s is 60 ms late (a dropped packet) or 60 ms early (an overlapping one)
    for (const [name, shift] of [["late", "0.06"], ["early", "-0.06"]] as const) {
      await run("ffmpeg", ["-v", "error", "-i", path.join(dir, "whole.webm"), "-c", "copy", "-bsf:a", `setts=ts=TS+gte(TS*TB\\,25)*${shift}/TB`, path.join(dir, `${name}.webm`)]);
    }
    // a recording at 44.1 kHz that is shorter than the project
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-ac", "1", "-ar", "44100", path.join(dir, "short-source.flac")]);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ends on the project length when the timestamps are 60 ms behind the samples", async () => {
    const actual = await conform(path.join(dir, "early.webm"), "early");
    expect(actual).toBeCloseTo(PROJECT_SEC, 4);
    expect(durationCheck("early.flac", PROJECT_SEC, actual, audioEndToleranceSec(FPS)).inTolerance).toBe(true);
  });

  it("ends on the project length when the timestamps are 60 ms ahead of the samples", async () => {
    const actual = await conform(path.join(dir, "late.webm"), "late");
    expect(actual).toBeCloseTo(PROJECT_SEC, 4);
  });

  it("ends on the project length with the start offset and the drift correction applied", async () => {
    const actual = await conform(path.join(dir, "early.webm"), "drift", { offsetMs: 2350.7, rate: 1.00006, driftApplied: true });
    expect(actual).toBeCloseTo(PROJECT_SEC, 4);
  });

  it("pads a recording that is shorter than the project, whatever its sample rate", async () => {
    expect(await conform(path.join(dir, "short-source.flac"), "short")).toBeCloseTo(PROJECT_SEC, 4);
  });

  it("puts the audio after a dropped packet back on the clock", async () => {
    await conform(path.join(dir, "late.webm"), "gap");
    const marks = await silenceStarts(out("gap"));
    // the silence at 10 s precedes the gap; the ones at 30 s and beyond follow it and move 60 ms later, the 0.1 s
    // silence at 20 s is part of the same stretch before the gap at 25 s
    expect(marks.some((start) => Math.abs(start - 10) < 0.03)).toBe(true);
    expect(marks.some((start) => Math.abs(start - 30.06) < 0.03)).toBe(true);
    expect(marks.some((start) => Math.abs(start - 30) < 0.03)).toBe(false);
  });
});

describe.runIf(hasFfmpeg())("retrying a conform whose conformed file is out of tolerance", () => {
  const SID = "conform-retry-0001";
  let server: TestServer;
  let token: string;
  let flac: string;

  beforeAll(async () => {
    server = await startServer({ POST_MIN_FREE_GB: "0", POST_NICE: "10" });
    await makeSyntheticSession({ sessionId: SID, storageDir: server.dir, durationSec: 12, participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false }] });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    expect((await api(server, "POST", `/api/sessions/${SID}/project`, { token })).status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  const conformOnce = async (): Promise<ProjectFile> => {
    expect((await api(server, "POST", `/api/sessions/${SID}/project/jobs`, { token, json: { kind: "conform" } })).status).toBe(202);
    await server.app.post.idle();
    return ((await api(server, "GET", `/api/sessions/${SID}/project`, { token })).body as { project: ProjectFile }).project;
  };

  it("replaces the stale file instead of failing with the same message again", async () => {
    const first = await conformOnce();
    expect(first.conform.status).toBe("done");
    flac = path.join(server.app.post.store.dir(SID), "conformed", `${first.sources[0]?.id ?? ""}.flac`);
    const expected = first.durationMs / 1000;
    expect(await probeDuration(flac)).toBeCloseTo(expected, 3);

    // what the failed preparation left behind: a conformed file 60 ms longer than the project
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${(expected + 0.06).toFixed(3)}`, "-ac", "1", "-ar", "48000", "-c:a", "flac", flac]);
    expect(await probeDuration(flac)).toBeGreaterThan(expected + 0.05);

    const retried = await conformOnce();
    expect(retried.conform.error).toBeNull();
    expect(retried.conform.status).toBe("done");
    expect(await probeDuration(flac)).toBeCloseTo(expected, 3);
  }, 120_000);
});
