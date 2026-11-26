// Gate: the live layout preview of the project page against the exported video. For every combination of layout, shape and
// background the program is exported through the real collector, then frames at the same instants are compared: the
// preview canvas as the browser draws it, the exported frame scaled to the same size, SSIM of the two. Every sampled
// frame must reach the threshold (default 0.98).
//
//   tsx scripts/bench-preview-ssim.ts [--dir <work dir>] [--asr <spike work dir>] [--seconds 60] [--frames 10] [--threshold 0.98]
//                                     [--only side-by-side-16x9,grid-9x16-blur,...] [--picture camera|testsrc2] [--cdp <url>]
//
// Needs `npm run build` first (the collector runs from dist) and a running Chrome to attach to: --cdp, or $CDP_URL, as
// provided by `deploy/executor-browser run -- sh -c 'tsx scripts/bench-preview-ssim.ts'`. Prints JSON and writes it to
// <dir>/ssim-result.json; the compared frames stay in <dir>/frames/<combination>/ (preview-NN.png, export-NN.png).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Page } from "@playwright/test";
import { issueToken } from "../src/server/tokens.js";
import type { Aspect, Background, LayoutId } from "../src/shared/layout.js";
import { DEFAULT_SCENE_PARAMS } from "../src/shared/scenes.js";
import { makeSyntheticSession } from "../tests/support/synthetic.js";

const run = promisify(execFile);
const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const dir = path.resolve(arg("dir", "./bench-preview-ssim"));
const asrDir = path.resolve(arg("asr", path.join(process.env.TMPDIR ?? ".", "asr")));
const seconds = Number(arg("seconds", "60"));
const frameCount = Number(arg("frames", "10"));
const threshold = Number(arg("threshold", "0.98"));
const only = arg("only", "");
/** "camera": a webcam-like picture (default); "testsrc2": the synthetic pattern of the test helper, with its one-pixel noise. */
const picture = arg("picture", "camera");
const cdpUrl = arg("cdp", process.env.CDP_URL ?? "");
if (!cdpUrl) throw new Error("no browser to attach to: pass --cdp <url> or run through deploy/executor-browser");

const SID = "ssim-bench-0001";
const HOST = "p1-ala";
const PORT = Number(arg("port", "18760"));
const SECRET = "bench-preview-ssim-secret-0123456789";
const base = `http://127.0.0.1:${PORT}`;
const FPS = 30;
const LONG_EDGE = 640;
const token = issueToken(SECRET, { sid: SID, role: "participant", pid: HOST, host: true, exp: Date.now() + 6 * 3_600_000 });

interface Combination {
  name: string;
  layout: LayoutId;
  aspect: Aspect;
  background: Background;
}
const COLOR: Background = { kind: "color", color: "#1b2a49" };
const BLUR: Background = { kind: "blur", sigma: 40 };
const ALL: Combination[] = [
  { name: "side-by-side-16x9", layout: "side-by-side", aspect: "16:9", background: COLOR },
  { name: "side-by-side-9x16", layout: "side-by-side", aspect: "9:16", background: COLOR },
  { name: "grid-16x9", layout: "grid", aspect: "16:9", background: COLOR },
  { name: "grid-9x16-blur", layout: "grid", aspect: "9:16", background: BLUR },
  { name: "speaker-thumbs-16x9-blur", layout: "speaker-thumbs", aspect: "16:9", background: BLUR },
  { name: "speaker-thumbs-9x16", layout: "speaker-thumbs", aspect: "9:16", background: COLOR },
  { name: "solo-16x9", layout: "solo", aspect: "16:9", background: COLOR },
  { name: "solo-9x16-blur", layout: "solo", aspect: "9:16", background: BLUR },
];
const COMBINATIONS = ALL.filter((combination) => only === "" || only.split(",").includes(combination.name));

const presetOf = (aspect: Aspect): string => (aspect === "9:16" ? "vertical-1080p30" : "youtube-1080p30");
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

async function ffmpeg(args: string[]): Promise<string> {
  const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stderr;
}

async function api<T>(method: string, suffix: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/sessions/${SID}/project${suffix}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${suffix}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface Job {
  id: string;
  kind: string;
  status: string;
  error?: string;
}
interface Exported {
  id: string;
  preset: string;
  file: string;
  createdAtMs: number;
}

interface Row {
  name: string;
  layout: LayoutId;
  aspect: Aspect;
  background: Background["kind"];
  scenes: number;
  renderSec: number;
  min: number;
  mean: number;
  pass: boolean;
  ssim: number[];
}

async function finish(job: Job): Promise<void> {
  for (;;) {
    const { jobs } = await api<{ jobs: Job[] }>("GET", "/jobs");
    const current = jobs.find((item) => item.id === job.id);
    if (current && current.status !== "queued" && current.status !== "running") {
      if (current.status !== "done") throw new Error(`${job.kind} ${current.status}: ${current.error ?? ""}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function startCollector(): Promise<ChildProcess> {
  const child = spawn("node", ["dist/server/index.js"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(PORT),
      TOKEN_SIGNING_SECRET: SECRET,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: path.join(dir, "data"),
      ASR_PYTHON: path.resolve("tests/support/fake-asr.sh"),
      POST_MIN_FREE_GB: "0",
      POST_RETENTION: "keep-all",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error("the collector stopped at start");
    try {
      if ((await fetch(`${base}/api/health`)).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error("the collector did not start");
}

/** Instants spread over the program, each at the centre of a frame: scene boundaries are on frame edges, so a centre is never ambiguous. */
function sampleTimes(durationMs: number): number[] {
  const frames = Math.floor((durationMs / 1000) * FPS) - 2;
  return Array.from({ length: frameCount }, (_, k) => Math.floor(((k + 0.5) * frames) / frameCount) + 1).map((frame) => (frame + 0.5) * (1000 / FPS));
}

async function ssim(preview: string, exported: string): Promise<number> {
  const log = await ffmpeg(["-i", preview, "-i", exported, "-lavfi", "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim", "-f", "null", "-"]);
  const match = /All:([0-9.]+)/.exec(log);
  if (!match) throw new Error(`no SSIM in the ffmpeg log: ${log.slice(-300)}`);
  return Number(match[1]);
}

async function measure(page: Page, combination: Combination, exportFile: string, times: number[]): Promise<number[]> {
  const frames = path.join(dir, "frames", combination.name);
  await mkdir(frames, { recursive: true });
  await page.goto(`${base}/project/${SID}?hooks=1`);
  const canvas = page.locator("[data-testid=pj-lay-canvas]");
  await canvas.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => "__syncPreview" in window);
  await page.evaluate(() => scrollTo(0, 0));
  // A canvas on a fractional position would be resampled by the browser: shift it onto the pixel grid, then shoot exactly its box.
  const spot = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.round(rect.x) - rect.x}px`;
    element.style.top = `${Math.round(rect.y) - rect.y}px`;
    const placed = element.getBoundingClientRect();
    return { x: Math.round(placed.x), y: Math.round(placed.y), width: Math.round(placed.width), height: Math.round(placed.height) };
  });
  const values: number[] = [];
  for (const [index, ms] of times.entries()) {
    const tag = String(index).padStart(2, "0");
    await page.evaluate(async (at) => {
      const hook: { seekMs(ms: number): Promise<void> } = Reflect.get(window, "__syncPreview");
      await hook.seekMs(at);
    }, ms);
    const previewFile = path.join(frames, `preview-${tag}.png`);
    await page.screenshot({ path: previewFile, type: "png", clip: spot });
    const exportedFile = path.join(frames, `export-${tag}.png`);
    // the preview is a screenshot of the canvas: the export frame is scaled to the size of that image. `-ss` takes the first frame
    // at or after its time, so ask a quarter of a frame before the frame's own time to get that frame and no other
    const size = await ffprobeSize(previewFile);
    if (size.width !== spot.width || size.height !== spot.height) throw new Error(`the screenshot is ${size.width}x${size.height}, the canvas ${spot.width}x${spot.height}: part of it is outside the viewport`);
    const frame = Math.floor((ms * FPS) / 1000);
    await ffmpeg(["-ss", ((frame - 0.25) / FPS).toFixed(5), "-i", exportFile, "-frames:v", "1", "-vf", `scale=${size.width}:${size.height}:flags=bicubic`, exportedFile]);
    values.push(await ssim(previewFile, exportedFile));
  }
  return values;
}

async function ffprobeSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file]);
  const [width, height] = stdout.trim().split("x").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

/**
 * A picture that behaves like a webcam image: a smooth background, a body and a head moving with sharp edges, softened a little
 * like a lens does. The synthetic test pattern of the other option is full of one-pixel noise, which a 480p preview copy can
 * never reproduce, so it measures the proxy's resolution, not the layout.
 */
async function cameraLikeClip(file: string, look: { from: string; to: string; body: string; head: string; speed: number }): Promise<void> {
  const length = seconds.toFixed(3);
  await ffmpeg([
    "-f", "lavfi", "-i", `gradients=s=1280x720:r=${FPS}:d=${length}:c0=${look.from}:c1=${look.to}:x0=0:y0=0:x1=1280:y1=720:speed=0.01`,
    "-f", "lavfi", "-i", `color=c=${look.body}:s=240x420:r=${FPS}:d=${length}`,
    "-f", "lavfi", "-i", `color=c=${look.head}:s=120x120:r=${FPS}:d=${length}`,
    "-filter_complex", `[0][1]overlay=x='mod(t*${look.speed}\\,900)':y=120[a];[a][2]overlay=x='mod(t*${look.speed}\\,900)+60':y=200,gblur=sigma=1.2,format=yuv420p[v]`,
    "-map", "[v]", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-crf", "18", "-b:v", "0", "-g", "60", "-f", "webm", file,
  ]);
}

await mkdir(dir, { recursive: true });
const data = path.join(dir, "data");
// two speakers from the spike fixtures, trimmed to the length of the program
const speechA = path.join(dir, "speaker-a.wav");
const speechB = path.join(dir, "speaker-b.wav");
await ffmpeg(["-i", path.join(asrDir, "fix-silence-en", "track_A.wav"), "-t", String(seconds), speechA]);
await ffmpeg(["-i", path.join(asrDir, "fix-silence-en", "track_B.wav"), "-t", String(seconds), speechB]);
await makeSyntheticSession({
  sessionId: SID,
  storageDir: data,
  durationSec: seconds,
  eventsMs: [3000, Math.round(seconds * 500), seconds * 1000 - 4000],
  cameraSize: "1280x720",
  cameraFps: FPS,
  cameraPicture: "barcode",
  participants: [
    { name: "Ala", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, audioFile: speechA },
    { name: "Bob", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, audioFile: speechB },
  ],
});
if (picture === "camera") {
  await cameraLikeClip(path.join(data, "session", SID, "p1-ala", "camera.webm"), { from: "0x1d3557", to: "0xe9c46a", body: "0x2a9d8f", head: "0xe76f51", speed: 300 });
  await cameraLikeClip(path.join(data, "session", SID, "p2-bob", "camera.webm"), { from: "0x6a040f", to: "0x9db4c0", body: "0xf4a261", head: "0x264653", speed: 210 });
}

const collector = await startCollector();
const result: Record<string, unknown> = { seconds, frames: frameCount, threshold, picture, canvasLongEdge: LONG_EDGE };
let failed = false;
try {
  await api("POST", "");
  await finish(await api<Job>("POST", "/jobs", { kind: "conform" }));
  const state = await api<{ project: { durationMs: number } }>("GET", "");
  const times = sampleTimes(state.project.durationMs);
  result.durationMs = state.project.durationMs;
  result.sampledMs = times.map((ms) => round(ms, 2));

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1700 }, deviceScaleFactor: 1 });
  await context.addInitScript(
    ([sid, credentials]) => {
      localStorage.setItem(`syncrecord.session.${sid}`, JSON.stringify(credentials));
      localStorage.setItem("syncrecord.lang", "en");
    },
    [SID, { participantId: HOST, participantToken: token, name: "Ala", host: true }] as const,
  );
  const page = await context.newPage();
  const summary: Row[] = [];
  try {
    for (const combination of COMBINATIONS) {
      const current = await api<{ rev: number }>("GET", "/scenes");
      const plan = { params: { ...DEFAULT_SCENE_PARAMS, layout: combination.layout }, overrides: [] };
      const saved = await api<{ scenes: unknown[] }>("PUT", "/scenes", { baseRev: current.rev, plan, aspect: combination.aspect, background: combination.background });
      const started = Date.now();
      await finish(await api<Job>("POST", "/jobs", { kind: "render", params: { preset: presetOf(combination.aspect) } }));
      const renderSec = (Date.now() - started) / 1000;
      const { exports } = await api<{ exports: Exported[] }>("GET", "/exports");
      const latest = exports.sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
      if (!latest) throw new Error("the render left no export");
      const values = await measure(page, combination, path.join(data, "post", SID, latest.file), times);
      const min = Math.min(...values);
      const pass = min >= threshold;
      if (!pass) failed = true;
      const row = { name: combination.name, layout: combination.layout, aspect: combination.aspect, background: combination.background.kind, scenes: saved.scenes.length, renderSec: round(renderSec, 1), min: round(min), mean: round(values.reduce((sum, value) => sum + value, 0) / values.length), pass, ssim: values.map((value) => round(value)) };
      summary.push(row);
      console.error(`${pass ? "ok  " : "FAIL"} ${combination.name}: min ${row.min} mean ${row.mean} (${row.scenes} scenes, render ${row.renderSec} s)`);
    }
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  result.combinations = summary;
  result.overallMin = Math.min(...summary.map((row) => row.min));
  result.pass = !failed;
} finally {
  collector.kill("SIGTERM");
}
await writeFile(path.join(dir, "ssim-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
