import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CLEAN,
  ENVELOPE_RATE,
  GATE_ATTACK_MS,
  GATE_LOOKAHEAD_MS,
  GATE_RELEASE_MS,
  GATE_TAIL_MS,
  MAX_GAIN_DB,
  cleanInputsGraph,
  ensureRnnoiseModel,
  escapeFilterValue,
  gateEnvelope,
  gateOpenFrames,
  levelGains,
  prepareClean,
  speechLevelDb,
  type CleanTrack,
  type PreparedClean,
} from "../../src/server/post/audio-clean.js";
import { audioProgramGraph, loudnormFilter } from "../../src/server/post/render.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "../../src/shared/project.js";
import { hasFfmpeg } from "./helpers.js";

const run = promisify(execFile);
const FRAME = LEVEL_FRAME_MS;
const FLOOR = -56;

/** A level track: noise floor, with `speech` ranges (ms) at `level` dB. */
function levels(totalMs: number, speech: [number, number][], level = -24, floor = FLOOR): Int8Array {
  const track = new Int8Array(totalMs / FRAME).fill(floor);
  for (const [s, e] of speech) track.fill(level, s / FRAME, e / FRAME);
  return track;
}

/** Two microphones: each hears the other speaker `bleed` dB lower. */
function conversation(totalMs: number, a: [number, number][], b: [number, number][], bleed = -24): [Int8Array, Int8Array] {
  const trackA = levels(totalMs, a);
  const trackB = levels(totalMs, b);
  for (const [s, e] of a) trackB.fill(-24 + bleed, s / FRAME, e / FRAME);
  for (const [s, e] of b) trackA.fill(-24 + bleed, s / FRAME, e / FRAME);
  return [trackA, trackB];
}

const frameOf = (ms: number): number => ms / FRAME;

describe("speech level and static gains", () => {
  it("measures the power mean of the speech frames only", () => {
    const track = levels(20_000, [[1000, 9000]], -30);
    expect(speechLevelDb(track)).toBeCloseTo(-30, 5);
    // louder bursts count by power: half the frames at -30, half at -24
    const mixed = levels(20_000, [[1000, 5000]], -30);
    mixed.fill(-24, frameOf(5000), frameOf(9000));
    expect(speechLevelDb(mixed)).toBeCloseTo(10 * Math.log10((10 ** -3 + 10 ** -2.4) / 2), 5);
  });

  it("ignores frames that are bleed of another microphone and tracks with too little speech", () => {
    const [a, b] = conversation(30_000, [[1000, 9000]], [[12_000, 20_000]]);
    expect(speechLevelDb(b, [a])).toBeCloseTo(-24, 5); // the bleed at -48 is not counted
    expect(speechLevelDb(levels(30_000, [[1000, 1800]]))).toBeNull();
    expect(speechLevelDb(new Int8Array(0))).toBeNull();
  });

  it("moves every track to the mean speech level and clamps the gain", () => {
    // the speakers take turns: a speaker 10 dB under the other one while both talk would be read as bleed
    const loud = levels(40_000, [[1000, 15_000]], -20);
    const quiet = levels(40_000, [[20_000, 34_000]], -26);
    expect(levelGains([{ id: "a", levels: loud }, { id: "b", levels: quiet }])).toEqual({ a: -3, b: 3 });
    const far = levels(40_000, [[20_000, 34_000]], -34); // 14 dB under the loud one
    const gains = levelGains([{ id: "a", levels: loud }, { id: "b", levels: far }]);
    expect(gains.a).toBeCloseTo(-7, 5);
    expect(gains.b).toBeCloseTo(7, 5);
    const wide = levels(40_000, [[20_000, 34_000]], -46, -80); // 26 dB: both clamp
    expect(levelGains([{ id: "a", levels: loud }, { id: "b", levels: wide }])).toEqual({ a: -MAX_GAIN_DB, b: MAX_GAIN_DB });
  });

  it("leaves a track without speech and a lone track alone", () => {
    const talk = levels(40_000, [[1000, 15_000]], -20);
    const gains = levelGains([{ id: "a", levels: talk }, { id: "b", levels: levels(40_000, []) }, { id: "c", levels: levels(40_000, [[20_000, 34_000]], -26) }]);
    expect(gains.b).toBe(0);
    expect(gains.a).toBeCloseTo(-3, 5);
    expect(levelGains([{ id: "a", levels: talk }])).toEqual({ a: 0 });
  });
});

describe("bleed gate decision", () => {
  const total = 20_000;
  const A: [number, number][] = [[1000, 4000], [8000, 10_000]];
  const B: [number, number][] = [[5000, 7000], [14_000, 16_000]];

  it("closes a track while the other one speaks and opens it for its own speech", () => {
    const [a, b] = conversation(total, A, B);
    const openB = gateOpenFrames([a, b], 1);
    const openA = gateOpenFrames([a, b], 0);
    for (const ms of [1500, 3000, 3900, 8500, 9500]) expect(openB[frameOf(ms)], `B at ${ms}`).toBe(0);
    for (const ms of [5200, 6000, 6900, 14_500]) expect(openB[frameOf(ms)], `B own at ${ms}`).toBe(1);
    for (const ms of [5500, 6500, 14_200]) expect(openA[frameOf(ms)], `A at ${ms}`).toBe(0);
    for (const ms of [1500, 3000, 8500]) expect(openA[frameOf(ms)], `A own at ${ms}`).toBe(1);
    // nobody speaks: everything stays open (no gating of the room tone)
    for (const ms of [200, 11_000, 12_000, 18_000]) {
      expect(openA[frameOf(ms)]).toBe(1);
      expect(openB[frameOf(ms)]).toBe(1);
    }
  });

  it("keeps the gate shut across the short pauses of the other speaker and opens a little after it stops", () => {
    const [a, b] = conversation(total, [[1000, 2000], [2200, 4000]], [[10_000, 11_000]]);
    const openB = gateOpenFrames([a, b], 1);
    expect(openB[frameOf(2100)]).toBe(0); // 200 ms pause between words
    expect(openB[frameOf(4100)]).toBe(0); // within the hold after the last speech frame
    expect(openB[frameOf(4500)]).toBe(1);
  });

  it("does not gate speech that overlaps with another speaker at a similar level", () => {
    const a = levels(total, [[1000, 6000]], -24);
    const b = levels(total, [[3000, 8000]], -26);
    const openB = gateOpenFrames([a, b], 1);
    for (let ms = 3000; ms < 8000; ms += FRAME) expect(openB[frameOf(ms)], `B at ${ms}`).toBe(1);
    expect(openB[frameOf(1500)]).toBe(0);
  });

  it("treats a track more than 10 dB under another one as bleed even when it is above its noise floor", () => {
    const a = levels(total, [[1000, 6000]], -20);
    const b = levels(total, [[1000, 6000]], -34); // 14 dB under A on its own microphone
    expect(gateOpenFrames([a, b], 1)[frameOf(3000)]).toBe(0);
  });

  it("opens for a soft onset that stays above the floor but is a single noise frame otherwise", () => {
    // A has just stopped (the gate is still held shut) when B starts softly, below the speech threshold of -44 dB
    const [a, b] = conversation(total, [[1000, 3000]], []);
    b.fill(-46, frameOf(3100), frameOf(3160)); // 3 frames, 10 dB over the floor: soft speech
    expect(gateOpenFrames([a, b], 1)[frameOf(3100)]).toBe(1);
    const [a2, b2] = conversation(total, [[1000, 3000]], []);
    b2.fill(-48, frameOf(3100), frameOf(3100) + 1); // one frame: noise
    expect(gateOpenFrames([a2, b2], 1)[frameOf(3100)]).toBe(0);
  });
});

describe("gate envelope", () => {
  it("opens before the frame that opens it, rises in 10 ms and falls in 80 ms", () => {
    const open = new Uint8Array(100).fill(1);
    open.fill(0, 20, 60); // closed from 400 ms to 1200 ms
    const gateDb = -30;
    const envelope = gateEnvelope(open, gateDb);
    const closed = 10 ** (gateDb / 20);
    expect(envelope.length).toBe(100 * FRAME + GATE_TAIL_MS);
    // closing: starts at 400 ms, full range 80 ms later
    expect(envelope[398]).toBe(1);
    expect(envelope[399]).toBeGreaterThan(0.98);
    expect(envelope[400 + 40]).toBeCloseTo(10 ** (-15 / 20), 1);
    expect(envelope[400 + GATE_RELEASE_MS + 2]).toBeCloseTo(closed, 4);
    expect(envelope[800]).toBeCloseTo(closed, 4);
    // opening: the frame is at 1200 ms; the gate starts rising 40 ms earlier and is fully open 10 ms later
    const start = 1200 - GATE_LOOKAHEAD_MS;
    expect(envelope[start - 2]).toBeCloseTo(closed, 4);
    expect(envelope[start + GATE_ATTACK_MS + 1]).toBe(1);
    expect(envelope[1200]).toBe(1);
    for (const value of envelope) {
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(closed - 1e-6);
    }
  });

  it("starts closed when the first frame is closed, and a short closed stretch only dips", () => {
    const open = new Uint8Array(50).fill(1);
    open.fill(0, 0, 10);
    expect(gateEnvelope(open, -30)[0]).toBeCloseTo(10 ** (-30 / 20), 4);
    const dip = new Uint8Array(50).fill(1);
    dip.fill(0, 10, 13); // 60 ms closed: the release is cut short by the look-ahead of the opening (40 ms before)
    const envelope = gateEnvelope(dip, -30);
    expect(Math.min(...gateEnvelope(new Uint8Array(50).fill(1).fill(0, 10, 11), -30))).toBe(1); // 20 ms closed: shorter than the look-ahead, no dip
    expect(Math.min(...envelope)).toBeGreaterThan(10 ** (-30 / 20));
    expect(Math.min(...envelope)).toBeLessThan(1);
  });
});

describe("preparing the cleanup", () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "syncrecord-clean-"));
  });

  const tracks = (): CleanTrack[] => {
    const [a, b] = conversation(20_000, [[1000, 4000], [8000, 10_000]], [[5000, 7000]]);
    return [
      { id: "anna", file: "/p/a.flac", levels: a },
      { id: "bartek", file: "/p/b.flac", levels: b },
    ];
  };

  it("does nothing by default", async () => {
    const clean = await prepareClean(DEFAULT_CLEAN, tracks(), work);
    expect(clean).toEqual({ gains: { anna: 0, bartek: 0 }, chains: ["", ""], extraInputs: [], inputArgs: [], gateInputs: [null, null] });
    expect(cleanInputsGraph(clean, [0, 1], 2)).toEqual({ lines: [], labels: ["[0:a]", "[1:a]"] });
    expect(DEFAULT_CLEAN).toMatchObject({ level: false, bleedGate: false, denoise: false, bleedGateDb: -30 });
  });

  it("levels with a volume filter and writes one envelope per track", async () => {
    const dir = path.join(work, "a");
    const input = tracks();
    input[1] = { ...(input[1] as CleanTrack), levels: levels(20_000, [[5000, 7000]], -30) };
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, bleedGate: true }, input, dir);
    expect(clean.gains.anna).toBeLessThan(0);
    expect(clean.gains.bartek).toBeGreaterThan(0);
    expect(clean.chains).toEqual([`volume=${clean.gains.anna?.toFixed(2)}dB`, `volume=${clean.gains.bartek?.toFixed(2)}dB`]);
    expect(clean.extraInputs).toHaveLength(2);
    expect(clean.inputArgs).toEqual([["-f", "f32le", "-ar", String(ENVELOPE_RATE), "-ac", "1"], ["-f", "f32le", "-ar", String(ENVELOPE_RATE), "-ac", "1"]]);
    expect(clean.gateInputs).toEqual([0, 1]);
    for (const file of clean.extraInputs) {
      expect(path.dirname(file)).toBe(dir);
      expect((await stat(file)).size).toBe((20_000 + GATE_TAIL_MS) * 4);
    }
    const graph = cleanInputsGraph(clean, [0, 1], 2);
    expect(graph.lines).toEqual([
      `[0:a]volume=${clean.gains.anna?.toFixed(2)}dB[cl0]`,
      "[2:a]aresample=48000[ge0]",
      "[cl0][ge0]amultiply[cg0]",
      `[1:a]volume=${clean.gains.bartek?.toFixed(2)}dB[cl1]`,
      "[3:a]aresample=48000[ge1]",
      "[cl1][ge1]amultiply[cg1]",
    ]);
    expect(graph.labels).toEqual(["[cg0]", "[cg1]"]);
  });

  it("gates only, a lone track is never gated, and the gate depth is validated", async () => {
    const dir = path.join(work, "b");
    const clean = await prepareClean({ ...DEFAULT_CLEAN, bleedGate: true }, tracks(), dir);
    expect(clean.chains).toEqual(["", ""]);
    expect(cleanInputsGraph(clean, [3, 4], 5).lines).toEqual(["[5:a]aresample=48000[ge0]", "[3:a][ge0]amultiply[cg0]", "[6:a]aresample=48000[ge1]", "[4:a][ge1]amultiply[cg1]"]);
    const lone = await prepareClean({ ...DEFAULT_CLEAN, bleedGate: true }, tracks().slice(0, 1), dir);
    expect(lone.extraInputs).toEqual([]);
    for (const bad of [0, 6, Number.NaN, -120]) await expect(prepareClean({ ...DEFAULT_CLEAN, bleedGate: true, bleedGateDb: bad }, tracks(), dir)).rejects.toThrow(/bleedGateDb/);
  });

  it("denoise needs a model that exists and goes after the gain", async () => {
    await expect(prepareClean({ ...DEFAULT_CLEAN, denoise: true }, tracks(), work)).rejects.toThrow(/ensureRnnoiseModel/);
    await expect(prepareClean({ ...DEFAULT_CLEAN, denoise: true, rnnoiseModel: path.join(work, "missing.rnnn") }, tracks(), work)).rejects.toThrow(/not found/);
    const model = path.join(work, "dummy.rnnn");
    await writeFile(model, "not a model, only checked for existence here");
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, denoise: true, rnnoiseModel: model }, tracks(), work);
    for (const chain of clean.chains) expect(chain).toMatch(/^(volume=-?[\d.]+dB,)?arnndn=m=/);
    expect(clean.chains[0]).toContain(model.replaceAll("/", "/"));
  });
});

describe("filter value escaping", () => {
  it.runIf(hasFfmpeg())("survives a path full of special characters", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-esc-"));
    const odd = path.join(dir, "it's [a] b,c;d:e\\f.wav");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", odd]);
    const { stdout } = await run("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `amovie=filename=${escapeFilterValue(odd)}`, "-show_entries", "stream=sample_rate", "-of", "csv=p=0"]);
    expect(Number(stdout.trim())).toBeGreaterThan(0);
  });
});

describe("RNNoise model download", () => {
  const body = Buffer.from("pretend model weights");
  const source = { file: "test.rnnn", url: "https://example.invalid/test.rnnn", sha256: createHash("sha256").update(body).digest("hex") };
  const reply = (calls: string[], status = 200, content: Buffer = body) =>
    (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(status === 200 ? new Uint8Array(content) : null, { status });
    }) as typeof fetch;

  it("downloads once into <models>/rnnoise, verifies the checksum and then reuses the file", async () => {
    const models = await mkdtemp(path.join(tmpdir(), "syncrecord-models-"));
    const calls: string[] = [];
    const file = await ensureRnnoiseModel(models, { source, fetch: reply(calls) });
    expect(file).toBe(path.join(models, "rnnoise", "test.rnnn"));
    expect(await readFile(file)).toEqual(body);
    expect(await ensureRnnoiseModel(models, { source, fetch: reply(calls) })).toBe(file);
    expect(calls).toEqual([source.url]);
    expect((await readdir(path.join(models, "rnnoise"))).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("refuses a download that fails the checksum and leaves nothing behind", async () => {
    const models = await mkdtemp(path.join(tmpdir(), "syncrecord-models-"));
    await expect(ensureRnnoiseModel(models, { source, fetch: reply([], 200, Buffer.from("tampered")) })).rejects.toThrow(/corrupt/);
    expect(existsSync(path.join(models, "rnnoise", "test.rnnn"))).toBe(false);
    expect(await readdir(path.join(models, "rnnoise"))).toEqual([]);
  });

  it("reports a failed download and replaces a damaged file", async () => {
    const models = await mkdtemp(path.join(tmpdir(), "syncrecord-models-"));
    await expect(ensureRnnoiseModel(models, { source, fetch: reply([], 404) })).rejects.toThrow(/HTTP 404/);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(ensureRnnoiseModel(models, { source, fetch: failing })).rejects.toThrow(/offline/);
    await mkdir(path.join(models, "rnnoise"), { recursive: true });
    await writeFile(path.join(models, "rnnoise", "test.rnnn"), "damaged");
    const calls: string[] = [];
    const file = await ensureRnnoiseModel(models, { source, fetch: reply(calls) });
    expect(await readFile(file)).toEqual(body);
    expect(calls).toHaveLength(1);
  });
});

// ---- real ffmpeg graphs ----

const SR = 48_000;

/** 20 ms RMS levels (dBFS, signed byte) of float samples, as the conform job writes them. */
function levelsOf(samples: Float32Array): Int8Array {
  const window = (SR * FRAME) / 1000;
  const out = new Int8Array(Math.ceil(samples.length / window));
  for (let frame = 0; frame < out.length; frame++) {
    let squares = 0;
    const from = frame * window;
    const to = Math.min(samples.length, from + window);
    for (let i = from; i < to; i++) squares += ((samples[i] ?? 0) * 32768) ** 2;
    out[frame] = Math.max(LEVEL_FLOOR_DB, Math.min(0, Math.round(10 * Math.log10(squares / (to - from) / 32768 ** 2 + 1e-12))));
  }
  return out;
}

async function decode(file: string): Promise<Float32Array> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { encoding: "buffer", maxBuffer: 1024 ** 3 });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
}

function rmsDb(samples: Float32Array, fromMs: number, toMs: number): number {
  let sum = 0;
  const from = Math.round((fromMs * SR) / 1000);
  const to = Math.min(samples.length, Math.round((toMs * SR) / 1000));
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return 10 * Math.log10(sum / Math.max(1, to - from) + 1e-14);
}

const readF32 = async (file: string): Promise<Float32Array> => {
  const buffer = await readFile(file);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
};

const inputArgv = (files: string[], clean: PreparedClean): string[] => [...files.flatMap((file) => ["-i", file]), ...clean.extraInputs.flatMap((file, i) => [...(clean.inputArgs[i] ?? []), "-i", file])];

/** Each cleaned track on its own (the cleanup lines of the graph, one output per track). */
async function renderTracks(files: string[], clean: PreparedClean, dir: string, tag: string): Promise<Float32Array[]> {
  const wired = cleanInputsGraph(clean, files.map((_, i) => i), files.length);
  const graph = [...wired.lines, ...wired.labels.map((label, i) => `${label}anull[o${i}]`)].join(";\n");
  const outputs = files.map((_, i) => path.join(dir, `${tag}-${i}.f32`));
  await run("ffmpeg", ["-v", "error", "-nostdin", "-y", ...inputArgv(files, clean), "-filter_complex", graph, ...outputs.flatMap((file, i) => ["-map", `[o${i}]`, "-f", "f32le", "-ar", String(SR), "-ac", "1", file])]);
  return Promise.all(outputs.map(readF32));
}

/** The export's own program graph (amix, limiter, cut, stereo) fed by the cleanup lines: one ffmpeg graph. Returns the left channel. */
async function renderMix(files: string[], clean: PreparedClean, dir: string, totalMs: number, tag: string): Promise<Float32Array> {
  const wired = cleanInputsGraph(clean, files.map((_, i) => i), files.length);
  const program = audioProgramGraph(files.length, [{ s: 0, e: totalMs }], totalMs);
  const mix = program.graph.replace(/\[(\d+):a\]/g, (_, n: string) => wired.labels[Number(n)] ?? `[${n}:a]`);
  const out = path.join(dir, `${tag}-mix.f32`);
  await run("ffmpeg", ["-v", "error", "-nostdin", "-y", ...inputArgv(files, clean), "-filter_complex", [...wired.lines, mix].join(";\n"), "-map", program.label, "-f", "f32le", "-ar", String(SR), "-ac", "2", out]);
  const stereo = await readF32(out);
  const mono = new Float32Array(stereo.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = stereo[i * 2] ?? 0;
  return mono;
}

describe.runIf(hasFfmpeg())("the cleanup inside one ffmpeg graph with the export's mix", () => {
  let dir: string;
  const TOTAL = 14_000;
  // A speaks 1-4 s and 9-12 s, B speaks 5.5-7.5 s; each microphone hears the other speaker 24 dB lower.
  const A: [number, number][] = [[1000, 4000], [9000, 12_000]];
  const B: [number, number][] = [[5500, 7500]];
  const files: string[] = [];

  /** Tone bursts standing in for speech, with a noise floor at -56 dBFS and the other speaker's bleed. */
  const track = async (name: string, own: [number, number][], other: [number, number][], hz: number, otherHz: number, gain = 0.2): Promise<string> => {
    const window = (ranges: [number, number][]): string => ranges.map(([s, e]) => `between(t,${s / 1000},${e / 1000})`).join("+") || "0";
    const expression = `${gain}*sin(2*PI*${hz}*t)*(${window(own)})*(0.6+0.4*sin(2*PI*3*t))+${gain * 0.063}*sin(2*PI*${otherHz}*t)*(${window(other)})*(0.6+0.4*sin(2*PI*2*t))`;
    const file = path.join(dir, `${name}.flac`);
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expression}':s=${SR}:d=${TOTAL / 1000}`, "-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.0035:sample_rate=${SR}:duration=${TOTAL / 1000}:seed=3`, "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0:duration=first,aformat=sample_fmts=s16:channel_layouts=mono", "-c:a", "flac", file]);
    return file;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "syncrecord-clean-graph-"));
    files.push(await track("a", A, B, 440, 660, 0.2));
    files.push(await track("b", B, A, 660, 440, 0.1));
  }, 60_000);

  const cleanTracks = async (): Promise<CleanTrack[]> => Promise.all(files.map(async (file, i) => ({ id: i === 0 ? "a" : "b", file, levels: levelsOf(await decode(file)) })));

  it("passes the audio through untouched when everything is off", async () => {
    const input = await cleanTracks();
    const clean = await prepareClean(DEFAULT_CLEAN, input, path.join(dir, "off"));
    const tracks = await renderTracks(files, clean, dir, "off");
    const original = await decode(files[0] as string);
    expect(tracks[0]?.length).toBe(original.length);
    let max = 0;
    for (let i = 0; i < original.length; i++) max = Math.max(max, Math.abs((tracks[0]?.[i] ?? 0) - (original[i] ?? 0)));
    expect(max).toBeLessThan(1e-6);
    expect((await renderMix(files, clean, dir, TOTAL, "off")).length).toBe(original.length);
  });

  it("brings the bleed down, keeps the onsets and the length, and levels the two tracks", async () => {
    const input = await cleanTracks();
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, bleedGate: true }, input, path.join(dir, "on"));
    expect(clean.gains.a).toBeLessThan(0);
    expect(clean.gains.b).toBeGreaterThan(0);
    const plain = await prepareClean({ ...DEFAULT_CLEAN, level: true }, input, path.join(dir, "plain"));
    const gated = { tracks: await renderTracks(files, clean, dir, "gated"), mix: await renderMix(files, clean, dir, TOTAL, "gated") };
    const ungated = { tracks: await renderTracks(files, plain, dir, "plain"), mix: await renderMix(files, plain, dir, TOTAL, "plain") };
    const original = await decode(files[0] as string);
    expect(gated.tracks[0]?.length).toBe(original.length);
    expect(gated.mix.length).toBe(original.length);
    // the bleed of A in B's microphone, while only A speaks (outside the 100 ms around the edges)
    const bleedBefore = rmsDb(ungated.tracks[1] as Float32Array, 1300, 3800);
    const bleedAfter = rmsDb(gated.tracks[1] as Float32Array, 1300, 3800);
    expect(bleedBefore - bleedAfter).toBeGreaterThan(20);
    // B's own speech: its first 100 ms and its whole span are not touched
    const onset = rmsDb(gated.tracks[1] as Float32Array, 5500, 5600) - rmsDb(ungated.tracks[1] as Float32Array, 5500, 5600);
    expect(Math.abs(onset)).toBeLessThan(0.5);
    expect(Math.abs(rmsDb(gated.tracks[1] as Float32Array, 5500, 7500) - rmsDb(ungated.tracks[1] as Float32Array, 5500, 7500))).toBeLessThan(0.1);
    // A's own onset after B spoke
    expect(Math.abs(rmsDb(gated.tracks[0] as Float32Array, 9000, 9100) - rmsDb(ungated.tracks[0] as Float32Array, 9000, 9100))).toBeLessThan(0.5);
    // the mix carries the speech, and what the gate removed is gone from it
    expect(rmsDb(gated.mix, 1300, 3800)).toBeLessThan(rmsDb(ungated.mix, 1300, 3800) + 0.01);
    // leveling: both speakers' speech sits at the same level (they differed by 6 dB)
    const levelA = rmsDb(gated.tracks[0] as Float32Array, 1300, 3800);
    const levelB = rmsDb(gated.tracks[1] as Float32Array, 5800, 7200);
    const rawA = rmsDb(await decode(files[0] as string), 1300, 3800);
    const rawB = rmsDb(await decode(files[1] as string), 5800, 7200);
    expect(Math.abs(rawA - rawB)).toBeGreaterThan(5);
    expect(Math.abs(levelA - levelB)).toBeLessThan(1.5);
  }, 120_000);

  it("works through the two loudness passes of the export", async () => {
    const input = await cleanTracks();
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, bleedGate: true }, input, path.join(dir, "loud"));
    const wired = cleanInputsGraph(clean, [0, 1], 2);
    const program = audioProgramGraph(2, [{ s: 0, e: 6000 }, { s: 8000, e: TOTAL }], TOTAL);
    const mix = program.graph.replace(/\[(\d+):a\]/g, (_, n: string) => wired.labels[Number(n)] ?? `[${n}:a]`);
    const args = [...files.flatMap((file) => ["-i", file]), ...clean.extraInputs.flatMap((file, i) => [...(clean.inputArgs[i] ?? []), "-i", file])];
    const graph = [...wired.lines, mix].join(";\n");
    const pass1 = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", ...args, "-filter_complex", `${graph};\n${program.label}loudnorm=I=-16:TP=-1:LRA=11:print_format=json[out]`, "-map", "[out]", "-f", "null", "-"]);
    const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(pass1.stderr)?.[0];
    expect(json).toBeDefined();
    const measured = JSON.parse(json as string);
    const out = path.join(dir, "final.wav");
    await run("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args, "-filter_complex", `${graph};\n${program.label}${loudnormFilter({ lufs: -16, truePeakDb: -1 }, measured)}[aout]`, "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", String(SR), out]);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    expect(Number(stdout.trim()) * 1000).toBeCloseTo(6000 + (TOTAL - 8000), -1);
  }, 120_000);

  it.runIf(existsSync(process.env.RNNOISE_MODEL ?? ""))("runs RNNoise in the same graph when a model is given (set RNNOISE_MODEL to a .rnnn file)", async () => {
    const input = await cleanTracks();
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, denoise: true, rnnoiseModel: process.env.RNNOISE_MODEL as string }, input, path.join(dir, "dn"));
    const tracks = await renderTracks(files, clean, dir, "dn");
    expect(tracks[0]?.length).toBeGreaterThan(0);
    expect(rmsDb(tracks[0] as Float32Array, 1300, 3800)).toBeGreaterThan(-40);
  }, 120_000);

});

// The TTS fixtures of the ASR spike (two speakers, exact speech spans, -24 dB bleed). Present on the build machine only.
const FIXTURES = path.join(process.env.ASR_FIXTURES ?? path.join(process.env.TMPDIR ?? tmpdir(), "asr"), "fix-silence-en");
describe.runIf(hasFfmpeg() && existsSync(path.join(FIXTURES, "truth.json")))("the cleanup on the TTS fixtures", () => {
  it("lowers the bleed by more than 6 dB without touching the first 100 ms of any onset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-clean-tts-"));
    const SECONDS = 100;
    const files: string[] = [];
    for (const id of ["A", "B"]) {
      const file = path.join(dir, `${id}.flac`);
      await run("ffmpeg", ["-v", "error", "-y", "-i", path.join(FIXTURES, `track_${id}.wav`), "-t", String(SECONDS), "-ar", String(SR), "-ac", "1", "-c:a", "flac", file]);
      files.push(file);
    }
    const truth = JSON.parse(await readFile(path.join(FIXTURES, "truth.json"), "utf8")) as { speech: Record<string, { s: number; e: number }[]> };
    const spans = (id: string): { s: number; e: number }[] => (truth.speech[id] ?? []).map((span) => ({ s: span.s * 1000, e: span.e * 1000 })).filter((span) => span.e < SECONDS * 1000 - 500);
    const input: CleanTrack[] = await Promise.all(files.map(async (file, i) => ({ id: i === 0 ? "A" : "B", file, levels: levelsOf(await decode(file)) })));
    const clean = await prepareClean({ ...DEFAULT_CLEAN, level: true, bleedGate: true }, input, path.join(dir, "work"));
    const plain = await prepareClean({ ...DEFAULT_CLEAN, level: true }, input, path.join(dir, "plain"));
    const gated = { tracks: await renderTracks(files, clean, dir, "gated"), mix: await renderMix(files, clean, dir, SECONDS * 1000, "gated") };
    const ungated = { tracks: await renderTracks(files, plain, dir, "plain") };
    const speakers = [{ i: 0, own: spans("A"), other: spans("B") }, { i: 1, own: spans("B"), other: spans("A") }];
    for (const speaker of speakers) {
      let before = 0;
      let after = 0;
      let count = 0;
      for (const span of speaker.other) {
        const from = Math.round(((span.s + 150) * SR) / 1000);
        const to = Math.round(((span.e - 150) * SR) / 1000);
        for (let k = from; k < to; k++) {
          before += ((ungated.tracks[speaker.i] as Float32Array)[k] ?? 0) ** 2;
          after += ((gated.tracks[speaker.i] as Float32Array)[k] ?? 0) ** 2;
        }
        count += to - from;
      }
      expect(count).toBeGreaterThan(SR * 5);
      expect(10 * Math.log10(before / after)).toBeGreaterThan(6);
      for (const span of speaker.own) {
        const diff = rmsDb(gated.tracks[speaker.i] as Float32Array, span.s, span.s + 100) - rmsDb(ungated.tracks[speaker.i] as Float32Array, span.s, span.s + 100);
        expect(Math.abs(diff), `onset at ${span.s}`).toBeLessThan(1);
      }
    }
    expect((gated.mix.length / SR) * 1000).toBeCloseTo(SECONDS * 1000, -1);
  }, 180_000);

  it.runIf(existsSync(process.env.RNNOISE_MODEL ?? ""))("keeps the denoised track in time with the original and as long (set RNNOISE_MODEL to a .rnnn file)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-clean-dn-"));
    const file = path.join(dir, "A.flac");
    await run("ffmpeg", ["-v", "error", "-y", "-i", path.join(FIXTURES, "track_A.wav"), "-t", "30", "-ar", String(SR), "-ac", "1", "-c:a", "flac", file]);
    const input: CleanTrack[] = [{ id: "A", file, levels: levelsOf(await decode(file)) }];
    const clean = await prepareClean({ ...DEFAULT_CLEAN, denoise: true, rnnoiseModel: process.env.RNNOISE_MODEL as string }, input, dir);
    const [out] = await renderTracks([file], clean, dir, "dn");
    const original = await decode(file);
    expect(out?.length).toBe(original.length);
    // best lag of the output against the input over speech (A speaks 16.4-23.8 s)
    const from = 17 * SR;
    const length = 5 * SR;
    let best = Number.NEGATIVE_INFINITY;
    let bestLag = 0;
    for (let lag = -1000; lag <= 1000; lag++) {
      let sum = 0;
      for (let i = from; i < from + length; i += 2) sum += ((out as Float32Array)[i + lag] ?? 0) * (original[i] ?? 0);
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    expect(bestLag).toBe(0);
  }, 120_000);
});
