// Gate measurements of active speaker switching (src/shared/scenes.ts) on fixtures with known speech spans. Usage:
//   tsx scripts/bench-speaker.ts [--asr <spike work dir>] [--out <result file>]
// The work dir holds fix-silence-en|pl (TTS conversation, truth.json with exact speech spans per speaker, the
// tracks carry a -24 dB copy of the other voice) and fix-en|pl (clean A/B tracks, the -22 dB bleed pair bleed_A/B and
// conversation.json with the reference utterance times). Levels come from the WAV files with the same definition as
// the conform step (RMS of every 20 ms in dBFS, rounded, floor -100). Prints one JSON document.
//
// Ground truth. The TTS spans are exact. conversation.json gives the utterance slots of the FLEURS conversation, and a
// slot holds the clip's own leading and trailing silence (1-2 s), so it over-states speech time: `slot` measures against
// the raw slots, `tight` against the voiced part of each slot, found on the speaker's own CLEAN track (track_A/B.wav, no
// bleed): from its first to its last speech frame, so pauses inside an utterance count and the clip padding does not.
// The bleed cases plan on bleed_A/B.wav but are judged against the clean track's spans.
//
// The `product-*` cases are the real pipeline: the level tracks the conform step wrote for the clean and the bleed
// project of the transcription bench (<products>/bench-asr3-<lang>/post/bench-<clean|bleed>-<lang>-0001/levels/*.bin,
// from opus webm) judged against the word times of the product transcript (`words`: the words of each speaker, gaps
// up to 400 ms bridged). Those times come from the speech engine, not from the level tracks, so they check the onsets
// independently of the voice activity detection the planner uses.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { effectiveMinDwellMs, planScenes, RHYTHMS, sceneAt, DEFAULT_SCENE_PARAMS, type ActivityTrack, type Rhythm, type Scene, type SceneParams } from "../src/shared/scenes.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "../src/shared/project.js";
import { DEFAULT_VAD, speechFrames, type VadOptions } from "../src/shared/vad.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const asr = path.resolve(arg("asr", path.join(process.env.TMPDIR ?? ".", "asr")));
const productRoot = path.resolve(arg("products", process.env.TMPDIR ?? "."));
const outFile = arg("out", "");

/** Mono PCM16 samples of a WAV file and its sample rate. */
async function readWav(file: string): Promise<{ rate: number; samples: Int16Array }> {
  const buffer = await readFile(file);
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(offset + 10);
      rate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22);
    } else if (id === "data") {
      if (channels !== 1 || bits !== 16) throw new Error(`${file}: expected mono 16-bit PCM, got ${channels} ch ${bits} bit`);
      const length = Math.min(size, buffer.length - offset - 8);
      const samples = new Int16Array(Math.floor(length / 2));
      for (let index = 0; index < samples.length; index++) samples[index] = buffer.readInt16LE(offset + 8 + index * 2);
      return { rate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/** The level track of the conform step: RMS of every 20 ms in dBFS (rounded, -100 floor, partial last window included). */
function levelsOf(rate: number, samples: Int16Array): Int8Array {
  const window = Math.round((rate * LEVEL_FRAME_MS) / 1000);
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += window) {
    const end = Math.min(samples.length, start + window);
    let squares = 0;
    for (let index = start; index < end; index++) squares += (samples[index] as number) ** 2;
    levels.push(Math.max(LEVEL_FLOOR_DB, Math.min(0, Math.round(10 * Math.log10(squares / (end - start) / 32768 ** 2 + 1e-12)))));
  }
  return Int8Array.from(levels);
}

async function trackLevels(file: string): Promise<{ levels: Int8Array; durationMs: number }> {
  const wav = await readWav(file);
  return { levels: levelsOf(wav.rate, wav.samples), durationMs: (wav.samples.length / wav.rate) * 1000 };
}

interface Span {
  s: number;
  e: number;
}
type Truth = Record<string, Span[]>;

interface Variant {
  params?: Partial<SceneParams>;
  /** Voice activity options; the default is the product's (cross-track dominance on). */
  vad?: VadOptions;
}

const VARIANTS: Record<string, Variant> = {
  defaults: {},
  wide: { params: { fallback: "wide" } },
  calm: { params: { rhythm: "calm" } },
  lively: { params: { rhythm: "lively" } },
  thumbs: { params: { layout: "speaker-thumbs" } },
  // what the bleed would do without the dominance test of the voice activity detector (the hysteresis still protects)
  noDominance: { vad: { ...DEFAULT_VAD, dominanceDb: null } },
  // neither the dominance test nor the hysteresis: the loudest-first-come rule alone
  noDominanceNoHysteresis: { params: { hysteresisDb: 0 }, vad: { ...DEFAULT_VAD, dominanceDb: null } },
};

interface Share {
  /** Share of ground-truth speech time during which the featured (first) source of the scene is a speaker of that moment. */
  correctShare: number;
  /** Share of ground-truth speech time spent in "wide" scenes (all cameras, nobody featured): not counted as correct. */
  wideShare: number;
  /** Frames of ground-truth speech where the wrong source was featured although the true speaker's own microphone had speech (a decision error)... */
  missVoicedFrames: number;
  /** ...and where it had none (the truth span covers a pause or padding: nothing in the levels says who speaks). */
  missUnvoicedFrames: number;
}

interface Measure {
  scenes: number;
  switches: number;
  minSceneMs: number;
  effectiveMinDwellMs: number;
  scenesBelowDwell: number;
  shares: Record<string, Share>;
  /** Share of the whole recording during which the silent third camera, if any, is featured. */
  silentFeaturedShare?: number;
}

const WIDE_LAYOUTS = ["grid", "side-by-side"];

function share(scenes: Scene[], durationMs: number, truth: Truth, params: SceneParams, voiced: Record<string, Uint8Array>): Share {
  const frames = Math.ceil(durationMs / LEVEL_FRAME_MS);
  let speech = 0;
  let correct = 0;
  let wide = 0;
  let missVoiced = 0;
  let missUnvoiced = 0;
  const cursor = Object.fromEntries(Object.keys(truth).map((speaker) => [speaker, 0]));
  for (let frame = 0; frame < frames; frame++) {
    const ms = frame * LEVEL_FRAME_MS + LEVEL_FRAME_MS / 2;
    const scene = sceneAt(scenes, ms) as Scene;
    const speaking = Object.entries(truth)
      .filter(([speaker, spans]) => {
        let at = cursor[speaker] as number;
        while (at < spans.length && (spans[at] as Span).e < ms) at++;
        cursor[speaker] = at;
        const span = spans[at];
        return span !== undefined && span.s <= ms && ms < span.e;
      })
      .map(([speaker]) => speaker);
    if (speaking.length === 0) continue;
    speech++;
    // a wide scene shows everybody but features nobody (the bench's layout is solo or speaker-thumbs, so a grid or side-by-side scene is a wide one)
    if (params.fallback === "wide" && WIDE_LAYOUTS.includes(scene.layout)) wide++;
    else if (speaking.includes(scene.sources[0] as string)) correct++;
    else if (speaking.some((speaker) => voiced[speaker]?.[frame] === 1)) missVoiced++;
    else missUnvoiced++;
  }
  return { correctShare: Number((correct / speech).toFixed(4)), wideShare: Number((wide / speech).toFixed(4)), missVoicedFrames: missVoiced, missUnvoicedFrames: missUnvoiced };
}

function measure(scenes: Scene[], durationMs: number, truths: Record<string, Truth>, params: SceneParams, tracks: ActivityTrack[], silentId?: string): Measure {
  const levels = tracks.map((track) => track.levels);
  const voiced = Object.fromEntries(tracks.map((track, index) => [track.id, speechFrames(track.levels, undefined, levels.filter((_, other) => other !== index))]));
  const dwell = effectiveMinDwellMs(params);
  const lengths = scenes.map((scene) => scene.e - scene.s);
  let silentFeatured = 0;
  const frames = Math.ceil(durationMs / LEVEL_FRAME_MS);
  if (silentId !== undefined) {
    for (let frame = 0; frame < frames; frame++) {
      const scene = sceneAt(scenes, frame * LEVEL_FRAME_MS + LEVEL_FRAME_MS / 2) as Scene;
      if (scene.sources[0] === silentId && !WIDE_LAYOUTS.includes(scene.layout)) silentFeatured++;
    }
  }
  return {
    scenes: scenes.length,
    switches: Math.max(0, scenes.length - 1),
    minSceneMs: Math.min(...lengths),
    effectiveMinDwellMs: dwell,
    scenesBelowDwell: lengths.filter((length) => length < dwell).length,
    shares: Object.fromEntries(Object.entries(truths).map(([name, truth]) => [name, share(scenes, durationMs, truth, params, voiced)])),
    ...(silentId === undefined ? {} : { silentFeaturedShare: Number((silentFeatured / frames).toFixed(4)) }),
  };
}

async function runCase(name: string, files: Record<string, string>, truths: Record<string, Truth>, extra?: { silent?: string }): Promise<Record<string, unknown>> {
  const loaded: Record<string, { levels: Int8Array; durationMs: number }> = {};
  for (const [id, file] of Object.entries(files)) loaded[id] = await trackLevels(file);
  const durationMs = Math.max(...Object.values(loaded).map((track) => track.durationMs));
  return runTracks(name, Object.entries(loaded).map(([id, track]) => ({ id, levels: track.levels })), durationMs, truths, extra?.silent);
}

function runTracks(name: string, tracks: ActivityTrack[], durationMs: number, truths: Record<string, Truth>, silentId?: string): Record<string, unknown> {
  const truthSeconds = Object.fromEntries(Object.entries(truths).map(([truthName, truth]) => [truthName, Number((Object.values(truth).flatMap((spans) => spans).reduce((sum, span) => sum + (span.e - span.s), 0) / 1000).toFixed(1))]));
  const variants: Record<string, Measure> = {};
  for (const [variant, { params: patch, vad }] of Object.entries(VARIANTS)) {
    const params: SceneParams = { ...DEFAULT_SCENE_PARAMS, ...patch };
    const started = performance.now();
    const scenes = planScenes(tracks, durationMs, params, vad);
    const planMs = performance.now() - started;
    const again = planScenes(tracks, durationMs, params, vad);
    if (JSON.stringify(again) !== JSON.stringify(scenes)) throw new Error(`${name}/${variant}: planScenes is not deterministic`);
    if (scenes[0]?.s !== 0 || scenes[scenes.length - 1]?.e !== durationMs || scenes.some((scene, index) => index > 0 && scene.s !== (scenes[index - 1] as Scene).e)) throw new Error(`${name}/${variant}: scenes do not tile the timeline`);
    variants[variant] = { ...measure(scenes, durationMs, truths, params, tracks, silentId), planMs: Number(planMs.toFixed(1)) } as Measure;
  }
  return { case: name, tracks: tracks.map((track) => track.id), durationSec: Number((durationMs / 1000).toFixed(1)), truthSpeechSec: truthSeconds, variants };
}

// ---- real pipeline: conform level tracks against transcript word times ----------------------------------------------------

async function productCase(lang: string, variant: "clean" | "bleed"): Promise<Record<string, unknown> | null> {
  const dir = path.join(productRoot, `bench-asr3-${lang}`, "post", `bench-${variant}-${lang}-0001`);
  const project = await readFile(path.join(dir, "project.json"), "utf8").then((text) => JSON.parse(text) as { durationMs: number; sources: { id: string; participantId: string; audio: { levels: string } | null }[] }, () => null);
  const transcript = await readFile(path.join(dir, "transcript.json"), "utf8").then((text) => JSON.parse(text) as { words: { s: number; e: number; pid: string }[] }, () => null);
  if (!project || !transcript) return null;
  const tracks: ActivityTrack[] = [];
  for (const source of project.sources) {
    if (!source.audio) continue;
    const buffer = await readFile(path.join(dir, source.audio.levels));
    tracks.push({ id: source.participantId, levels: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) });
  }
  const words: Truth = {};
  for (const word of [...transcript.words].sort((a, b) => a.s - b.s)) {
    const spans = (words[word.pid] ??= []);
    const last = spans[spans.length - 1];
    if (last && word.s - last.e <= 400) last.e = Math.max(last.e, word.e);
    else spans.push({ s: word.s, e: word.e });
  }
  return runTracks(`product-${lang}-${variant}`, tracks, project.durationMs, { words }, tracks.find((track) => track.id.includes("silent"))?.id);
}

// ---- property test over random activity ----------------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Random conversation: turns of random length and speaker, with overlaps, interjections, bleed and a noisy floor. */
function randomTracks(seed: number, speakers: number, durationMs: number): ActivityTrack[] {
  const next = random(seed);
  const frames = Math.ceil(durationMs / LEVEL_FRAME_MS);
  const levels = Array.from({ length: speakers }, () => new Int8Array(frames).fill(-70));
  let frame = 0;
  while (frame < frames) {
    const speaker = Math.floor(next() * speakers);
    const length = Math.max(2, Math.floor((next() < 0.3 ? 0.2 + next() * 1.2 : 1 + next() * 9) * 50));
    const loud = -32 + Math.floor(next() * 14);
    for (let at = frame; at < Math.min(frames, frame + length); at++) {
      (levels[speaker] as Int8Array)[at] = loud - Math.floor(next() * 8);
      // the others hear it at -22 dB
      for (let other = 0; other < speakers; other++) if (other !== speaker) (levels[other] as Int8Array)[at] = Math.max((levels[other] as Int8Array)[at] as number, loud - 22 - Math.floor(next() * 4));
    }
    frame += length - (next() < 0.25 ? Math.floor(next() * 40) : 0) + (next() < 0.5 ? Math.floor(next() * 120) : 0);
  }
  return levels.map((track, index) => ({ id: `cam${index}`, levels: track }));
}

function propertyTest(): Record<string, unknown> {
  let runs = 0;
  let scenesTotal = 0;
  let belowDwell = 0;
  let notTiling = 0;
  let nondeterministic = 0;
  let worst = Infinity;
  const rhythms = Object.keys(RHYTHMS) as Rhythm[];
  for (let seed = 1; seed <= 120; seed++) {
    const speakers = 2 + (seed % 3);
    const durationMs = 30_000 + Math.floor(random(seed * 7)() * 240_000) + (seed % 7) * 13;
    const tracks = randomTracks(seed, speakers, durationMs);
    for (const rhythm of rhythms) {
      for (const fallback of ["keep", "wide"] as const) {
        for (const layout of ["solo", "speaker-thumbs"] as const) {
          const params: SceneParams = { ...DEFAULT_SCENE_PARAMS, rhythm, fallback, layout };
          const scenes = planScenes(tracks, durationMs, params);
          runs++;
          scenesTotal += scenes.length;
          const dwell = effectiveMinDwellMs(params);
          for (const scene of scenes) {
            worst = Math.min(worst, scene.e - scene.s);
            if (scene.e - scene.s < dwell) belowDwell++;
          }
          if (scenes[0]?.s !== 0 || scenes[scenes.length - 1]?.e !== durationMs || scenes.some((scene, index) => index > 0 && scene.s !== (scenes[index - 1] as Scene).e)) notTiling++;
          if (JSON.stringify(planScenes(tracks, durationMs, params)) !== JSON.stringify(scenes)) nondeterministic++;
        }
      }
    }
  }
  return { runs, scenesTotal, scenesBelowDwell: belowDwell, notTiling, nondeterministic, shortestSceneMs: worst };
}

// ---- run ------------------------------------------------------------------------------------------------------------------

const results: Record<string, unknown>[] = [];
for (const lang of ["en", "pl"]) {
  const silence = path.join(asr, `fix-silence-${lang}`);
  const truthFile = JSON.parse(await readFile(path.join(silence, "truth.json"), "utf8")) as { speech: Record<string, { s: number; e: number }[]> };
  const ttsTruth: Truth = Object.fromEntries(Object.entries(truthFile.speech).map(([speaker, spans]) => [speaker, spans.map((span) => ({ s: span.s * 1000, e: span.e * 1000 }))]));
  results.push(await runCase(`tts-${lang}-bleed-24dB`, { A: path.join(silence, "track_A.wav"), B: path.join(silence, "track_B.wav") }, { exact: ttsTruth }));

  const fleurs = path.join(asr, `fix-${lang}`);
  const conversation = JSON.parse(await readFile(path.join(fleurs, "conversation.json"), "utf8")) as { utterances: { speaker: string; start: number; end: number }[] };
  const slots: Truth = {};
  for (const utterance of conversation.utterances) (slots[utterance.speaker] ??= []).push({ s: utterance.start * 1000, e: utterance.end * 1000 });
  for (const spans of Object.values(slots)) spans.sort((a, b) => a.s - b.s);
  // the voiced part of every slot, on the clean track of its speaker
  const clean: Record<string, Int8Array> = {};
  for (const speaker of Object.keys(slots)) clean[speaker] = (await trackLevels(path.join(fleurs, `track_${speaker}.wav`))).levels;
  const tight: Truth = {};
  for (const [speaker, spans] of Object.entries(slots)) {
    const flags = speechFrames(clean[speaker] as Int8Array, undefined, Object.entries(clean).filter(([other]) => other !== speaker).map(([, levels]) => levels));
    tight[speaker] = spans.flatMap((span) => {
      const from = Math.floor(span.s / LEVEL_FRAME_MS);
      const to = Math.min(flags.length, Math.ceil(span.e / LEVEL_FRAME_MS));
      let first = -1;
      let last = -1;
      for (let frame = from; frame < to; frame++) {
        if (flags[frame] !== 1) continue;
        if (first < 0) first = frame;
        last = frame;
      }
      return first < 0 ? [] : [{ s: first * LEVEL_FRAME_MS, e: (last + 1) * LEVEL_FRAME_MS }];
    });
  }
  const truths = { tight, slot: slots };
  results.push(await runCase(`fleurs-${lang}-clean`, { A: path.join(fleurs, "track_A.wav"), B: path.join(fleurs, "track_B.wav") }, truths));
  results.push(await runCase(`fleurs-${lang}-bleed-22dB`, { A: path.join(fleurs, "bleed_A.wav"), B: path.join(fleurs, "bleed_B.wav") }, truths));
  results.push(await runCase(`fleurs-${lang}-bleed-22dB-silent-third`, { A: path.join(fleurs, "bleed_A.wav"), B: path.join(fleurs, "bleed_B.wav"), C: path.join(fleurs, "silent.wav") }, truths, { silent: "C" }));
}

for (const lang of ["en", "pl"]) {
  for (const variant of ["clean", "bleed"] as const) {
    const result = await productCase(lang, variant);
    if (result) results.push(result);
  }
}

const output = { asr, gates: { minDwell: "scenesBelowDwell == 0 for every variant", correctSpeaker: "shares.exact|tight|words correctShare >= 0.95 for the defaults variant; shares.slot is reported for reference" }, cases: results, propertyTest: propertyTest() };
const text = JSON.stringify(output, null, 1);
if (outFile) await writeFile(outFile, text);
console.log(text);
