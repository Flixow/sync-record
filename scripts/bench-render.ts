// Gate measurements of the export render (S3) on a 10-minute 1080p fixture with the media frame number in the picture.
//   tsx scripts/bench-render.ts --asr <spike work dir> --dir <work dir> [--presets a,b] [--spike]
// --spike also times the alternative render strategy (one encode per kept segment, joined by stream copy).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { saveEdl } from "../src/server/post/edl-store.js";
import { PostProduction } from "../src/server/post/index.js";
import { layoutVideoGraph } from "../src/server/post/render-layout.js";
import { snapRanges, videoEncodeArgs } from "../src/server/post/render.js";
import { createStorage } from "../src/server/storage/index.js";
import { keptRanges, toOutput, type Range } from "../src/shared/edl.js";
import { gopFrames, presetById, type VideoPreset } from "../src/shared/presets.js";
import type { ProjectFile } from "../src/shared/project.js";
import { audioOnsets, barcodeFrames, barcodeJumps, inspectMp4, probeJson, videoFlashOnsets } from "../tests/support/measure.js";
import { makeSyntheticSession } from "../tests/support/synthetic.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const dir = path.resolve(arg("dir", "./bench-render"));
const audioFile = path.join(path.resolve(arg("asr", ".")), "fix-en", "track_A.wav");
const presets = arg("presets", "youtube-1080p30,youtube-1080p60,youtube-2160p30,audio-mp3").split(",");
process.env.TOKEN_SIGNING_SECRET = "bench-secret-0123456789";
process.env.STORAGE_LOCAL_DIR = dir;
process.env.POST_MIN_FREE_GB = "0";
process.env.POST_RETENTION = "keep-all";
const config = loadConfig();
const post = new PostProduction(config, createStorage(config));
await post.ready;
const result: Record<string, unknown> = { fixture: "10 min, 1920x1080 30 fps VP9 + speech audio, 20 cuts" };
const frameMs30 = 1000 / 30;

// 20 cuts of 0.5..3 s spread over the recording, none over the sync events
const duration = 608;
const CUTS: Range[] = Array.from({ length: 20 }, (_, i) => ({ s: 15_000 + i * 28_500 + (i % 3) * 700, e: 15_000 + i * 28_500 + (i % 3) * 700 + 500 + (i % 6) * 500 }));
const EVENTS = [3000, 300_000, 600_000];

async function prepare(sid: string, picture: "barcode" | "flash", size: string): Promise<string> {
  const t0 = Date.now();
  await makeSyntheticSession({ sessionId: sid, storageDir: dir, durationSec: duration, eventsMs: EVENTS, cameraSize: size, cameraFps: 30, cameraPicture: picture, participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, ...(picture === "barcode" ? { audioFile } : {}) }] });
  result[`${sid}-fixtureSec`] = (Date.now() - t0) / 1000;
  await post.store.create(sid);
  const c0 = Date.now();
  await post.jobs.enqueue(sid, "conform");
  await post.idle();
  result[`${sid}-conformSec`] = (Date.now() - c0) / 1000;
  const dirOf = post.store.dir(sid);
  await saveEdl(dirOf, 0, CUTS);
  return dirOf;
}

async function exportOf(sid: string, presetId: string): Promise<{ file: string; wallSec: number }> {
  const t0 = Date.now();
  await post.jobs.enqueue(sid, "render", { preset: presetId });
  await post.idle();
  const exports = JSON.parse(await readFile(path.join(post.store.dir(sid), "exports.json"), "utf8")) as { preset: string; file: string }[];
  const record = exports.find((item) => item.preset === presetId);
  if (!record) throw new Error(`render of ${presetId} failed: ${JSON.stringify(post.jobs.list(sid).slice(-1))}`);
  return { file: path.join(post.store.dir(sid), record.file), wallSec: (Date.now() - t0) / 1000 };
}

const lufsOf = (file: string): { lufs: number | null; tp: number | null } => {
  const out = spawnSync("ffmpeg", ["-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const summary = out.slice(out.lastIndexOf("Summary:"));
  return { lufs: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? "NaN"), tp: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? "NaN") };
};

const sid = "bench-render-0001";
const dirOf = await prepare(sid, "barcode", "1920x1080");
const project = JSON.parse(await readFile(path.join(dirOf, "project.json"), "utf8")) as ProjectFile;
const kept = keptRanges({ removed: CUTS }, project.durationMs);
const expectedMs = kept.reduce((sum, range) => sum + range.e - range.s, 0);

for (const id of presets) {
  const preset = presetById(id);
  if (!preset) continue;
  const { file, wallSec } = await exportOf(sid, id);
  const entry: Record<string, unknown> = { wallSec, programSec: expectedMs / 1000, speedX: Number((expectedMs / 1000 / wallSec).toFixed(2)) };
  const probe = (await probeJson(file, ["-show_streams", "-show_format"])) as { streams: Record<string, string | number>[]; format: Record<string, string> };
  entry.durationDiffMs = Number((Number(probe.format.duration) * 1000 - expectedMs).toFixed(1));
  entry.bytes = Number(probe.format.size);
  entry.loudness = lufsOf(file);
  if (preset.kind === "video") {
    const v = probe.streams.find((s) => s.codec_type === "video") as Record<string, string | number>;
    const a = probe.streams.find((s) => s.codec_type === "audio") as Record<string, string | number>;
    const layout = await inspectMp4(file);
    const frames = (await probeJson(file, ["-select_streams", "v", "-show_entries", "frame=key_frame"])) as { frames: { key_frame: number }[] };
    const keys = frames.frames.map((f, i) => (f.key_frame ? i : -1)).filter((i) => i >= 0);
    const gaps = keys.slice(1).map((k, i) => k - (keys[i] as number));
    const bitrate = Number(v.bit_rate);
    entry.g4 = {
      container: probe.format.format_name,
      moovFirst: layout.moovBeforeMdat,
      editList: layout.hasEditList,
      codec: v.codec_name, profile: v.profile, pixFmt: v.pix_fmt, size: `${v.width}x${v.height}`, fps: v.r_frame_rate,
      bFrames: v.has_b_frames, maxKeyframeGap: Math.max(...gaps), gopLimit: gopFrames((preset as VideoPreset).fps),
      audio: `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch`,
      videoBitrateMbps: Number((bitrate / 1e6).toFixed(2)), bitrateRangeMbps: [(preset as VideoPreset).minVideoBitrate / 1e6, (preset as VideoPreset).maxVideoBitrate / 1e6],
    };
    if (id === "youtube-1080p30") {
      // gate (c): the barcode runs on consecutively except across the 20 joins, where it jumps by exactly the removed frames
      const codes = await barcodeFrames(file, 1);
      const jumps = barcodeJumps(codes).map((jump) => jump.skipped);
      const wanted = CUTS.map((cut) => Math.round((cut.e - cut.s) / frameMs30));
      entry.joins = { found: jumps.length, expected: wanted.length, allFramesExact: jumps.length === wanted.length && jumps.every((jump, i) => Math.abs(jump - (wanted[i] as number)) <= 1), jumps, frames: codes.length };
      // audio step at the joins of the decoded export
      const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 30 }).stdout;
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const edl = { removed: CUTS };
      const steps = CUTS.map((cut) => {
        const centre = Math.round((toOutput(edl, cut.s) / 1000) * 48000);
        let max = 0;
        for (let i = centre - 3; i < centre + 4; i++) max = Math.max(max, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
        return max;
      });
      entry.audioStepAtJoins = { max: Math.max(...steps), fullScale: 32768 };
    }
  }
  result[id] = entry;
  console.log(id, JSON.stringify(entry));
}

if (process.argv.includes("--full")) {
// gate (b): A/V sync at the start, middle and end of a 10-minute export with the same 20 cuts (flash + tone events)
const sidSync = "bench-render-0002";
await prepare(sidSync, "flash", "1280x720");
const sync = await exportOf(sidSync, "youtube-1080p30");
const flashes = await videoFlashOnsets(sync.file, 30);
const tones = await audioOnsets(sync.file);
const shift = (at: number): number => at - CUTS.filter((cut) => cut.e <= at).reduce((sum, cut) => sum + cut.e - cut.s, 0);
result.sync = EVENTS.map((at, i) => ({ eventMs: at, expectedMs: shift(at), flashMs: flashes[i], toneMs: tones[i], av: tones[i] !== undefined && flashes[i] !== undefined ? Number(((tones[i] as number) - (flashes[i] as number)).toFixed(1)) : null }));
console.log("sync", JSON.stringify(result.sync));

// cancel: a render canceled midway leaves no ffmpeg behind
const job = await post.jobs.enqueue(sid, "render", { preset: "youtube-1080p30", x264Preset: "veryslow" });
await new Promise((resolve) => setTimeout(resolve, 20_000));
await post.jobs.cancel(sid, job.id);
await post.idle();
const leftovers = spawnSync("pgrep", ["-f", `SYNCRECORD_JOB=${job.id}`], { encoding: "utf8" }).stdout.trim();
const orphan = spawnSync("bash", ["-c", `for p in $(pgrep ffmpeg); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q "SYNCRECORD_JOB=${job.id}" && echo $p; done`], { encoding: "utf8" }).stdout.trim();
result.cancel = { status: post.jobs.get(sid, job.id)?.status, orphanFfmpeg: orphan === "" && leftovers === "" ? 0 : orphan.split("\n").length };
console.log("cancel", JSON.stringify(result.cancel));

if (process.argv.includes("--full") && process.argv.includes("--spike")) {
  // alternative strategy: one encode per kept segment (input seek), segments joined by stream copy
  const preset = presetById("youtube-1080p30") as VideoPreset;
  const source = project.sources.find((s) => s.hasVideo);
  if (!source) throw new Error("no video");
  const input = await post.store.localSource(sid, source.sourceKey, source.id);
  const frames = snapRanges(kept, 30);
  const soloGraph = (ranges: Range[], total: number) => {
    const length = ranges.reduce((sum, range) => sum + range.e - range.s, 0);
    return layoutVideoGraph({ inputs: [{ source, input: 0 }], canvas: { width: preset.width, height: preset.height }, fps: 30, scenes: [{ s: 0, e: length, layout: "solo", sources: [source.id] }], kept: ranges, totalMs: total, background: { kind: "color", color: "#000000" } });
  };
  const work = path.join(dir, "spike");
  mkdirSync(work, { recursive: true });
  const t0 = Date.now();
  const parts: string[] = [];
  frames.forEach((range, i) => {
    const part = path.join(work, `seg-${i}.mp4`);
    const g = soloGraph([{ s: 0, e: range.e - range.s }], range.e - range.s);
    writeFileSync(path.join(work, `g-${i}.txt`), g.graph);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", (range.s / 1000).toFixed(3), "-t", ((range.e - range.s) / 1000).toFixed(3), "-i", input, "-filter_complex_script", path.join(work, `g-${i}.txt`), "-map", g.label, ...videoEncodeArgs(preset, 4, "veryfast").slice(0, 34), "-an", "-f", "mp4", part]);
    parts.push(part);
  });
  writeFileSync(path.join(work, "list.txt"), parts.map((p) => `file '${p}'`).join("\n"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-c", "copy", "-movflags", "+faststart", path.join(work, "joined.mp4")]);
  const wall = (Date.now() - t0) / 1000;
  // the same video only, single graph, for a like-for-like time
  const g = soloGraph(frames, project.durationMs);
  writeFileSync(path.join(work, "single.txt"), g.graph);
  const t1 = Date.now();
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-filter_complex_script", path.join(work, "single.txt"), "-map", g.label, ...videoEncodeArgs(preset, 4, "veryfast").slice(0, 34), "-an", "-f", "mp4", path.join(work, "single.mp4")]);
  result.spike = { perSegmentWallSec: wall, segments: frames.length, singleGraphWallSec: (Date.now() - t1) / 1000 };
  console.log("spike", JSON.stringify(result.spike));
}
}
await writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 1));
await post.close();
