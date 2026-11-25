// Gate measurements of the audio cleanup (S8): bleed gate, leveling, export loudness with the cleanup in the chain,
// artefact indicators and the denoiser. Prints JSON. Usage:
//   tsx scripts/bench-audio-clean.ts --asr <spike work dir> --dir <work dir> [--only gate,loudness,level,dynamics,denoise] [--rnnoise-alt <model>]
// Fixtures (16 kHz mono WAV): fix-silence-en|pl (TTS, tracks with -24 dB bleed, truth.json), fix-en|pl (track_A/B clean,
// bleed_A/B with -22 dB bleed). Tracks are conformed to 48 kHz mono FLAC like the project conform does, and the level
// frames are computed by the same formula as the conform job (20 ms RMS, dBFS, signed byte).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CLEAN, ENVELOPE_RATE, GATE_TAIL_MS, cleanInputsGraph, ensureRnnoiseModel, gateEnvelope, gateOpenFrames, levelGains, prepareClean, speechLevelDb, type CleanOptions, type CleanTrack, type PreparedClean } from "../src/server/post/audio-clean.js";
import { audioProgramGraph, loudnormFilter } from "../src/server/post/render.js";
import { DEFAULT_VAD, detectSpeech, speechFrames } from "../src/shared/vad.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "../src/shared/project.js";

const run = promisify(execFile);
const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const asrDir = path.resolve(arg("asr", path.join(process.env.TMPDIR ?? ".", "asr")));
const dir = path.resolve(arg("dir", "./bench-audio-clean"));
const only = new Set(arg("only", "gate,loudness,level,dynamics,denoise").split(","));
const altModel = arg("rnnoise-alt", "");
await mkdir(dir, { recursive: true });

const SR = 48_000;
const round = (value: number, digits = 2): number => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);
const db = (power: number): number => 10 * Math.log10(power + 1e-14);

// ---------- ffmpeg helpers ----------
async function ffmpeg(args: string[]): Promise<string> {
  const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", "-threads", "4", ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stderr;
}

async function readF32(file: string): Promise<Float32Array> {
  const buffer = await readFile(file);
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy);
}

/** Conforms a 16 kHz fixture to the project's 48 kHz mono FLAC. `filter` is an optional audio filter. */
async function conform(wav: string, name: string, filter = ""): Promise<string> {
  const out = path.join(dir, `${name}.flac`);
  if (!existsSync(out)) await ffmpeg(["-i", wav, ...(filter ? ["-af", filter] : []), "-ar", String(SR), "-ac", "1", "-c:a", "flac", out]);
  return out;
}

async function decode(file: string): Promise<Float32Array> {
  const raw = `${file}.f32`;
  await ffmpeg(["-i", file, "-f", "f32le", "-ar", String(SR), "-ac", "1", raw]);
  return readF32(raw);
}

/** The level frames exactly as the conform job writes them (s16 samples, 20 ms RMS, dBFS). */
function levelsOf(samples: Float32Array): Int8Array {
  const window = (SR * LEVEL_FRAME_MS) / 1000;
  const frames = Math.ceil(samples.length / window);
  const levels = new Int8Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let squares = 0;
    const from = frame * window;
    const to = Math.min(samples.length, from + window);
    for (let i = from; i < to; i++) {
      const value = Math.round((samples[i] ?? 0) * 32768);
      squares += value * value;
    }
    levels[frame] = Math.max(LEVEL_FLOOR_DB, Math.min(0, Math.round(10 * Math.log10(squares / (to - from) / 32768 ** 2 + 1e-12))));
  }
  return levels;
}

type LoadedTrack = CleanTrack & { samples: Float32Array };

async function trackOf(id: string, file: string): Promise<LoadedTrack> {
  const samples = await decode(file);
  return { id, file, levels: levelsOf(samples), samples };
}

async function pairOf(a: string, b: string): Promise<[LoadedTrack, LoadedTrack]> {
  return Promise.all([trackOf("A", a), trackOf("B", b)]);
}

/** Renders every track through the cleanup graph (one ffmpeg run) and returns the cleaned samples. */
async function renderTracks(clean: PreparedClean, tracks: CleanTrack[], tag: string): Promise<Float32Array[]> {
  const wired = cleanInputsGraph(clean, tracks.map((_, i) => i), tracks.length);
  const lines = [...wired.lines, ...wired.labels.map((label, i) => `${label}anull[o${i}]`)];
  const outputs = tracks.map((_, i) => path.join(dir, `render-${tag}-${i}.f32`));
  await ffmpeg([
    ...tracks.flatMap((track) => ["-i", track.file]),
    ...clean.extraInputs.flatMap((file, i) => [...(clean.inputArgs[i] ?? []), "-i", file]),
    "-filter_complex", lines.join(";\n"),
    ...outputs.flatMap((file, i) => ["-map", `[o${i}]`, "-f", "f32le", "-ar", String(SR), "-ac", "1", file]),
  ]);
  return Promise.all(outputs.map(readF32));
}

interface Span {
  s: number;
  e: number;
}

const index = (ms: number): number => Math.round((ms * SR) / 1000);

function rmsDb(samples: Float32Array, spans: Span[], skipMs = 0): number {
  let sum = 0;
  let count = 0;
  for (const span of spans) {
    const from = index(span.s + skipMs);
    const to = Math.min(samples.length, index(span.e));
    for (let i = from; i < to; i++) {
      const value = samples[i] ?? 0;
      sum += value * value;
    }
    count += Math.max(0, to - from);
  }
  return count === 0 ? Number.NaN : db(sum / count);
}

function maxStep(samples: Float32Array, fromMs: number, toMs: number): number {
  let max = 0;
  for (let i = Math.max(1, index(fromMs)); i < Math.min(samples.length, index(toMs)); i++) max = Math.max(max, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  return max;
}

/** Spans of `from` that no span of `other` (widened by `padMs`) touches, at least `minMs` long. */
function exclusive(from: Span[], other: Span[], padMs: number, minMs = 400): Span[] {
  const out: Span[] = [];
  for (const span of from) {
    let pieces: Span[] = [span];
    for (const blocker of other) {
      const next: Span[] = [];
      for (const piece of pieces) {
        const s = blocker.s - padMs;
        const e = blocker.e + padMs;
        if (e <= piece.s || s >= piece.e) next.push(piece);
        else {
          if (s > piece.s) next.push({ s: piece.s, e: s });
          if (e < piece.e) next.push({ s: e, e: piece.e });
        }
      }
      pieces = next;
    }
    out.push(...pieces.filter((piece) => piece.e - piece.s >= minMs));
  }
  return out;
}

// ---------- fixtures ----------
interface Pair {
  name: string;
  a: LoadedTrack;
  b: LoadedTrack;
  speech: { A: Span[]; B: Span[] };
  bleedDb: number;
}

/** Speech spans of a clean track from its level frames, onsets refined with 2 ms RMS windows. */
function cleanSpans(samples: Float32Array, levels: Int8Array): Span[] {
  const segments = detectSpeech(levels, { ...DEFAULT_VAD, dominanceDb: null, bridgeMs: 300, minMs: 250, padMs: 0 });
  const window = index(2);
  const floor = [...levels].sort((x, y) => x - y)[Math.floor(levels.length * 0.1)] ?? -60;
  return segments.map((segment) => {
    let onset = segment.startMs;
    for (let ms = segment.startMs - 100; ms < segment.startMs + 60; ms += 2) {
      let sum = 0;
      for (let i = index(ms); i < index(ms) + window && i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
      if (db(sum / window) > floor + 9) {
        onset = ms;
        break;
      }
    }
    return { s: Math.max(0, onset), e: segment.endMs };
  });
}

async function loadSilenceFixture(lang: string): Promise<Pair> {
  const base = path.join(asrDir, `fix-silence-${lang}`);
  const truth = JSON.parse(await readFile(path.join(base, "truth.json"), "utf8")) as { speech: Record<string, { s: number; e: number }[]> };
  const [a, b] = await pairOf(await conform(path.join(base, "track_A.wav"), `silence-${lang}-A`), await conform(path.join(base, "track_B.wav"), `silence-${lang}-B`));
  const toMs = (spans: { s: number; e: number }[] | undefined): Span[] => (spans ?? []).map((span) => ({ s: span.s * 1000, e: span.e * 1000 }));
  return { name: `fix-silence-${lang} (-24 dB bleed)`, a, b, speech: { A: toMs(truth.speech.A), B: toMs(truth.speech.B) }, bleedDb: -24 };
}

async function loadConversationFixture(lang: string, kind: "track" | "bleed"): Promise<Pair> {
  const base = path.join(asrDir, `fix-${lang}`);
  const [a, b] = await pairOf(await conform(path.join(base, `${kind}_A.wav`), `${kind}-${lang}-A`), await conform(path.join(base, `${kind}_B.wav`), `${kind}-${lang}-B`));
  // speech truth from the clean tracks of the same conversation
  const [cleanA, cleanB] = await pairOf(await conform(path.join(base, "track_A.wav"), `track-${lang}-A`), await conform(path.join(base, "track_B.wav"), `track-${lang}-B`));
  return {
    name: `fix-${lang} ${kind === "bleed" ? "(-22 dB bleed)" : "(clean tracks)"}`,
    a,
    b,
    speech: { A: cleanSpans(cleanA.samples, cleanA.levels), B: cleanSpans(cleanB.samples, cleanB.levels) },
    bleedDb: kind === "bleed" ? -22 : Number.NEGATIVE_INFINITY,
  };
}

/** The gate as an instant switch with no look-ahead, at the full 48 kHz (so nothing smooths the edge): the baseline for the click indicators. */
function instantSwitch48k(open: Uint8Array, gateDb: number): Float32Array {
  const closed = 10 ** (gateDb / 20);
  const out = new Float32Array((open.length * LEVEL_FRAME_MS + GATE_TAIL_MS) * 48);
  for (let k = 0; k < out.length; k++) out[k] = (open[Math.floor(k / 48 / LEVEL_FRAME_MS)] ?? 1) === 1 ? 1 : closed;
  return out;
}

const RAW48K = ["-f", "f32le", "-ar", String(SR), "-ac", "1"];

// ---------- (a) gate: bleed reduction, onsets, artefacts ----------
function transitions(open: Uint8Array): { closing: number[]; opening: number[] } {
  const closing: number[] = [];
  const opening: number[] = [];
  for (let frame = 1; frame < open.length; frame++) {
    if (open[frame - 1] === 1 && open[frame] === 0) closing.push(frame * LEVEL_FRAME_MS);
    if (open[frame - 1] === 0 && open[frame] === 1) opening.push(frame * LEVEL_FRAME_MS);
  }
  return { closing, opening };
}

async function evaluateGate(pair: Pair, withLevel: boolean): Promise<Record<string, unknown>> {
  const tracks = [pair.a, pair.b];
  const work = path.join(dir, "work");
  const base: CleanOptions = { ...DEFAULT_CLEAN, level: withLevel };
  const plain = await prepareClean(base, tracks, work);
  const gated = await prepareClean({ ...base, bleedGate: true }, tracks, work);
  // the same open/closed decisions as an instant switch, for the click comparison
  const hardFiles: string[] = [];
  for (const [i] of tracks.entries()) {
    const file = path.join(work, `hard-${i}.f32`);
    await writeFile(file, Buffer.from(instantSwitch48k(gateOpenFrames(tracks.map((track) => track.levels), i), DEFAULT_CLEAN.bleedGateDb).buffer));
    hardFiles.push(file);
  }
  const hardClean: PreparedClean = { ...gated, extraInputs: hardFiles, inputArgs: hardFiles.map(() => RAW48K) };
  const tag = `${pair.name.replace(/\W+/g, "_")}-${withLevel ? "lvl" : "raw"}`;
  const [ungated, cleaned, hardCut] = await Promise.all([renderTracks(plain, tracks, `${tag}-u`), renderTracks(gated, tracks, `${tag}-g`), renderTracks(hardClean, tracks, `${tag}-h`)]);
  const speakers = [{ id: "A", other: "B", own: pair.speech.A, others: pair.speech.B }, { id: "B", other: "A", own: pair.speech.B, others: pair.speech.A }];
  const out: Record<string, unknown> = { fixture: pair.name, level: withLevel };
  let worstReduction = Infinity;
  let worstOnset100 = Infinity;
  let worstOnset100Closed = Infinity;
  let worstOnset20 = Infinity;
  let worstOnset20Closed = Infinity;
  const perSpeaker: Record<string, unknown> = {};
  const edgeRatios: number[] = [];
  let edgeStepGated = 0;
  let edgeStepHard = 0;
  let signalStep = 0;
  for (const speaker of speakers) {
    const i = speaker.id === "A" ? 0 : 1;
    const other = 1 - i;
    // bleed of the other speaker in this speaker's track: windows where only the other one speaks
    const bleedSpans = exclusive(speaker.others, speaker.own, 150);
    const before = rmsDb(ungated[i] as Float32Array, bleedSpans);
    const after = rmsDb(cleaned[i] as Float32Array, bleedSpans);
    const settled = rmsDb(cleaned[i] as Float32Array, bleedSpans, 150) - rmsDb(ungated[i] as Float32Array, bleedSpans, 150);
    // the speech of the other speaker as it sits in the mix of the cleaned tracks, against the bleed in the mix
    const speechInMix = rmsDb(cleaned[other] as Float32Array, bleedSpans);
    const speechInMixUngated = rmsDb(ungated[other] as Float32Array, bleedSpans);
    // onsets of this speaker's own speech
    const onsetStats = { all: [] as number[], closed: [] as number[], all20: [] as number[], closed20: [] as number[], at: [] as number[] };
    const open = gateOpenFrames(tracks.map((track) => track.levels), i);
    for (const span of speaker.own) {
      const frameBefore = Math.floor(Math.max(0, span.s - 20) / LEVEL_FRAME_MS);
      const wasClosed = speaker.others.some((o) => o.e + 300 >= span.s && o.s <= span.s) && (open[frameBefore] ?? 1) === 0;
      const d100 = rmsDb(cleaned[i] as Float32Array, [{ s: span.s, e: span.s + 100 }]) - rmsDb(ungated[i] as Float32Array, [{ s: span.s, e: span.s + 100 }]);
      const d20 = rmsDb(cleaned[i] as Float32Array, [{ s: span.s, e: span.s + 20 }]) - rmsDb(ungated[i] as Float32Array, [{ s: span.s, e: span.s + 20 }]);
      onsetStats.all.push(d100);
      onsetStats.all20.push(d20);
      onsetStats.at.push(span.s);
      if (wasClosed) {
        onsetStats.closed.push(d100);
        onsetStats.closed20.push(d20);
      }
    }
    // artefacts: gate edges
    const edges = transitions(open);
    const envelope = await readF32(gated.extraInputs[gated.gateInputs[i] as number] as string);
    const windows = [...edges.closing.map((t) => ({ from: t - 15, to: t + 100 })), ...edges.opening.map((t) => ({ from: t - 40 - 15, to: t - 40 + 100 }))];
    for (const window of windows) {
      const step = maxStep(cleaned[i] as Float32Array, window.from, window.to);
      const reference = maxStep(ungated[i] as Float32Array, window.from, window.to);
      edgeStepGated = Math.max(edgeStepGated, step);
      edgeStepHard = Math.max(edgeStepHard, maxStep(hardCut[i] as Float32Array, window.from, window.to));
      if (reference > 1e-3) edgeRatios.push(step / reference);
    }
    signalStep = Math.max(signalStep, maxStep(ungated[i] as Float32Array, 0, (ungated[i]?.length ?? 0) / SR * 1000));
    // false mute: frames of own speech whose mean gain is more than 3 dB down
    let speechFrameCount = 0;
    let muted = 0;
    let energy = 0;
    let mutedEnergy = 0;
    let mutedWhileOtherSpeaks = 0;
    let speechWhileOtherSpeaks = 0;
    for (const span of speaker.own) {
      for (let ms = Math.ceil(span.s / LEVEL_FRAME_MS) * LEVEL_FRAME_MS; ms + LEVEL_FRAME_MS <= span.e; ms += LEVEL_FRAME_MS) {
        let gain = 0;
        for (let k = ms; k < ms + LEVEL_FRAME_MS; k++) gain += envelope[k] ?? 1;
        gain /= LEVEL_FRAME_MS;
        const power = 10 ** (rmsDb(ungated[i] as Float32Array, [{ s: ms, e: ms + LEVEL_FRAME_MS }]) / 10);
        const overlap = speaker.others.some((o) => o.s <= ms + LEVEL_FRAME_MS && o.e >= ms);
        speechFrameCount += 1;
        energy += power;
        if (overlap) speechWhileOtherSpeaks += 1;
        if (gain < 10 ** (-3 / 20)) {
          muted += 1;
          mutedEnergy += power;
          if (overlap) mutedWhileOtherSpeaks += 1;
        }
      }
    }
    const minutes = (cleaned[i]?.length ?? 0) / SR / 60;
    worstReduction = Math.min(worstReduction, before - after);
    worstOnset100 = Math.min(worstOnset100, ...onsetStats.all);
    worstOnset20 = Math.min(worstOnset20, ...onsetStats.all20);
    if (onsetStats.closed.length > 0) {
      worstOnset100Closed = Math.min(worstOnset100Closed, ...onsetStats.closed);
      worstOnset20Closed = Math.min(worstOnset20Closed, ...onsetStats.closed20);
    }
    perSpeaker[`track${speaker.id}`] = {
      bleedSpans: bleedSpans.length,
      bleedBeforeDb: round(before),
      bleedAfterDb: round(after),
      reductionDb: round(before - after),
      reductionAfterSettlingDb: round(-settled),
      bleedToSpeechInMixBeforeDb: round(before - speechInMixUngated),
      bleedToSpeechInMixAfterDb: round(after - speechInMix),
      onsets: onsetStats.all.length,
      onsetsWithClosedGate: onsetStats.closed.length,
      onset100msWorstDb: round(Math.min(...onsetStats.all)),
      onset100msWorstAtMs: Math.round(onsetStats.at[onsetStats.all.indexOf(Math.min(...onsetStats.all))] ?? 0),
      onsetsBelowMinus1dB: onsetStats.all.filter((value) => value < -1).length,
      onset100msWorstClosedDb: onsetStats.closed.length ? round(Math.min(...onsetStats.closed)) : null,
      onset20msWorstDb: round(Math.min(...onsetStats.all20)),
      onset20msWorstClosedDb: onsetStats.closed20.length ? round(Math.min(...onsetStats.closed20)) : null,
      gateClosings: edges.closing.length,
      gateTransitionsPerMinute: round((edges.closing.length + edges.opening.length) / minutes, 1),
      closedShare: round(1 - open.reduce((sum, value) => sum + value, 0) / open.length, 3),
      speechFrames: speechFrameCount,
      speechFramesAttenuatedOver3dB: muted,
      falseMuteShare: round(muted / Math.max(1, speechFrameCount), 4),
      falseMuteEnergyShare: round(mutedEnergy / Math.max(1e-12, energy), 4),
      falseMuteWhileOtherSpeaks: `${mutedWhileOtherSpeaks}/${speechWhileOtherSpeaks}`,
    };
  }
  out.perTrack = perSpeaker;
  out.worstBleedReductionDb = round(worstReduction);
  out.worstOnset100msDb = round(worstOnset100);
  out.worstOnset20msDb = round(worstOnset20);
  out.worstOnset100msWhenGateWasClosedDb = Number.isFinite(worstOnset100Closed) ? round(worstOnset100Closed) : null;
  out.worstOnset20msWhenGateWasClosedDb = Number.isFinite(worstOnset20Closed) ? round(worstOnset20Closed) : null;
  out.artefacts = {
    maxStepAtGateEdgesGated: round(edgeStepGated, 5),
    maxStepAtGateEdgesHardSwitch: round(edgeStepHard, 5),
    maxStepOfTheSignalAnywhere: round(signalStep, 5),
    worstEdgeStepVsUngatedStepInSameWindow: round(Math.max(0, ...edgeRatios), 3),
  };
  return out;
}

/**
 * Click stress test: the gate is closed for 500 ms at 60 places in the middle of loud speech (the worst case for a click),
 * with the real envelope and with an instant switch, and the largest sample step around the edges is compared.
 */
async function stressClicks(pair: Pair): Promise<Record<string, unknown>> {
  const track = pair.b;
  const work = path.join(dir, "work");
  const loud = pair.speech.B.filter((span) => span.e - span.s > 1500);
  const places: number[] = [];
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 60; i++) {
    const span = loud[Math.floor(next() * loud.length)] as Span;
    places.push(Math.round((span.s + 300 + next() * (span.e - span.s - 900)) / LEVEL_FRAME_MS) * LEVEL_FRAME_MS);
  }
  places.sort((x, y) => x - y);
  const frames = track.levels.length;
  const open = new Uint8Array(frames).fill(1);
  const accepted: number[] = [];
  for (const place of places) {
    if (accepted.length > 0 && place - (accepted[accepted.length - 1] as number) < 1500) continue;
    accepted.push(place);
    open.fill(0, place / LEVEL_FRAME_MS, place / LEVEL_FRAME_MS + 25);
  }
  const smooth = gateEnvelope(open, DEFAULT_CLEAN.bleedGateDb);
  const files = [path.join(work, "stress-smooth.f32"), path.join(work, "stress-hard.f32")];
  await writeFile(files[0] as string, Buffer.from(smooth.buffer));
  await writeFile(files[1] as string, Buffer.from(instantSwitch48k(open, DEFAULT_CLEAN.bleedGateDb).buffer));
  const [smoothOut, hardOut] = await Promise.all(files.map((file, i) => renderTracks({ gains: { B: 0 }, chains: [""], extraInputs: [file], inputArgs: [i === 0 ? ["-f", "f32le", "-ar", String(ENVELOPE_RATE), "-ac", "1"] : RAW48K], gateInputs: [0] }, [track], `stress-${i}`).then((out) => out[0] as Float32Array)));
  let globalStep = 0;
  for (let i = 1; i < track.samples.length; i++) globalStep = Math.max(globalStep, Math.abs((track.samples[i] ?? 0) - (track.samples[i - 1] ?? 0)));
  let smoothMax = 0;
  let hardMax = 0;
  let smoothRatio = 0;
  let hardRatio = 0;
  for (const place of accepted) {
    for (const [from, to] of [[place - 2, place + 90], [place + 500 - 40 - 2, place + 500 - 40 + 20]] as const) {
      const reference = maxStep(track.samples, from, to);
      const s = maxStep(smoothOut as Float32Array, from, to);
      const h = maxStep(hardOut as Float32Array, from, to);
      smoothMax = Math.max(smoothMax, s);
      hardMax = Math.max(hardMax, h);
      smoothRatio = Math.max(smoothRatio, s / reference);
      hardRatio = Math.max(hardRatio, h / reference);
    }
  }
  // The fixtures are band-limited to 8 kHz (16 kHz sources), so everything above 10 kHz around an edge is a click made by the gate.
  const highpass = async (input: string[], name: string): Promise<Float32Array> => {
    const file = path.join(dir, `hp-${name}.f32`);
    await ffmpeg([...input, "-af", "highpass=f=10000,highpass=f=10000", "-f", "f32le", "-ar", String(SR), "-ac", "1", file]);
    return readF32(file);
  };
  const raw = (name: string): string[] => ["-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", path.join(dir, name)];
  const [hfUngated, hfSmooth, hfHard] = await Promise.all([highpass(["-i", track.file], "ungated"), highpass(raw("render-stress-0-0.f32"), "smooth"), highpass(raw("render-stress-1-0.f32"), "hard")]);
  const peakAround = (x: Float32Array): number => {
    let peak = 0;
    for (const place of accepted) {
      for (const [from, to] of [[place - 2, place + 90], [place + 500 - 40 - 2, place + 500 - 40 + 20]] as const) {
        for (let i = index(from); i < index(to); i++) peak = Math.max(peak, Math.abs(x[i] ?? 0));
      }
    }
    return db(peak ** 2);
  };
  return {
    gatedPlaces: accepted.length,
    peakAbove10kHzAroundEdgesUngatedDbfs: round(peakAround(hfUngated)),
    peakAbove10kHzAroundEdgesWithRampsDbfs: round(peakAround(hfSmooth)),
    peakAbove10kHzAroundEdgesInstantSwitchDbfs: round(peakAround(hfHard)),
    maxStepOfTheSignalAnywhere: round(globalStep, 5),
    maxStepAroundEdgesWithRamps: round(smoothMax, 5),
    maxStepAroundEdgesInstantSwitch: round(hardMax, 5),
    worstEdgeStepVsUngatedWithRamps: round(smoothRatio, 3),
    worstEdgeStepVsUngatedInstantSwitch: round(hardRatio, 3),
  };
}

/**
 * Heavy crosstalk: speaker B of fix-en is delayed by 3 s (so the two talk over each other for much of the time), with
 * B's level moved by `offset` dB against A, and each microphone hears the other speaker at -22 dB. Counts the speech frames
 * the gate attenuates by more than 3 dB: the level logic treats a speaker who is 10 dB or more under another one on their
 * own microphone as bleed.
 */
async function crosstalkStress(): Promise<Record<string, unknown>[]> {
  const base = path.join(asrDir, "fix-en");
  const delayMs = 3000;
  const [cleanA, cleanB] = await pairOf(await conform(path.join(base, "track_A.wav"), "track-en-A"), await conform(path.join(base, "track_B.wav"), "track-en-B"));
  const spansA = cleanSpans(cleanA.samples, cleanA.levels);
  const spansB = cleanSpans(cleanB.samples, cleanB.levels).map((span) => ({ s: span.s + delayMs, e: span.e + delayMs }));
  const flags = (spans: Span[], frames: number): Uint8Array => {
    const out = new Uint8Array(frames);
    for (const span of spans) out.fill(1, Math.floor(span.s / LEVEL_FRAME_MS), Math.min(frames, Math.floor(span.e / LEVEL_FRAME_MS)));
    return out;
  };
  const rows: Record<string, unknown>[] = [];
  for (const offset of [10, 0, -6, -10, -14, -20]) {
    const a = path.join(dir, `xt-${offset}-A.flac`);
    const b = path.join(dir, `xt-${offset}-B.flac`);
    if (!existsSync(b)) {
      const graph = `[1:a]adelay=${delayMs}:all=1,volume=${offset}dB,aresample=${SR}[b];[0:a]aresample=${SR}[a];[a]asplit[a1][a2];[b]asplit[b1][b2];[a1][b2]amix=inputs=2:weights='1 0.0794':normalize=0:duration=longest[ma];[b1][a2]amix=inputs=2:weights='1 0.0794':normalize=0:duration=longest[mb]`;
      await ffmpeg(["-i", path.join(base, "track_A.wav"), "-i", path.join(base, "track_B.wav"), "-filter_complex", graph, "-map", "[ma]", "-ac", "1", "-c:a", "flac", a, "-map", "[mb]", "-ac", "1", "-c:a", "flac", b]);
    }
    const [ta, tb] = await pairOf(a, b);
    const frames = Math.min(ta.levels.length, tb.levels.length);
    const fa = flags(spansA, frames);
    const fb = flags(spansB, frames);
    const muted = (index: number, own: Uint8Array, other: Uint8Array): { overlap: number; overlapMuted: number; alone: number; aloneMuted: number } => {
      const envelope = gateEnvelope(gateOpenFrames([ta.levels, tb.levels], index), DEFAULT_CLEAN.bleedGateDb);
      const out = { overlap: 0, overlapMuted: 0, alone: 0, aloneMuted: 0 };
      for (let frame = 0; frame < frames; frame++) {
        if (own[frame] !== 1) continue;
        let gain = 0;
        for (let k = frame * LEVEL_FRAME_MS; k < (frame + 1) * LEVEL_FRAME_MS; k++) gain += envelope[k] ?? 1;
        const down = gain / LEVEL_FRAME_MS < 10 ** (-3 / 20);
        if (other[frame] === 1) {
          out.overlap += 1;
          if (down) out.overlapMuted += 1;
        } else {
          out.alone += 1;
          if (down) out.aloneMuted += 1;
        }
      }
      return out;
    };
    const mutedA = muted(0, fa, fb);
    const mutedB = muted(1, fb, fa);
    rows.push({
      bOffsetDb: offset,
      overlapFrames: mutedA.overlap,
      aSpeechInOverlapAttenuatedOver3dB: round(mutedA.overlapMuted / Math.max(1, mutedA.overlap), 3),
      bSpeechInOverlapAttenuatedOver3dB: round(mutedB.overlapMuted / Math.max(1, mutedB.overlap), 3),
      aSpeechAloneAttenuatedOver3dB: round(mutedA.aloneMuted / Math.max(1, mutedA.alone), 4),
      bSpeechAloneAttenuatedOver3dB: round(mutedB.aloneMuted / Math.max(1, mutedB.alone), 4),
    });
  }
  return rows;
}

/** Envelope after the 1 kHz -> 48 kHz upsampling: overshoot above 1 and below the closed gain. */
async function envelopeRipple(): Promise<Record<string, unknown>> {
  const open = new Uint8Array(500);
  open.fill(1, 0, 100);
  open.fill(0, 100, 250);
  open.fill(1, 250, 300);
  open.fill(0, 300, 305); // a short closed stretch
  open.fill(1, 305, 500);
  const gateDb = -30;
  const envelope = gateEnvelope(open, gateDb);
  const file = path.join(dir, "ripple.f32");
  await writeFile(file, Buffer.from(envelope.buffer));
  const out = path.join(dir, "ripple-48k.f32");
  await ffmpeg(["-f", "f32le", "-ar", String(ENVELOPE_RATE), "-ac", "1", "-i", file, "-af", `aresample=${SR}`, "-f", "f32le", out]);
  const up = await readF32(out);
  let min = Infinity;
  let max = -Infinity;
  for (const value of up) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { gateDb, minAfterUpsampling: round(min, 5), closedGain: round(10 ** (gateDb / 20), 5), maxAfterUpsampling: round(max, 5), samples: up.length, expected: envelope.length * 48 };
}

// ---------- (b) loudness of the full chain ----------
interface Summary {
  lufs: number;
  lra: number;
  truePeakDb: number;
}

async function ebur128(file: string, raw = false): Promise<Summary> {
  const stderr = await ffmpeg([...(raw ? ["-f", "f32le", "-ar", String(SR), "-ac", "1"] : []), "-i", file, "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const number = (re: RegExp): number => Number(re.exec(summary)?.[1] ?? Number.NaN);
  return { lufs: number(/I:\s+(-?[\d.]+) LUFS/), lra: number(/LRA:\s+(-?[\d.]+) LU/), truePeakDb: number(/Peak:\s+(-?[\d.]+) dBFS/) };
}

const TARGET = { lufs: -16, truePeakDb: -1 };

/** The export audio path: cleanup -> mix (amix normalize=0 + limiter) -> cut -> two-pass loudnorm -> WAV; then ebur128 on the result. */
async function fullChain(tracks: CleanTrack[], options: CleanOptions, totalMs: number, tag: string, kept = [{ s: 0, e: totalMs }]): Promise<Record<string, unknown>> {
  const work = path.join(dir, "work");
  const t0 = Date.now();
  const clean = await prepareClean(options, tracks, work);
  const prepareMs = Date.now() - t0;
  const wired = cleanInputsGraph(clean, tracks.map((_, i) => i), tracks.length);
  const program = audioProgramGraph(tracks.length, kept, totalMs);
  const mix = program.graph.replace(/\[(\d+):a\]/g, (_, n: string) => wired.labels[Number(n)] ?? `[${n}:a]`);
  const graph = [...wired.lines, mix].join(";\n");
  const inputs = [...tracks.flatMap((track) => ["-i", track.file]), ...clean.extraInputs.flatMap((file, i) => [...(clean.inputArgs[i] ?? []), "-i", file])];
  const script = path.join(dir, `graph-${tag}.txt`);
  const measureScript = path.join(dir, `graph-${tag}-measure.txt`);
  await writeFile(measureScript, `${graph};\n${program.label}loudnorm=I=${TARGET.lufs}:TP=${TARGET.truePeakDb}:LRA=11:print_format=json[out]`);
  const p1 = Date.now();
  const stderr = await ffmpeg([...inputs, "-filter_complex_script", measureScript, "-map", "[out]", "-f", "null", "-"]);
  const pass1Ms = Date.now() - p1;
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
  if (!json) throw new Error("no loudnorm measurement");
  const measured = JSON.parse(json) as { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };
  await writeFile(script, `${graph};\n${program.label}${loudnormFilter({ lufs: TARGET.lufs, truePeakDb: TARGET.truePeakDb }, measured)}[aout]`);
  const output = path.join(dir, `out-${tag}.wav`);
  const p2 = Date.now();
  await ffmpeg([...inputs, "-filter_complex_script", script, "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", String(SR), output]);
  const pass2Ms = Date.now() - p2;
  const final = await ebur128(output);
  return {
    gains: clean.gains,
    inputMeasured: { lufs: Number(measured.input_i), truePeakDb: Number(measured.input_tp), lra: Number(measured.input_lra) },
    output: { lufs: round(final.lufs), truePeakDb: round(final.truePeakDb), lra: round(final.lra) },
    lufsError: round(final.lufs - TARGET.lufs),
    within1LU: Math.abs(final.lufs - TARGET.lufs) <= 1,
    truePeakOk: final.truePeakDb <= TARGET.truePeakDb,
    wallMs: { prepare: prepareMs, pass1: pass1Ms, pass2: pass2Ms },
  };
}

// ---------- level ----------
async function evaluateLevel(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const scenarios: { name: string; a: string; b: string; filterA: string; filterB: string }[] = [];
  for (const lang of ["en", "pl"]) {
    const base = path.join(asrDir, `fix-${lang}`);
    scenarios.push({ name: `fix-${lang} clean tracks as recorded`, a: path.join(base, "track_A.wav"), b: path.join(base, "track_B.wav"), filterA: "", filterB: "" });
    scenarios.push({ name: `fix-${lang} A +4 dB, B -10 dB`, a: path.join(base, "track_A.wav"), b: path.join(base, "track_B.wav"), filterA: "volume=4dB", filterB: "volume=-10dB" });
    scenarios.push({ name: `fix-${lang} A +22 dB, B -6 dB (beyond the clamp)`, a: path.join(base, "track_A.wav"), b: path.join(base, "track_B.wav"), filterA: "volume=14dB", filterB: "volume=-14dB" });
  }
  for (const scenario of scenarios) {
    const key = scenario.name.replace(/\W+/g, "_");
    const tracks = await Promise.all([
      trackOf("A", await conform(scenario.a, `lvl-${key}-A`, scenario.filterA)),
      trackOf("B", await conform(scenario.b, `lvl-${key}-B`, scenario.filterB)),
    ]);
    const prepared = await prepareClean({ ...DEFAULT_CLEAN, level: true }, tracks, path.join(dir, "work"));
    const before = await Promise.all(tracks.map(async (track, i) => ({ estimate: speechLevelDb(track.levels, [tracks[1 - i]?.levels as Int8Array]), loudness: await ebur128(track.file) })));
    const rendered = await renderTracks(prepared, tracks, `lvl-${key}`);
    const afterFiles = rendered.map((samples, i) => ({ samples, file: path.join(dir, `render-lvl-${key}-${i}.f32`) }));
    const afterLevels = rendered.map(levelsOf);
    const after = await Promise.all(afterFiles.map(async (item, i) => ({ estimate: speechLevelDb(afterLevels[i] as Int8Array, [afterLevels[1 - i] as Int8Array]), loudness: await ebur128(item.file, true) })));
    const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
    rows.push({
      scenario: scenario.name,
      gainsDb: prepared.gains,
      speechLevelDbBefore: before.map((item) => round(item.estimate ?? Number.NaN)),
      speechLevelDbAfter: after.map((item) => round(item.estimate ?? Number.NaN)),
      trackLufsBefore: before.map((item) => round(item.loudness.lufs)),
      trackLufsAfter: after.map((item) => round(item.loudness.lufs)),
      differenceBetweenTracksLuBefore: round(spread(before.map((item) => item.loudness.lufs))),
      differenceBetweenTracksLuAfter: round(spread(after.map((item) => item.loudness.lufs))),
    });
  }
  return rows;
}

// ---------- dynamics: what a compressor or dynamic normaliser would add after the static gain ----------
async function evaluateDynamics(): Promise<Record<string, unknown>> {
  const base = path.join(asrDir, "fix-en", "track_B.wav");
  // the speaker drifts +-6 dB slowly and steps down 8 dB after 5 minutes (leaning away from the microphone)
  const wobble = "volume='pow(10,(6*sin(2*PI*t/45)-8*gte(t,300))/20)':eval=frame";
  const source = await conform(base, "dyn-wobble", wobble);
  const variants: Record<string, string> = {
    staticOnly: "anull",
    acompressorGentle: "acompressor=threshold=0.04:ratio=2:attack=20:release=300:knee=4:makeup=1",
    dynaudnormGentle: "dynaudnorm=f=500:g=31:m=3:t=0.02:s=0",
    dynaudnormDefault: "dynaudnorm",
  };
  const original = await trackOf("B", source);
  const speech = speechFrames(original.levels, DEFAULT_VAD, []);
  const blockSpread = (samples: Float32Array): { p10: number; p90: number; spread: number } => {
    const levels = levelsOf(samples);
    const per = 150; // 3 s of frames
    const blocks: number[] = [];
    for (let from = 0; from + per <= levels.length; from += per) {
      let sum = 0;
      let count = 0;
      for (let frame = from; frame < from + per; frame++) {
        if (speech[frame] !== 1) continue;
        sum += 10 ** ((levels[frame] as number) / 10);
        count += 1;
      }
      if (count >= 50) blocks.push(10 * Math.log10(sum / count));
    }
    blocks.sort((x, y) => x - y);
    const p10 = blocks[Math.floor(blocks.length * 0.1)] ?? 0;
    const p90 = blocks[Math.floor(blocks.length * 0.9)] ?? 0;
    return { p10, p90, spread: p90 - p10 };
  };
  const floorOf = (samples: Float32Array): number => {
    const levels = levelsOf(samples);
    const quiet: number[] = [];
    levels.forEach((level, frame) => {
      if (speech[frame] !== 1 && !speech[frame - 1] && !speech[frame + 1]) quiet.push(level);
    });
    quiet.sort((x, y) => x - y);
    return quiet[Math.floor(quiet.length / 2)] ?? -100;
  };
  const rows: Record<string, unknown> = {};
  for (const [name, chain] of Object.entries(variants)) {
    const file = path.join(dir, `dyn-${name}.f32`);
    const t0 = Date.now();
    await ffmpeg(["-i", source, "-af", chain, "-f", "f32le", "-ar", String(SR), "-ac", "1", file]);
    const wallMs = Date.now() - t0;
    const samples = await readF32(file);
    const spread = blockSpread(samples);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    const loud = await ebur128(file, true);
    rows[name] = { spreadDb3sBlocks: round(spread.spread), p10: round(spread.p10), p90: round(spread.p90), pauseLevelMedianDb: floorOf(samples), peakDbfs: round(db(peak ** 2)), lufs: round(loud.lufs), wallMs };
  }
  rows.note = "spread = P90-P10 of the speech level over 3 s blocks of a track with a +-6 dB 45 s wobble and an 8 dB step; pause level = median level of frames away from speech";
  return rows;
}

// ---------- denoise ----------
async function evaluateDenoise(): Promise<Record<string, unknown>> {
  const modelsDir = path.join(dir, "models");
  const t0 = Date.now();
  const model = await ensureRnnoiseModel(modelsDir);
  const downloadMs = Date.now() - t0;
  const clean = await conform(path.join(asrDir, "fix-en", "track_A.wav"), "dn-clean", "atrim=0:120");
  const noisy = path.join(dir, "dn-noisy.flac");
  if (!existsSync(noisy)) {
    await ffmpeg(["-i", clean, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.02:sample_rate=${SR}:seed=7`, "-f", "lavfi", "-i", `sine=frequency=100:sample_rate=${SR}`, "-filter_complex", "[2:a]volume=-48dB[hum];[1:a]volume=-3dB[n];[0:a][n][hum]amix=inputs=3:normalize=0:duration=first[o]", "-map", "[o]", "-ac", "1", "-c:a", "flac", noisy]);
  }
  const cleanTrack = await trackOf("A", clean);
  const speech = speechFrames(cleanTrack.levels, DEFAULT_VAD, []);
  const speechSpans: Span[] = [];
  const quietSpans: Span[] = [];
  for (let frame = 5; frame < speech.length - 5; frame++) {
    const near = speech.subarray(frame - 5, frame + 6).some((flag) => flag === 1);
    if (speech[frame] === 1) speechSpans.push({ s: frame * LEVEL_FRAME_MS, e: (frame + 1) * LEVEL_FRAME_MS });
    else if (!near) quietSpans.push({ s: frame * LEVEL_FRAME_MS, e: (frame + 1) * LEVEL_FRAME_MS });
  }
  const noisyTrack = await trackOf("A", noisy);
  const results: Record<string, unknown> = { downloadMs, model: path.basename(model), noisyInput: { quietLevelDb: round(rmsDb(noisyTrack.samples, quietSpans)), speechLevelDb: round(rmsDb(noisyTrack.samples, speechSpans)) } };
  const models: Record<string, string> = { default: model };
  if (altModel) models[path.basename(altModel)] = altModel;
  for (const [name, file] of Object.entries(models)) {
    const prepared = await prepareClean({ ...DEFAULT_CLEAN, denoise: true, rnnoiseModel: file }, [noisyTrack], path.join(dir, "work"));
    const t1 = Date.now();
    const [processed] = await renderTracks(prepared, [noisyTrack], `dn-${name}`);
    const wallMs = Date.now() - t1;
    const out = processed as Float32Array;
    // delay: best lag of the processed signal against the noisy input over 10 s of speech
    let bestLag = 0;
    let best = -Infinity;
    const from = index(20_000);
    const length = index(10_000);
    for (let lag = -index(30); lag <= index(30); lag++) {
      let sum = 0;
      for (let i = from; i < from + length; i += 3) sum += (out[i + lag] ?? 0) * (noisyTrack.samples[i] ?? 0);
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    // signal to error ratio against the clean speech, noisy input vs processed (speech frames only)
    const ser = (x: Float32Array, lag: number): number => {
      let signal = 0;
      let error = 0;
      for (const span of speechSpans) {
        for (let i = index(span.s); i < index(span.e); i++) {
          const reference = cleanTrack.samples[i] ?? 0;
          signal += reference ** 2;
          error += ((x[i + lag] ?? 0) - reference) ** 2;
        }
      }
      return db(signal / error);
    };
    results[name] = {
      quietLevelDb: round(rmsDb(out, quietSpans)),
      noiseReductionDb: round(rmsDb(noisyTrack.samples, quietSpans) - rmsDb(out, quietSpans)),
      speechLevelChangeDb: round(rmsDb(out, speechSpans) - rmsDb(noisyTrack.samples, speechSpans)),
      speechSerNoisyInputDb: round(ser(noisyTrack.samples, 0)),
      delaySamples: bestLag,
      delayMs: round((bestLag / SR) * 1000, 3),
      wallMsFor120s: wallMs,
      speechSerProcessedDb: round(ser(out, bestLag)),
    };
  }
  return results;
}

// ---------- run ----------
const result: Record<string, unknown> = { ffmpeg: (await run("ffmpeg", ["-version"])).stdout.split("\n")[0] };
if (only.has("gate")) {
  const pairs: Pair[] = [await loadSilenceFixture("en"), await loadSilenceFixture("pl"), await loadConversationFixture("en", "bleed"), await loadConversationFixture("pl", "bleed")];
  const rows: Record<string, unknown>[] = [];
  for (const pair of pairs) rows.push(await evaluateGate(pair, false));
  result.gate = rows;
  result.gateWithLevel = [await evaluateGate(pairs[2] as Pair, true), await evaluateGate(pairs[1] as Pair, true)];
  result.envelopeUpsampling = await envelopeRipple();
  result.crosstalk = await crosstalkStress();
  result.clickStress = { en: await stressClicks(pairs[0] as Pair), pl: await stressClicks(pairs[1] as Pair), enConversation: await stressClicks(pairs[2] as Pair) };
  const worst = Math.min(...rows.map((row) => row.worstBleedReductionDb as number));
  const onset = Math.min(...rows.map((row) => row.worstOnset100msDb as number));
  result.gateSummary = { worstBleedReductionDb: worst, worstOnset100msDb: onset, bleedGateGate6dB: worst >= 6, onsetGate1dB: onset >= -1 };
}
if (only.has("loudness")) {
  const rows: Record<string, unknown>[] = [];
  for (const lang of ["en", "pl"]) {
    for (const kind of ["track", "bleed"] as const) {
      const tracks = await Promise.all(["A", "B"].map(async (id) => trackOf(id, await conform(path.join(asrDir, `fix-${lang}`, `${kind}_${id}.wav`), `${kind}-${lang}-${id}`))));
      const totalMs = Math.max(...tracks.map((track) => track.levels.length)) * LEVEL_FRAME_MS;
      const variants: [string, CleanOptions][] = [["off", DEFAULT_CLEAN], ["level+bleedGate", { ...DEFAULT_CLEAN, level: true, bleedGate: true }]];
      // each option on its own, once
      if (lang === "en" && kind === "track") variants.push(["level", { ...DEFAULT_CLEAN, level: true }], ["bleedGate", { ...DEFAULT_CLEAN, bleedGate: true }]);
      for (const [name, options] of variants) rows.push({ fixture: `fix-${lang} ${kind}`, cleanup: name, durationSec: round(totalMs / 1000, 1), ...(await fullChain(tracks, options, totalMs, `${lang}-${kind}-${name}`)) });
      // the same with cuts: the cut graph (asplit/concat) in the chain
      const cuts = [{ s: 0, e: 40_000 }, { s: 55_000, e: 200_000 }, { s: 230_000, e: totalMs }];
      rows.push({ fixture: `fix-${lang} ${kind}`, cleanup: "level+bleedGate, 3 kept ranges", ...(await fullChain(tracks, { ...DEFAULT_CLEAN, level: true, bleedGate: true }, totalMs, `${lang}-${kind}-cut`, cuts)) });
    }
  }
  result.loudness = rows;
  const gated = rows.filter((row) => String(row.cleanup).startsWith("level+bleedGate"));
  result.loudnessSummary = { runs: gated.length, allWithin1LU: gated.every((row) => row.within1LU === true), allTruePeakOk: gated.every((row) => row.truePeakOk === true), worstErrorLu: Math.max(...gated.map((row) => Math.abs(row.lufsError as number))) };
}
if (only.has("level")) result.level = await evaluateLevel();
if (only.has("dynamics")) result.dynamics = await evaluateDynamics();
if (only.has("denoise")) result.denoise = await evaluateDenoise();
void levelGains;
await writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
