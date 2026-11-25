import type { Range } from "../../shared/edl.js";
import { PEAKS_PER_SECOND } from "../../shared/project.js";
import { h } from "../lib/dom.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";

const HEIGHT_CSS_PX = 76;
const PEAK_MS = 1000 / PEAKS_PER_SECOND;
/** Seconds one arrow key press moves the playhead on the focused strip. */
const KEY_STEP_MS = 2000;

/** Largest peak of every group of `peaks` that falls into each of `width` columns spanning `durationMs`. One pass over the array. */
export function peakColumns(peaks: Uint8Array, durationMs: number, width: number): Uint8Array {
  const columns = new Uint8Array(width);
  const total = durationMs / PEAK_MS;
  if (width === 0 || total <= 0) return columns;
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * total) / width);
    if (from >= peaks.length) break;
    const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil(((x + 1) * total) / width)));
    let max = 0;
    for (let i = from; i < to; i++) {
      const value = peaks[i] as number;
      if (value > max) max = value;
    }
    columns[x] = max;
  }
  return columns;
}

/** Element-wise maximum of several peak arrays (the loudest track wins at every instant). */
export function combinePeaks(tracks: Uint8Array[]): Uint8Array {
  const length = tracks.reduce((max, track) => Math.max(max, track.length), 0);
  const out = new Uint8Array(length);
  for (const track of tracks) for (let i = 0; i < track.length; i++) if ((track[i] as number) > (out[i] as number)) out[i] = track[i] as number;
  return out;
}

export interface TimelineOptions {
  /** Length of the project timeline in ms. */
  durationMs: number;
  /** Moments flagged while recording, in ms. */
  highlights: number[];
  /** Called while the user clicks or drags on the strip. */
  onSeek: (ms: number) => void;
}

export interface Timeline {
  el: HTMLElement;
  setPeaks(peaks: Uint8Array | null): void;
  setRemoved(removed: Range[]): void;
  setSelection(selection: Range | null): void;
  /** Where one scene ends and the next begins (ms); drawn as thin lines. */
  setSceneBounds(bounds: number[]): void;
  setPlayhead(ms: number): void;
  dispose(): void;
}

/**
 * The whole recording on one strip: the waveform (one column per device pixel, taken from the peaks array, no element per
 * sample), the removed ranges shaded, the highlights as ticks, the selection and the playhead. The static layers are painted
 * to an off-screen canvas that is rebuilt only when the data or the size changes; moving the playhead just copies it.
 */
export function timeline(options: TimelineOptions): Timeline {
  const { durationMs } = options;
  const canvas = h("canvas", {
    class: "timeline",
    "data-testid": "pj-ed-timeline",
    role: "slider",
    tabindex: 0,
    "aria-label": t("pj.ed.timeline"),
    "aria-valuemin": 0,
    "aria-valuemax": Math.round(durationMs / 1000),
    "aria-valuenow": 0,
  });
  const readout = h("span", { class: "timeline-time hint", "data-testid": "pj-ed-timeline-time" });
  const el = h("div", { class: "timeline-wrap" }, canvas, readout);
  const base = document.createElement("canvas");

  let peaks: Uint8Array | null = null;
  let columns: Uint8Array = new Uint8Array(0);
  let removed: Range[] = [];
  let selection: Range | null = null;
  let sceneBounds: number[] = [];
  let playheadMs = 0;
  let baseDirty = true;
  let frame = 0;
  let disposed = false;
  let ink = "#0a0a0a";

  const xOf = (ms: number): number => (durationMs <= 0 ? 0 : Math.round((Math.min(Math.max(ms, 0), durationMs) / durationMs) * base.width));
  const color = (name: string, fallback: string): string => getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;

  function resize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(HEIGHT_CSS_PX * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    base.width = width;
    base.height = height;
    columns = peaks ? peakColumns(peaks, durationMs, width) : new Uint8Array(width);
    return true;
  }

  function paintBase(): void {
    const ctx = base.getContext("2d");
    if (!ctx) return;
    const { width, height } = base;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, width, height);
    // the waveform, loudest first: the square root lifts quiet recordings so speech is visible
    const mid = height / 2;
    ctx.fillStyle = color("--brand", "#2563eb");
    for (let x = 0; x < width; x++) {
      const amplitude = Math.sqrt((columns[x] as number) / 255);
      const half = Math.max(0.5 * dpr, amplitude * (mid - 2 * dpr));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    // removed ranges: the waveform fades and a red wash with edges marks them
    const danger = color("--danger", "#b91c1c");
    for (const range of removed) {
      const from = xOf(range.s);
      const to = Math.max(from + 1, xOf(range.e));
      ctx.fillStyle = "rgb(255 255 255 / 70%)";
      ctx.fillRect(from, 0, to - from, height);
      ctx.fillStyle = danger;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(from, 0, to - from, height);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(from, 0, Math.max(1, dpr), height);
      ctx.fillRect(Math.max(from, to - Math.max(1, dpr)), 0, Math.max(1, dpr), height);
      ctx.globalAlpha = 1;
    }
    if (selection) {
      const from = xOf(selection.s);
      const to = Math.max(from + 1, xOf(selection.e));
      ctx.fillStyle = color("--brand", "#2563eb");
      ctx.globalAlpha = 0.22;
      ctx.fillRect(from, 0, to - from, height);
      ctx.globalAlpha = 1;
      ctx.fillRect(from, 0, Math.max(1, dpr), height);
      ctx.fillRect(Math.max(from, to - Math.max(1, dpr)), 0, Math.max(1, dpr), height);
    }
    // scene boundaries: hairlines in the ink colour, so they read on the waveform and on the removed wash
    ctx.fillStyle = color("--text", "#0a0a0a");
    ctx.globalAlpha = 0.35;
    for (const at of sceneBounds) ctx.fillRect(xOf(at), 0, Math.max(1, Math.round(dpr)), height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color("--warn", "#92400e");
    for (const at of options.highlights) {
      const x = xOf(at);
      ctx.fillRect(x - dpr, 0, 2 * dpr, 12 * dpr);
      ctx.fillRect(x - dpr, height - 12 * dpr, 2 * dpr, 12 * dpr);
    }
    ink = color("--text", "#0a0a0a");
    baseDirty = false;
  }

  function paint(): void {
    frame = 0;
    if (disposed) return;
    if (resize()) baseDirty = true;
    if (baseDirty) paintBase();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const x = xOf(playheadMs);
    ctx.fillStyle = ink;
    ctx.fillRect(Math.min(x, canvas.width - 2 * dpr), 0, 2 * dpr, canvas.height);
  }

  function schedule(rebuild: boolean): void {
    if (rebuild) baseDirty = true;
    if (frame === 0 && !disposed) frame = requestAnimationFrame(paint);
  }

  const seekFrom = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    options.onSeek(fraction * durationMs);
  };
  let dragging = false;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    seekFrom(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (dragging) seekFrom(event);
  });
  const release = (): void => {
    dragging = false;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    options.onSeek(Math.min(durationMs, Math.max(0, playheadMs + (event.key === "ArrowRight" ? KEY_STEP_MS : -KEY_STEP_MS))));
  });

  const observer = new ResizeObserver(() => schedule(true));
  observer.observe(canvas);
  readout.textContent = `${formatClock(0)} / ${formatClock(durationMs)}`;
  schedule(true);

  return {
    el,
    setPeaks(next) {
      peaks = next;
      columns = peaks ? peakColumns(peaks, durationMs, canvas.width) : new Uint8Array(canvas.width);
      schedule(true);
    },
    setRemoved(next) {
      removed = next;
      schedule(true);
    },
    setSelection(next) {
      selection = next;
      schedule(true);
    },
    setSceneBounds(next) {
      sceneBounds = next;
      canvas.dataset.scenes = String(next.length + 1);
      schedule(true);
    },
    setPlayhead(ms) {
      playheadMs = ms;
      readout.textContent = `${formatClock(ms)} / ${formatClock(durationMs)}`;
      const seconds = Math.round(ms / 1000);
      if (canvas.getAttribute("aria-valuenow") !== String(seconds)) canvas.setAttribute("aria-valuenow", String(seconds));
      schedule(false);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
