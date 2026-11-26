// Renders ASS captions with the same libass ffmpeg filter the product uses and hands the raw frames to a callback; used by
// the render test and the caption bench. Test and script helper only.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captionFilter } from "../../src/shared/captions.js";
import type { Rect } from "../../src/shared/safe-area.js";

export const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");

let libass: boolean | undefined;

/** Whether the ffmpeg on PATH has the libass `ass` filter. */
export function hasLibass(): boolean {
  if (libass === undefined) {
    try {
      libass = /\bass\b.*Render ASS subtitles/.test(execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }));
    } catch {
      libass = false;
    }
  }
  return libass;
}

export interface RenderOptions {
  assFile: string;
  /** Defaults to the bundled fonts. */
  fontsDir?: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** Flat background, as 6 hex digits. */
  background: string;
  /** Only this part of every frame is handed to the callback. */
  crop?: Rect;
  /** Replaces the caption filter (e.g. to render without fonts). */
  filter?: string;
  logLevel?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RenderResult {
  frames: number;
  log: string;
  /** Size of one delivered frame. */
  frameWidth: number;
  frameHeight: number;
}

/** Streams the frames (rgb24, no loss before the filter) of a flat colour video with the captions burned in. */
export function renderFrames(options: RenderOptions, onFrame: (index: number, rgb: Buffer) => void): Promise<RenderResult> {
  const { width, height, fps, seconds, background, crop } = options;
  const filter = options.filter ?? captionFilter(options.assFile, options.fontsDir ?? FONTS_DIR);
  const chain = ["format=rgb24", filter, ...(crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [])].join(",");
  const frameWidth = crop ? crop.w : width;
  const frameHeight = crop ? crop.h : height;
  const frameBytes = frameWidth * frameHeight * 3;
  const args = ["-hide_banner", "-v", options.logLevel ?? "error", "-f", "lavfi", "-i", `color=c=0x${background}:s=${width}x${height}:r=${fps}:d=${seconds}`, "-vf", chain, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer = Buffer.alloc(0);
    let frames = 0;
    let log = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      log += chunk;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        onFrame(frames, pending.subarray(0, frameBytes));
        frames += 1;
        pending = pending.subarray(frameBytes);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ frames, log, frameWidth, frameHeight });
      else reject(new Error(`ffmpeg exited with ${code}: ${log.slice(-600)}`));
    });
  });
}

export const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];

/** The bounding box of non-background pixels and how many there are. */
export interface Ink {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
}

/** Bounding box of the pixels that differ from the background by more than `tolerance` on any channel, or null. */
export function inkBox(rgb: Buffer, width: number, height: number, background: [number, number, number], tolerance = 4): Ink | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let pixels = 0;
  const [br, bg, bb] = background;
  for (let y = 0; y < height; y++) {
    let at = y * width * 3;
    for (let x = 0; x < width; x++, at += 3) {
      if (Math.abs((rgb[at] as number) - br) > tolerance || Math.abs((rgb[at + 1] as number) - bg) > tolerance || Math.abs((rgb[at + 2] as number) - bb) > tolerance) {
        pixels += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return pixels === 0 ? null : { x0, y0, x1, y1, pixels };
}

export const sizeOf = (ink: Ink | null): [number, number] => (ink ? [ink.x1 - ink.x0 + 1, ink.y1 - ink.y0 + 1] : [0, 0]);
