import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { keptDuration, keptRanges, type Range } from "../../shared/edl.js";
import { LEVEL_FRAME_MS, type JobRecord } from "../../shared/project.js";
import type { Config } from "../config.js";
import { readEdl } from "./edl-store.js";
import { ffmpeg } from "./exec.js";
import type { JobContext } from "./jobs.js";
import type { ProjectStore } from "./projects.js";

/** Length of the fade at the start and end of every kept piece, so a join never has a step in it. */
export const FADE_MS = 5;

/**
 * Filter graph that keeps the given ranges of input 0's audio and joins them. Every piece fades in and out over
 * `fadeMs` (except at the very start and end of the recording), which removes the click a hard cut makes.
 */
export function audioCutGraph(kept: Range[], durationMs: number, fadeMs = FADE_MS): string {
  const parts: string[] = [];
  kept.forEach((range, index) => {
    const length = range.e - range.s;
    const fade = Math.min(fadeMs, length / 2);
    const filters = [`atrim=start=${(range.s / 1000).toFixed(6)}:end=${(range.e / 1000).toFixed(6)}`, "asetpts=PTS-STARTPTS"];
    if (fade > 0 && range.s > 0) filters.push(`afade=t=in:st=0:d=${(fade / 1000).toFixed(6)}`);
    if (fade > 0 && range.e < durationMs) filters.push(`afade=t=out:st=${((length - fade) / 1000).toFixed(6)}:d=${(fade / 1000).toFixed(6)}`);
    parts.push(`[0:a]${filters.join(",")}[k${index}]`);
  });
  const joined = kept.map((_, index) => `[k${index}]`).join("");
  parts.push(kept.length === 1 ? "[k0]anull[out]" : `${joined}concat=n=${kept.length}:v=0:a=1[out]`);
  return parts.join(";\n");
}

export interface CutPreviewDeps {
  config: Config;
  store: ProjectStore;
}

/** Renders the mixed audio proxy with the edit applied: what the player would play, as one file (`proxies/mix-cut.m4a`). */
export function cutPreviewHandler(deps: CutPreviewDeps) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const project = await deps.store.require(job.sid);
    if (!project.mixProxy) throw new Error("no mixed audio: run the conform job first");
    const dir = deps.store.dir(job.sid);
    const edl = await readEdl(dir);
    const kept = keptRanges(edl, project.durationMs);
    if (kept.length === 0) throw new Error("everything is removed");
    const output = path.join("proxies", "mix-cut.m4a");
    const temp = path.join(dir, "proxies", "mix-cut.part.m4a");
    const script = path.join(dir, "tmp", `${job.id}-graph.txt`);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, audioCutGraph(kept, project.durationMs));
    try {
      const expectedMs = keptDuration(edl, project.durationMs);
      await ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads, expectedSec: expectedMs / 1000, onProgress: (fraction) => ctx.progress(fraction, "audio") }, [
        "-i", path.join(dir, project.mixProxy), "-filter_complex_script", script, "-map", "[out]", "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-threads", String(ctx.threads), "-movflags", "+faststart", "-f", "mp4", temp,
      ]);
      await rename(temp, path.join(dir, output));
      return { file: output, rev: edl.rev, keptMs: expectedMs, ranges: kept.length, frameMs: LEVEL_FRAME_MS };
    } finally {
      await rm(script, { force: true });
    }
  };
}
