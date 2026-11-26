// Runs the product's transcript job on the spike fixtures and writes what the gates need. Usage:
//   ASR_PYTHON=<python with faster-whisper> tsx scripts/bench-transcribe.ts --asr <spike work dir> --lang en|pl --dir <work dir>
// Sessions: "clean" (track_A, track_B, a silent track) and "bleed" (bleed_A, bleed_B). Output: <dir>/result-<lang>.json
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { PostProduction } from "../src/server/post/index.js";
import { createStorage } from "../src/server/storage/index.js";
import { duplicateRate, type TranscriptFile } from "../src/shared/transcript.js";
import { makeSyntheticSession } from "../tests/support/synthetic.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const asr = path.resolve(arg("asr", "."));
const lang = arg("lang", "en");
const dir = path.resolve(arg("dir", "./bench-asr"));
const fixture = path.join(asr, `fix-${lang}`);

process.env.TOKEN_SIGNING_SECRET = "bench-secret-0123456789";
process.env.STORAGE_LOCAL_DIR = dir;
process.env.POST_MIN_FREE_GB = "0";
const config = loadConfig();
const post = new PostProduction(config, createStorage(config));
await post.ready;

const durationOf = (file: string): number => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
const rssOf = (pid: number): number => {
  try {
    return Number(/VmHWM:\s+(\d+)/.exec(execFileSync("cat", [`/proc/${pid}/status`]).toString())?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
};

const result: Record<string, unknown> = { lang };
for (const [name, files] of [
  ["clean", ["track_A.wav", "track_B.wav", "silent.wav"]],
  ["bleed", ["bleed_A.wav", "bleed_B.wav"]],
] as const) {
  const sid = `bench-${name}-${lang}-0001`;
  const longest = Math.max(...files.map((file) => durationOf(path.join(fixture, file))));
  await makeSyntheticSession({
    sessionId: sid,
    storageDir: dir,
    durationSec: longest,
    participants: files.map((file, index) => ({ name: ["Anna", "Bartek", "Silent"][index] ?? "X", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: path.join(fixture, file) })),
    eventsMs: [],
  });
  await post.store.create(sid);
  const conformStart = Date.now();
  await post.jobs.enqueue(sid, "conform");
  await post.idle();
  const conformSec = (Date.now() - conformStart) / 1000;
  const started = Date.now();
  const job = await post.jobs.enqueue(sid, "transcribe", { lang });
  let peakChildMb = 0;
  while (true) {
    const current = post.jobs.get(sid, job.id);
    if (!current || ["done", "failed", "canceled"].includes(current.status)) break;
    if (current.pid) peakChildMb = Math.max(peakChildMb, rssOf(current.pid));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const wallSec = (Date.now() - started) / 1000;
  const finished = post.jobs.get(sid, job.id);
  const transcript = JSON.parse(await readFile(path.join(dir, "post", sid, "transcript.json"), "utf8").catch(() => "null")) as TranscriptFile | null;
  const perSpeaker: Record<string, string> = {};
  for (const speaker of transcript?.speakers ?? []) perSpeaker[speaker.name] = transcript?.words.filter((word) => word.pid === speaker.pid).map((word) => word.t).join(" ") ?? "";
  result[name] = {
    status: finished?.status,
    error: finished?.error,
    conformSec,
    wallSec,
    peakChildMb: Math.round(peakChildMb),
    words: transcript?.words.length,
    bleedDropped: transcript?.bleedDropped,
    duplicateRate: transcript ? duplicateRate(transcript.words) : null,
    stats: transcript?.stats,
    perSpeaker,
    wordsPerSource: Object.fromEntries((transcript?.speakers ?? []).map((speaker) => [speaker.name, transcript?.words.filter((word) => word.pid === speaker.pid).length])),
  };
}
await writeFile(path.join(dir, `result-${lang}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, (key, value) => (key === "perSpeaker" ? undefined : value), 1));
await post.close();
