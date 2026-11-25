// Audio cleanup of the export: per-track leveling, a bleed gate and an optional RNNoise denoiser. Everything runs inside
// the one ffmpeg filter graph of the export, between the conformed tracks and the mix; no track file is written to.
//
// Pieces (per track, in this order in the graph: level, denoise, gate)
//   level      One static gain per track (clamped to +/-12 dB) that brings the speech of every participant to the mean
//              speech level of the project. The speech level is measured on the level frames (`levels/<id>.bin`), on
//              the frames the voice activity detector calls speech (cross-track bleed excluded), as the power mean.
//              No compressor and no dynamic normaliser follow (see docs/audio-cleanup.md for the measurements).
//   denoise    `arnndn` with an RNNoise model; needs a model file (`ensureRnnoiseModel` downloads one into the models
//              directory when called explicitly, nothing downloads by itself). `arnndn` delays the audio by one RNNoise
//              frame (480 samples); the chain removes that delay again, so the track stays aligned with the others.
//   bleedGate  A track is attenuated by `bleedGateDb` while another track is speaking and this one is not (this one is
//              bleed only: its own frames are not speech, e.g. another microphone is 10 dB or more louder on its own
//              mic). Attack 10 ms, release 80 ms, 40 ms look-ahead (the gate opens before the onset it announces). When
//              nobody speaks, every gate stays open. The gain envelope is a mono float32 file at 1 kHz
//              (`-f f32le -ar 1000 -ac 1`), upsampled to 48 kHz by `aresample` and multiplied with the track by
//              `amultiply` (the envelope is longer than its track: `amultiply` ends with the shorter input).
// All options are off in `DEFAULT_CLEAN`. Pass microphone tracks only: another source (the sound of a shared screen)
// would be taken for a speaker; leave it out of `tracks` and it simply stays in the mix as it is.
//
// Shape of the result of `prepareClean` (arrays follow the order of `tracks`, except `extraInputs` and `inputArgs`):
//   gains        static gain per track id in dB (0 when none is applied)
//   chains       the linear filter chain of each track (gain, denoise), without pads, "" when nothing applies
//   extraInputs  the envelope files, one per gated track, in track order (absolute paths inside `workDir`)
//   inputArgs    for each extra input, the ffmpeg arguments that go right before its `-i`
//   gateInputs   for each track, the index into `extraInputs` of its envelope, or null when it has no gate
// The caller removes the files of `extraInputs` when the export is done.
//
// Wiring into one ffmpeg command, the tracks being inputs 0..n-1 and the extra inputs following them:
//   const clean = await prepareClean(options, tracks, tmpDir);
//   args  = [...trackFiles.flatMap((file) => ["-i", file]), ...clean.extraInputs.flatMap((file, i) => [...clean.inputArgs[i], "-i", file])];
//   wired = cleanInputsGraph(clean, trackFiles.map((_, i) => i), trackFiles.length);   // { lines, labels }
//   graph = [...wired.lines, <the mix graph, reading wired.labels[i] where it read `[i:a]`>].join(";\n");
// The first loudness pass and the encode use the same arguments and graph, so both see the same cleaned audio. The
// envelope is computed once, in `prepareClean`.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFORM_SAMPLE_RATE, LEVEL_FRAME_MS } from "../../shared/project.js";
import { DEFAULT_VAD, speechFrames } from "../../shared/vad.js";

export interface CleanOptions {
  /** One static gain per track so every participant's speech sits at the same level. */
  level: boolean;
  /** Attenuate a track while another one is clearly the speaker. */
  bleedGate: boolean;
  /** How far the gate attenuates, in dB (negative). */
  bleedGateDb: number;
  /** RNNoise denoiser (`arnndn`), needs `rnnoiseModel`. */
  denoise: boolean;
  /** Path of an RNNoise model file (see `ensureRnnoiseModel`). */
  rnnoiseModel?: string;
}

/** Cleanup is opt-in. */
export const DEFAULT_CLEAN: CleanOptions = { level: false, bleedGate: false, bleedGateDb: -30, denoise: false };

export interface CleanTrack {
  /** The track id (the key of `gains`). */
  id: string;
  /** Conformed audio file; the caller feeds it to ffmpeg, it is not read here. */
  file: string;
  /** Level frames (Int8 dBFS per `LEVEL_FRAME_MS`) of this track. */
  levels: Int8Array;
}

export interface PreparedClean {
  gains: Record<string, number>;
  chains: string[];
  extraInputs: string[];
  inputArgs: string[][];
  gateInputs: (number | null)[];
}

/** Largest static gain, up or down. */
export const MAX_GAIN_DB = 12;
/** Fewer speech frames than this (2 s) and the track is too short on speech to be measured. */
export const MIN_SPEECH_FRAMES = 100;
export const GATE_ATTACK_MS = 10;
export const GATE_RELEASE_MS = 80;
export const GATE_LOOKAHEAD_MS = 40;
/** Another track counts as speaking this long after its last speech frame (bridges the gaps between words). */
export const GATE_HOLD_MS = 300;
/** A track counts as speaking this long after its own last speech frame (keeps the tail of a word). */
export const GATE_HANG_MS = 120;
export const ENVELOPE_RATE = 1000;
/** The envelope runs this much past the last level frame, so that `amultiply` never ends before its audio does. */
export const GATE_TAIL_MS = 1000;
/** Samples in one RNNoise frame (10 ms at 48 kHz), the delay of `arnndn`. */
export const RNNOISE_FRAME = 480;

/** Level of the speech of one track in dB (power mean of its speech frames), or null when there is too little speech. */
export function speechLevelDb(levels: Int8Array, others: Int8Array[] = []): number | null {
  const flags = speechFrames(levels, DEFAULT_VAD, others);
  let sum = 0;
  let count = 0;
  for (let frame = 0; frame < levels.length; frame++) {
    if (flags[frame] !== 1) continue;
    sum += 10 ** ((levels[frame] as number) / 10);
    count += 1;
  }
  return count < MIN_SPEECH_FRAMES ? null : 10 * Math.log10(sum / count);
}

/** Static gain of every track in dB: toward the mean speech level of the tracks that have speech, clamped. */
export function levelGains(tracks: Pick<CleanTrack, "id" | "levels">[]): Record<string, number> {
  const measured = tracks.map((track, index) => speechLevelDb(track.levels, tracks.filter((_, other) => other !== index).map((other) => other.levels)));
  const known = measured.filter((value): value is number => value !== null);
  const gains: Record<string, number> = {};
  const target = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : 0;
  tracks.forEach((track, index) => {
    const level = measured[index];
    gains[track.id] = level === null || level === undefined ? 0 : Math.round(Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, target - level)) * 100) / 100;
  });
  return gains;
}

/** Marks every frame that follows a flagged frame within `frames` as flagged too. */
function hold(flags: Uint8Array, frames: number): Uint8Array {
  const out = new Uint8Array(flags.length);
  let left = 0;
  for (let frame = 0; frame < flags.length; frame++) {
    if (flags[frame] === 1) left = frames + 1;
    if (left > 0) {
      out[frame] = 1;
      left -= 1;
    }
  }
  return out;
}

/**
 * Detector of a track's own activity: more sensitive than speech detection, because a gate that opens too early costs
 * less than one that clips a soft onset. A run of frames above the sensitive threshold counts from its first frame when
 * it lasts `GATE_SUSTAIN_FRAMES`; a single frame counts only when it is speech by the normal threshold.
 */
const OWN_ACTIVITY = { ...DEFAULT_VAD, marginDb: 6, minLevelDb: -60 };
export const GATE_SUSTAIN_FRAMES = 2;

function ownActivity(own: Int8Array, others: Int8Array[]): Uint8Array {
  const sensitive = speechFrames(own, OWN_ACTIVITY, others);
  const strong = speechFrames(own, DEFAULT_VAD, others);
  const out = new Uint8Array(own.length);
  let start = -1;
  for (let frame = 0; frame <= own.length; frame++) {
    const on = frame < own.length && sensitive[frame] === 1;
    if (on && start < 0) start = frame;
    if (!on && start >= 0) {
      if (frame - start >= GATE_SUSTAIN_FRAMES) out.fill(1, start, frame);
      start = -1;
    }
  }
  for (let frame = 0; frame < own.length; frame++) if (strong[frame] === 1) out[frame] = 1;
  return out;
}

/**
 * Per frame of track `index`: 1 when its gate is open. The gate is closed while another track is speaking and this one
 * is not (own activity excludes frames in which another microphone is 10 dB louder, which is bleed).
 */
export function gateOpenFrames(levels: Int8Array[], index: number): Uint8Array {
  const own = levels[index];
  if (!own) throw new RangeError("no such track");
  const others = levels.filter((_, other) => other !== index);
  const ownActive = hold(ownActivity(own, others), Math.round(GATE_HANG_MS / LEVEL_FRAME_MS));
  const othersSpeech = new Uint8Array(own.length);
  others.forEach((track, i) => {
    const held = hold(speechFrames(track, DEFAULT_VAD, others.filter((_, other) => other !== i).concat(own)), Math.round(GATE_HOLD_MS / LEVEL_FRAME_MS));
    for (let frame = 0; frame < own.length; frame++) if (held[frame] === 1) othersSpeech[frame] = 1;
  });
  const open = new Uint8Array(own.length);
  for (let frame = 0; frame < own.length; frame++) open[frame] = ownActive[frame] === 1 || othersSpeech[frame] === 0 ? 1 : 0;
  return open;
}

/**
 * Gain envelope at `ENVELOPE_RATE` (one value per ms) for the open/closed frames: the closed gain is `gateDb`. The gate
 * opens `GATE_LOOKAHEAD_MS` before the frame that opens it, rises in `GATE_ATTACK_MS` and falls in `GATE_RELEASE_MS`
 * (both are the time for the whole range; the ramps are linear in dB, corners rounded over 1 ms). Open at the end, with
 * `tailMs` more.
 */
export function gateEnvelope(open: Uint8Array, gateDb: number, tailMs = GATE_TAIL_MS): Float32Array {
  const length = open.length * LEVEL_FRAME_MS + tailMs;
  const early = new Uint8Array(length);
  let since = Infinity;
  for (let ms = length - 1; ms >= 0; ms--) {
    const frame = Math.floor(ms / LEVEL_FRAME_MS);
    const isOpen = frame >= open.length || open[frame] === 1;
    since = isOpen ? 0 : since + 1;
    early[ms] = since <= GATE_LOOKAHEAD_MS ? 1 : 0;
  }
  const up = -gateDb / GATE_ATTACK_MS;
  const down = -gateDb / GATE_RELEASE_MS;
  const trajectory = new Float64Array(length);
  let level = early[0] === 1 ? 0 : gateDb;
  for (let ms = 0; ms < length; ms++) {
    level = early[ms] === 1 ? Math.min(0, level + up) : Math.max(gateDb, level - down);
    trajectory[ms] = level;
  }
  // [1 2 1] smoothing of the dB trajectory rounds the corners of the ramps; without it the upsampling filter overshoots the open gain by 3%
  const envelope = new Float32Array(length);
  for (let ms = 0; ms < length; ms++) {
    const smooth = ((trajectory[Math.max(0, ms - 1)] ?? 0) + 2 * (trajectory[ms] ?? 0) + (trajectory[Math.min(length - 1, ms + 1)] ?? 0)) / 4;
    envelope[ms] = 10 ** (smooth / 20);
  }
  return envelope;
}

function f32le(values: Float32Array): Buffer {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeFloatLE(values[i] as number, i * 4);
  return out;
}

/** Escapes a value for use inside a filter option of a filter graph text (two levels: option, then graph). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
}

/** Computes the gains, writes the envelope files into `workDir` and returns what the export graph needs (see the header). */
export async function prepareClean(options: CleanOptions, tracks: CleanTrack[], workDir: string): Promise<PreparedClean> {
  if (options.bleedGate && !(options.bleedGateDb < 0 && options.bleedGateDb >= -90)) throw new RangeError("bleedGateDb must be between -90 and 0 dB");
  if (options.denoise) {
    if (!options.rnnoiseModel) throw new Error("denoise needs an RNNoise model: call ensureRnnoiseModel(modelsDir) and pass its path as rnnoiseModel");
    const info = await stat(options.rnnoiseModel).catch(() => null);
    if (!info?.isFile()) throw new Error(`RNNoise model not found: ${options.rnnoiseModel}`);
  }
  const gains = options.level ? levelGains(tracks) : Object.fromEntries(tracks.map((track) => [track.id, 0]));
  const chains = tracks.map((track) => {
    const chain: string[] = [];
    const gain = gains[track.id] ?? 0;
    if (gain !== 0) chain.push(`volume=${gain.toFixed(2)}dB`);
    // arnndn delays its output by one RNNoise frame and drops the last frame: the delay is cut off at the front and the end padded
    if (options.denoise && options.rnnoiseModel) chain.push(`arnndn=m=${escapeFilterValue(options.rnnoiseModel)}`, `atrim=start_sample=${RNNOISE_FRAME},asetpts=PTS-STARTPTS`, `apad=pad_len=${RNNOISE_FRAME}`);
    return chain.join(",");
  });
  const extraInputs: string[] = [];
  const inputArgs: string[][] = [];
  const gateInputs: (number | null)[] = [];
  if (options.bleedGate && tracks.length > 1) await mkdir(workDir, { recursive: true });
  for (const [index, track] of tracks.entries()) {
    if (!options.bleedGate || tracks.length < 2) {
      gateInputs.push(null);
      continue;
    }
    const open = gateOpenFrames(tracks.map((other) => other.levels), index);
    const file = path.join(workDir, `gate-${createHash("sha1").update(track.id).digest("hex").slice(0, 10)}-${randomBytes(3).toString("hex")}.f32`);
    await writeFile(file, f32le(gateEnvelope(open, options.bleedGateDb)));
    gateInputs.push(extraInputs.length);
    extraInputs.push(file);
    inputArgs.push(["-f", "f32le", "-ar", String(ENVELOPE_RATE), "-ac", "1"]);
  }
  return { gains, chains, extraInputs, inputArgs, gateInputs };
}

/**
 * Graph lines that clean every track. Track `i` is read from input `trackInputs[i]` and the extra inputs start at input
 * `firstExtraInput`. `labels[i]` is the pad to feed the mix with: the cleaned track, or the track's own `[n:a]` pad when
 * nothing applies to it (so a graph with all options off is unchanged).
 */
export function cleanInputsGraph(clean: PreparedClean, trackInputs: number[], firstExtraInput: number): { lines: string[]; labels: string[] } {
  const lines: string[] = [];
  const labels: string[] = [];
  trackInputs.forEach((input, index) => {
    const chain = clean.chains[index] ?? "";
    const gate = clean.gateInputs[index] ?? null;
    let label = `[${input}:a]`;
    if (chain !== "") {
      lines.push(`${label}${chain}[cl${index}]`);
      label = `[cl${index}]`;
    }
    if (gate !== null) {
      lines.push(`[${firstExtraInput + gate}:a]aresample=${CONFORM_SAMPLE_RATE}[ge${index}]`);
      lines.push(`${label}[ge${index}]amultiply[cg${index}]`);
      label = `[cg${index}]`;
    }
    labels.push(label);
  });
  return { lines, labels };
}

// ---- RNNoise model ----

/**
 * The model used for denoising: `beguiling-drafter` of the rnnoise-models project (recording noise, voice signal),
 * pinned to a commit. The project states that the models are not creative work and not subject to copyright; the
 * RNNoise code they come from is BSD-3-Clause.
 */
export const RNNOISE_MODEL = {
  file: "bd.rnnn",
  url: "https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/beguiling-drafter-2018-08-30/bd.rnnn",
  sha256: "ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b",
};

export interface RnnoiseSource {
  file: string;
  url: string;
  sha256: string;
}

const MAX_MODEL_BYTES = 8 * 1024 * 1024;

/**
 * Path of the RNNoise model inside `<modelsDir>/rnnoise`, downloaded once (and checked against its SHA-256) when it is
 * not there yet. Only runs when called; nothing downloads by itself. A file that fails the checksum is replaced.
 */
export async function ensureRnnoiseModel(modelsDir: string, options: { source?: RnnoiseSource; fetch?: typeof fetch } = {}): Promise<string> {
  const source = options.source ?? RNNOISE_MODEL;
  const doFetch = options.fetch ?? fetch;
  const dir = path.join(modelsDir, "rnnoise");
  const target = path.join(dir, source.file);
  const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
  const existing = await readFile(target).catch(() => null);
  if (existing && sha(existing) === source.sha256) return target;
  await mkdir(dir, { recursive: true });
  let response: Response;
  try {
    response = await doFetch(source.url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`cannot download the RNNoise model from ${source.url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`cannot download the RNNoise model from ${source.url}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_MODEL_BYTES) throw new Error(`the RNNoise model download has an unexpected size (${data.length} bytes)`);
  const got = sha(data);
  if (got !== source.sha256) throw new Error(`the RNNoise model download is corrupt: SHA-256 ${got}, expected ${source.sha256}`);
  const temp = `${target}.${randomBytes(4).toString("hex")}.part`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return target;
}
