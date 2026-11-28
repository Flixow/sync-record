import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "../../shared/project.js";
import { LINE_HEIGHT_EM, OUTLINE_EM, overlayTextLayout, thumbnailSpec, type OverlayLayout, type OverlayPlacement, type ThumbnailKind } from "../../shared/publish.js";
import type { Rect } from "../../shared/safe-area.js";
import { parseSignalStats, textBackingNeeded } from "../../shared/thumb-score.js";
import { defaultTextSide, parseThumbnailStyle, THUMBNAIL_COLOR_HEX, type ThumbnailColor, type ThumbnailSide } from "../../shared/thumb-style.js";
import type { Config } from "../config.js";
import { addExport } from "./exports.js";
import { ffmpeg } from "./exec.js";
import type { JobContext } from "./jobs.js";
import type { ProjectStore } from "./projects.js";
import { escapePath, FONTS_DIR } from "./render-layout.js";
import { frameContext, PREVIEW_CANVAS, planFrame, withGraphFile, type FrameContext, type FrameRequest } from "./thumbnail-frame.js";

const FONT = "NotoSans-Bold.ttf";
/** Height of the capital letters of Noto Sans Bold, in em. */
const CAP_HEIGHT_EM = 0.714;
const SHADOW_EM = 0.04;
const BACKING = "black@0.55";

const evenDown = (n: number): number => Math.floor(n / 2) * 2;

/**
 * Mean luma of the area the headline will cover, measured on the same picture one sixth of its size: brighter than the
 * threshold and the letters need a dark backing to stay readable.
 */
async function areaLuma(ctx: JobContext, config: Config, fc: FrameContext, request: FrameRequest, box: Rect, name: string): Promise<number | null> {
  const small = PREVIEW_CANVAS[request.kind];
  const plan = await planFrame(fc, { ...request, canvas: small });
  if (!plan) return null;
  const ratio = small.width / request.canvas.width;
  const x = Math.min(evenDown(box.x * ratio), small.width - 2);
  const y = Math.min(evenDown(box.y * ratio), small.height - 2);
  const w = Math.max(2, Math.min(small.width - x, evenDown(box.w * ratio)));
  const h = Math.max(2, Math.min(small.height - y, evenDown(box.h * ratio)));
  const dump = path.join(fc.dir, "tmp", `${name}-block.txt`);
  try {
    const graph = `${plan.graph};\n${plan.label}crop=${w}:${h}:${x}:${y},signalstats,metadata=mode=print:file=${escapePath(dump)}[blk]`;
    await withGraphFile(fc.dir, `${name}-measure.txt`, graph, (script) => ffmpeg(ctx, { ffmpegPath: config.ffmpegPath, threads: ctx.threads }, [...plan.inputs, "-filter_complex_script", script, "-map", "[blk]", "-frames:v", "1", "-f", "null", "-"]));
    return parseSignalStats(await readFile(dump, "utf8").catch(() => "")).YAVG ?? null;
  } finally {
    await rm(dump, { force: true });
  }
}

/**
 * The filters that draw a headline: an optional dark translucent backing, then one `drawtext` per line (the bundled bold
 * face, the colour preset, a thick black outline and a soft shadow), lines centred in the block and set on a common baseline.
 * The text of each line goes through a file, so no character of it can break the filter syntax.
 */
async function headlineFilters(layout: OverlayLayout, color: ThumbnailColor, backing: boolean, dir: string, name: string, files: string[]): Promise<string[]> {
  const { box, fontSize } = layout;
  const parts: string[] = [];
  if (backing) parts.push(`drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${BACKING}:t=fill`);
  const step = fontSize * LINE_HEIGHT_EM;
  const cap = fontSize * CAP_HEIGHT_EM;
  const top = box.y + (box.h - ((layout.lines.length - 1) * step + cap)) / 2;
  const outline = Math.max(2, Math.round(fontSize * OUTLINE_EM));
  const shadow = Math.max(1, Math.round(fontSize * SHADOW_EM));
  for (const [index, line] of layout.lines.entries()) {
    const file = path.join(dir, "tmp", `${name}-line${index}.txt`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, line);
    files.push(file);
    const baseline = Math.round(top + cap + index * step);
    parts.push(
      `drawtext=fontfile=${escapePath(path.join(FONTS_DIR, FONT))}:textfile=${escapePath(file)}:expansion=none:fontsize=${fontSize}:fontcolor=0x${THUMBNAIL_COLOR_HEX[color]}` +
        `:borderw=${outline}:bordercolor=black:shadowx=${shadow}:shadowy=${shadow}:shadowcolor=black@0.6:x=${Math.round(box.x + box.w / 2)}-text_w/2:y=${baseline}-ascent`,
    );
  }
  return parts;
}

/**
 * Thumbnail: one frame of the recording as a JPEG at full size (3840x2160, or 2160x3840 for a Short): the speaker's face
 * zoomed and placed opposite the headline, with a mild punch, and the headline in heavy capitals with a thick outline in
 * the left or right third (the top of a Short), on a dark backing when the area under it is bright. Made from the recording
 * by ffmpeg on the server alone.
 */
export function thumbnailHandler(deps: { config: Config; store: ProjectStore }) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const kind: ThumbnailKind = job.params.kind === "short" ? "short" : "video";
    const spec = thumbnailSpec(kind);
    const canvas = { width: spec.width, height: spec.height };
    const atMs = Number(job.params.atMs);
    const fc = await frameContext(deps.store, job.sid);
    const { dir } = fc;
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > fc.project.durationMs) throw new Error("atMs is outside the recording");
    const style = parseThumbnailStyle(job.params);
    const side: ThumbnailSide = style.side ?? defaultTextSide();
    const request: FrameRequest = { atMs, kind, canvas, side };
    const plan = await planFrame(fc, request);
    if (!plan) throw new Error("no picture source at that moment");

    let graph = plan.graph;
    let label = plan.label;
    const cleanup: string[] = [];
    try {
      if (style.text !== "") {
        const placement: OverlayPlacement = kind === "short" ? "top" : side;
        const layout = overlayTextLayout(style.text.toUpperCase(), canvas, placement);
        const luma = await areaLuma(ctx, deps.config, fc, request, layout.box, job.id);
        const filters = await headlineFilters(layout, style.color, luma !== null && textBackingNeeded(luma), dir, job.id, cleanup);
        graph += `;\n${label}${filters.join(",")}[vtxt]`;
        label = "[vtxt]";
      }
      const outDir = path.join(dir, "exports", job.id);
      await mkdir(outDir, { recursive: true });
      const out = path.join(outDir, `thumbnail-${kind}.jpg`);
      ctx.progress(0.5, "frame");
      await withGraphFile(dir, `${job.id}-thumb.txt`, graph, (script) =>
        ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads }, [...plan.inputs, "-filter_complex_script", script, "-map", label, "-frames:v", "1", "-q:v", "2", "-update", "1", out]),
      );
      const info = await stat(out);
      if (info.size > spec.maxBytes) throw new Error("the thumbnail is larger than the allowed size");
      const file = path.join("exports", job.id, `thumbnail-${kind}.jpg`);
      await addExport(dir, { id: job.id, preset: `thumbnail-${kind}`, file, bytes: info.size, durationMs: 0, createdAtMs: Date.now(), loudnessLufs: null, edlRev: 0 });
      return { file, bytes: info.size, width: spec.width, height: spec.height, text: style.text, color: style.color, side };
    } finally {
      for (const file of cleanup) await rm(file, { force: true });
    }
  };
}
