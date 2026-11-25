// Gate measurements of the conform step on a synthetic session. Usage:
//   tsx scripts/bench-conform.ts --minutes 60 --dir <work dir> [--camera 640x360] [--fps 30]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { PostProduction } from "../src/server/post/index.js";
import { createStorage } from "../src/server/storage/index.js";
import type { ProjectFile } from "../src/shared/project.js";
import { audioOnsets, matchEvents, probeDuration, videoFlashOnsets } from "../tests/support/measure.js";
import { makeSyntheticSession } from "../tests/support/synthetic.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const minutes = Number(arg("minutes", "60"));
const dir = path.resolve(arg("dir", "./bench-data"));
const sid = "bench-conform-0001";
const durationSec = minutes * 60;

process.env.TOKEN_SIGNING_SECRET = "bench-secret-0123456789";
process.env.STORAGE_LOCAL_DIR = dir;
process.env.POST_MIN_FREE_GB = "0";
const config = loadConfig();

const rssOf = (pid: number): number => {
  try {
    const status = execFileSync("cat", [`/proc/${pid}/status`]).toString();
    return Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
};

const t0 = Date.now();
const truth = await makeSyntheticSession({
  sessionId: sid,
  storageDir: dir,
  durationSec,
  cameraSize: arg("camera", "640x360"),
  cameraFps: Number(arg("fps", "30")),
  participants: [
    { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 8, camera: true },
    { name: "Bartek", startOffsetMs: 2350, audioPpm: 50, clientClockPpm: -15, camera: true },
    { name: "Celina", startOffsetMs: 61_700, audioPpm: -50, clientClockPpm: 4, camera: false },
  ],
});
const generateSec = (Date.now() - t0) / 1000;

const post = new PostProduction(config, createStorage(config));
await post.ready;
await post.store.create(sid);
const started = Date.now();
const job = await post.jobs.enqueue(sid, "conform");
let peakNodeMb = 0;
let peakChildMb = 0;
let peakTotalMb = 0;
while (true) {
  const current = post.jobs.get(sid, job.id);
  if (!current || current.status === "done" || current.status === "failed" || current.status === "canceled") break;
  const node = process.memoryUsage().rss / 1024 / 1024;
  const child = current.pid ? rssOf(current.pid) : 0;
  peakNodeMb = Math.max(peakNodeMb, node);
  peakChildMb = Math.max(peakChildMb, child);
  peakTotalMb = Math.max(peakTotalMb, node + child);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const wallSec = (Date.now() - started) / 1000;
const finished = post.jobs.get(sid, job.id);
const project = JSON.parse(await readFile(path.join(dir, "post", sid, "project.json"), "utf8")) as ProjectFile;
const du = Number(execFileSync("du", ["-sb", path.join(dir, "post", sid)]).toString().split("\t")[0]) / 1e6;
const frameMs = 1000 / project.fps;

const rows: unknown[] = [];
for (const source of project.sources) {
  const owner = truth.participants.find((participant) => participant.id === source.participantId);
  const start = (owner?.startOffsetMs ?? 0) + 1000;
  const expected = truth.eventsMs.filter((event) => event > start && event < durationSec * 1000 - 1500);
  const file = path.join(dir, "post", sid, source.audio?.file ?? source.video?.file ?? "");
  const detected = source.audio ? await audioOnsets(file) : await videoFlashOnsets(file, project.fps);
  const reference = source.audio ? expected : expected.map((event) => Math.ceil(event / frameMs) * frameMs);
  const { errorsMs, missing } = matchEvents(reference, detected);
  const first = errorsMs[0] ?? NaN;
  const middle = errorsMs[Math.floor(errorsMs.length / 2)] ?? NaN;
  const last = errorsMs[errorsMs.length - 1] ?? NaN;
  rows.push({
    track: `${source.participantName} ${source.kind}`,
    drift_ppm_measured: Number(source.driftPpm.toFixed(1)),
    drift_ppm_injected: owner?.audioPpm,
    events: errorsMs.length,
    missing,
    error_ms_start: Number(first.toFixed(1)),
    error_ms_middle: Number(middle.toFixed(1)),
    error_ms_end: Number(last.toFixed(1)),
    error_ms_max: Number(Math.max(...errorsMs.map(Math.abs)).toFixed(1)),
    duration_diff_ms: Number(((await probeDuration(file)) * 1000 - (source.audio ? project.durationMs : source.offsetMs + source.timelineDurationMs)).toFixed(1)),
  });
}
console.log(JSON.stringify({ minutes, generateSec, conformWallSec: wallSec, realtimeFactor: Number(((durationSec) / wallSec).toFixed(1)), status: finished?.status, error: finished?.error, peakNodeMb: Math.round(peakNodeMb), peakChildMb: Math.round(peakChildMb), peakTotalMb: Math.round(peakTotalMb), diskMb: Math.round(du), rows }, null, 1));
await post.close();
