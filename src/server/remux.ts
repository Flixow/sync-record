import { execFile } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Storage } from "./storage/index.js";

const run = promisify(execFile);

export interface RemuxResult {
  bytes: number;
  durationSec: number | null;
}

export interface RemuxOptions {
  ffmpegPath: string;
  ffprobePath: string;
}

/**
 * Concatenates the raw parts of one track in offset order, remuxes them with
 * `ffmpeg -c copy` (no re-encode) into a seekable WebM and stores the result.
 *
 * MediaRecorder chunks are not standalone: only the first part carries the WebM
 * header, so the parts must be joined in order before ffmpeg sees them.
 */
export async function remuxTrack(
  storage: Storage,
  partKeys: string[],
  outputKey: string,
  options: RemuxOptions,
): Promise<RemuxResult> {
  if (partKeys.length === 0) throw new Error("track has no data");
  const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-remux-"));
  try {
    const joined = path.join(dir, "joined.webm");
    const output = path.join(dir, "output.webm");

    const file = await open(joined, "w");
    try {
      for (const key of partKeys) {
        for await (const chunk of await storage.readStream(key)) await file.write(chunk as Buffer);
      }
    } finally {
      await file.close();
    }

    // Chunked MediaRecorder output has no Duration and no Cues; rewriting the
    // container fixes both without touching the encoded frames.
    await run(options.ffmpegPath, ["-y", "-v", "error", "-i", joined, "-c", "copy", "-cues_to_front", "1", output]);

    const info = await stat(output);
    if (info.size === 0) throw new Error("ffmpeg produced an empty file");
    await storage.putFile(outputKey, output);
    return { bytes: info.size, durationSec: await probeDuration(options.ffprobePath, output) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeDuration(ffprobePath: string, file: string): Promise<number | null> {
  try {
    const { stdout } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
    const value = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Resolves when ffmpeg is runnable; used for a startup warning. */
export async function checkFfmpeg(ffmpegPath: string): Promise<boolean> {
  try {
    await run(ffmpegPath, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

