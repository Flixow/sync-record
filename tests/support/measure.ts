import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { BARCODE_HEIGHT, BARCODE_WIDTH, BurstDetector } from "./synthetic.js";

const run = promisify(execFile);

/** Onsets (ms) of the tone bursts in an audio file, decoded to mono 48 kHz. */
export function audioOnsets(file: string, threshold = 3000): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const detector = new BurstDetector(threshold);
    const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => detector.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(detector.onsets) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

/** Instants (ms) at which a constant-frame-rate video turns from dark to bright (the flash frames). */
export function videoFlashOnsets(file: string, fps: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const onsets: number[] = [];
    let frame = 0;
    let bright = false;
    const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-vf", "scale=4:4,format=gray", "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "inherit"] });
    let pending: Buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const frames = Math.floor(data.length / 16);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let p = 0; p < 16; p++) sum += data[i * 16 + p] ?? 0;
        const isBright = sum / 16 > 128;
        if (isBright && !bright) onsets.push((frame / fps) * 1000);
        bright = isBright;
        frame += 1;
      }
      pending = data.subarray(frames * 16);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(onsets) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

/** Pairs each expected event with the closest detected onset within `window` ms and returns the signed errors. */
export function matchEvents(expectedMs: number[], detectedMs: number[], windowMs = 400): { errorsMs: number[]; missing: number } {
  const errorsMs: number[] = [];
  let missing = 0;
  for (const expected of expectedMs) {
    const nearest = detectedMs.reduce<number | null>((best, value) => (Math.abs(value - expected) < Math.abs((best ?? Infinity) - expected) ? value : best), null);
    if (nearest !== null && Math.abs(nearest - expected) <= windowMs) errorsMs.push(nearest - expected);
    else missing += 1;
  }
  return { errorsMs, missing };
}

/** Media frame numbers read from the barcode of every frame of a video (see `cameraPicture: "barcode"`). */
export function barcodeFrames(file: string, scale = 1): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const frames: number[] = [];
    let pending: Buffer = Buffer.alloc(0);
    const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-vf", `crop=${Math.round(BARCODE_WIDTH * scale)}:${Math.round(BARCODE_HEIGHT * scale)}:0:0,scale=16:1:flags=area,format=gray`, "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => {
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const count = Math.floor(data.length / 16);
      for (let i = 0; i < count; i++) {
        let value = 0;
        for (let bit = 0; bit < 16; bit++) if ((data[i * 16 + bit] ?? 0) > 127) value |= 1 << bit;
        frames.push(value);
      }
      pending = data.subarray(count * 16);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(frames) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

export interface Mp4Layout {
  /** Top-level box types in file order. */
  boxes: string[];
  moovBeforeMdat: boolean;
  hasEditList: boolean;
}

/** Top-level box order and the presence of an edit list (`elst`) anywhere in the movie header. */
export async function inspectMp4(file: string): Promise<Mp4Layout> {
  const handle = await open(file, "r");
  try {
    const boxes: string[] = [];
    let moov: Buffer | null = null;
    let position = 0;
    const size = (await handle.stat()).size;
    while (position + 8 <= size) {
      const head = Buffer.alloc(16);
      await handle.read(head, 0, 16, position);
      let length = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (length === 1) length = Number(head.readBigUInt64BE(8));
      if (length === 0) length = size - position;
      boxes.push(type);
      if (type === "moov") {
        moov = Buffer.alloc(length);
        await handle.read(moov, 0, length, position);
      }
      position += length;
    }
    return { boxes, moovBeforeMdat: boxes.indexOf("moov") !== -1 && boxes.indexOf("moov") < boxes.indexOf("mdat"), hasEditList: moov?.includes(Buffer.from("elst")) ?? false };
  } finally {
    await handle.close();
  }
}

/** Streams, format and per-packet facts of a file as ffprobe reports them. */
export async function probeJson(file: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", ...args, file], { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export interface BarcodeJump {
  /** Output frame at which the source frame number jumps. */
  atFrame: number;
  /** Source frames skipped (positive) or repeated (negative). */
  skipped: number;
}

/**
 * Jumps in the sequence of barcode frame numbers. A heavily compressed picture misreads a low bit now and then, so a
 * reading counts as consecutive while it stays within `tolerance` of the running offset, and a jump needs the next ten
 * readings to agree on a new offset.
 */
export function barcodeJumps(codes: number[], tolerance = 3): BarcodeJump[] {
  const jumps: BarcodeJump[] = [];
  const offset = (i: number): number => (codes[i] as number) - i;
  let current = codes.length > 0 ? offset(0) : 0;
  for (let i = 1; i < codes.length; i++) {
    if (Math.abs(offset(i) - current) <= tolerance) continue;
    const ahead: number[] = [];
    for (let k = i; k < Math.min(codes.length, i + 10); k++) ahead.push(offset(k));
    ahead.sort((a, b) => a - b);
    const next = ahead[Math.floor(ahead.length / 2)] as number;
    if (ahead.every((value) => Math.abs(value - next) <= tolerance) && Math.abs(next - current) > tolerance) {
      const before: number[] = [];
      for (let k = Math.max(0, i - 10); k < i; k++) before.push(offset(k));
      before.sort((a, b) => a - b);
      jumps.push({ atFrame: i, skipped: next - (before[Math.floor(before.length / 2)] as number) });
      current = next;
    }
  }
  return jumps;
}
