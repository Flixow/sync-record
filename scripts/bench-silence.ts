// Gate measurements of silence trimming and cut joins on the TTS fixture with exactly known speech spans. Usage:
//   tsx scripts/bench-silence.ts --asr <spike work dir> --lang en|pl --dir <work dir>
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { saveEdl } from "../src/server/post/edl-store.js";
import { PostProduction } from "../src/server/post/index.js";
import { audioCutGraph } from "../src/server/post/render-audio.js";
import { createStorage } from "../src/server/storage/index.js";
import { keepOnly, keptDuration, keptRanges, normalize, toOutput, type Range } from "../src/shared/edl.js";
import type { ProjectFile } from "../src/shared/project.js";
import { DEFAULT_SILENCE, detectSilences } from "../src/shared/silence.js";
import { makeSyntheticSession } from "../tests/support/synthetic.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const lang = arg("lang", "en");
const fixture = path.join(path.resolve(arg("asr", ".")), `fix-silence-${lang}`);
const dir = path.resolve(arg("dir", "./bench-silence"));
process.env.TOKEN_SIGNING_SECRET = "bench-secret-0123456789";
process.env.STORAGE_LOCAL_DIR = dir;
process.env.POST_MIN_FREE_GB = "0";
const config = loadConfig();
const post = new PostProduction(config, createStorage(config));
await post.ready;

const truth = JSON.parse(await readFile(path.join(fixture, "truth.json"), "utf8")) as { duration: number; speech: Record<string, { s: number; e: number }[]> };
const sid = `bench-silence-${lang}-0001`;
await makeSyntheticSession({
  sessionId: sid,
  storageDir: dir,
  durationSec: truth.duration,
  eventsMs: [],
  participants: ["A", "B"].map((speaker, index) => ({ name: speaker === "A" ? "Anna" : "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: path.join(fixture, `track_${speaker}.wav`), index })),
});
await post.store.create(sid);
await post.jobs.enqueue(sid, "conform");
await post.idle();
const projectDir = post.store.dir(sid);
const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8")) as ProjectFile;
const duration = project.durationMs;

// ---- silence trimming against the known spans ----
const levels = await Promise.all(project.sources.filter((s) => s.audio).map(async (s) => {
  const buffer = await readFile(path.join(projectDir, s.audio?.levels ?? ""));
  return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}));
const silences = detectSilences(levels, duration, DEFAULT_SILENCE);
const speech = normalize(Object.values(truth.speech).flat().map((span) => ({ s: span.s * 1000, e: span.e * 1000 })), duration);
const annotated: Range[] = [];
let cursor = 0;
for (const span of speech) {
  if (span.s - cursor >= 700) annotated.push({ s: cursor, e: span.s });
  cursor = span.e;
}
if (duration - cursor >= 700) annotated.push({ s: cursor, e: duration });
const cuts = silences.map((silence) => silence.cut);
const overlap = (a: Range, b: Range): number => Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
const removed = annotated.filter((silence) => {
  const cut = cuts.reduce((sum, range) => sum + overlap(range, silence), 0);
  return silence.e - silence.s - cut <= DEFAULT_SILENCE.keepMs + 150;
});
const cutsInSpeech = cuts.filter((cut) => speech.some((span) => overlap(cut, span) > 0));
const result: Record<string, unknown> = {
  lang,
  durationSec: duration / 1000,
  annotatedSilences: annotated.length,
  removedSilences: removed.length,
  removedShare: Number((removed.length / annotated.length).toFixed(3)),
  cutsTotal: cuts.length,
  cutsInsideSpeech: cutsInSpeech.length,
  removedSec: Number((cuts.reduce((sum, cut) => sum + cut.e - cut.s, 0) / 1000).toFixed(1)),
};

// ---- render and measure: silence cuts, and cuts through the middle of speech (the click case) ----
const mix = path.join(projectDir, project.mixProxy ?? "");
const decode = (file: string): Int16Array => {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1024 ** 3 });
  const buffer = out.stdout;
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
};
const probe = (file: string): number => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim()) * 1000;

async function scenario(name: string, removedRanges: Range[]): Promise<void> {
  const edl = { removed: normalize(removedRanges, duration) };
  const current = JSON.parse(await readFile(path.join(projectDir, "edl.json"), "utf8").catch(() => '{"rev":0}')) as { rev: number };
  await saveEdl(projectDir, current.rev, edl.removed);
  const job = await post.jobs.enqueue(sid, "cut-preview", { scenario: name });
  await post.idle();
  const finished = post.jobs.get(sid, job.id);
  const file = path.join(projectDir, "proxies", "mix-cut.m4a");
  const expectedMs = keptDuration(edl, duration);
  const actualMs = probe(file);
  const joins = edl.removed.map((range) => toOutput(edl, range.s)).filter((ms) => ms > 0 && ms < expectedMs);
  const jumpsAt = (samples: Int16Array): number[] => joins.map((ms) => {
    const center = Math.round((ms / 1000) * 48000);
    let max = 0;
    // the step across the join itself (the two samples either side), not the signal's own slope nearby
    for (let i = Math.max(1, center - 2); i < Math.min(samples.length, center + 3); i++) max = Math.max(max, Math.abs((samples[i] as number) - (samples[i - 1] as number)));
    return max;
  });
  // The join check runs on lossless renders of the same filter graph (AAC would smear the step), with and without the fades.
  const render = (fadeMs: number): Int16Array => {
    const graph = path.join(dir, `graph-${name}-${fadeMs}.txt`);
    writeFileSync(graph, audioCutGraph(keptRanges(edl, duration), duration, fadeMs));
    const wav = path.join(dir, `join-${name}-${fadeMs}.wav`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mix, "-filter_complex_script", graph, "-map", "[out]", "-ac", "1", "-ar", "48000", wav]);
    return decode(wav);
  };
  const faded = render(5);
  const hard = render(0);
  let natural = 0;
  for (let i = 1; i < faded.length; i++) natural = Math.max(natural, Math.abs((faded[i] as number) - (faded[i - 1] as number)));
  const fadedJumps = jumpsAt(faded);
  const hardJumps = jumpsAt(hard);
  result[name] = {
    status: finished?.status,
    error: finished?.error,
    joins: joins.length,
    expectedMs,
    actualMs: Number(actualMs.toFixed(1)),
    durationDiffMs: Number((actualMs - expectedMs).toFixed(1)),
    maxStepAtJoinsWithFade: Math.max(0, ...fadedJumps),
    maxStepAtJoinsHardCut: Math.max(0, ...hardJumps),
    maxStepAnywhereInSignal: natural,
    joinsWithStepOver16: fadedJumps.filter((jump) => jump > 16).length,
  };
}

await scenario("silenceCuts", cuts);
// 20 cuts through the middle of speech: 300 ms taken out of utterances at random places
const flat = Object.values(truth.speech).flat().filter((span) => span.e - span.s > 2);
const mid: Range[] = flat.slice(0, 20).map((span) => ({ s: ((span.s + span.e) / 2) * 1000, e: ((span.s + span.e) / 2) * 1000 + 300 }));
await scenario("speechCuts", mid);
void keepOnly;
await writeFile(path.join(dir, `result-${lang}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await post.close();
