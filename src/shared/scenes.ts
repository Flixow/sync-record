// Scenes: which sources are on screen when, decided from who is speaking. Pure functions over immutable values.
//
// planScenes turns the level tracks of the microphones into a gap-free list of scenes (active speaker switching). A
// plan is those automatic scenes plus manual overrides on top; applyOverrides layers them, remapScenes carries the
// result through the edit decision list, and the plan helpers with their history make every manual change undoable.

import { toOutput, type Edl } from "./edl.js";
import { effectiveLayout, type Fit, type LayoutId } from "./layout.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS } from "./project.js";
import { DEFAULT_VAD, speechFrames, type VadOptions } from "./vad.js";

export type Rhythm = "calm" | "balanced" | "lively";

export interface ActivityTrack {
  /**
   * The source that is shown while this track's owner speaks: for a camera the id of the video source, whichever audio
   * source carries the microphone (the caller pairs them). A "screen" track is a picture to feature, never a speaker.
   */
  id: string;
  /** The microphone level, dBFS RMS per 20 ms frame (the level track of the conform step). Unused for a screen. */
  levels: Int8Array;
  /** Default "camera". */
  kind?: "camera" | "screen";
  /** Speech flags per frame when already computed; otherwise they are computed from `levels` and the other tracks' levels. */
  speech?: Uint8Array;
}

export interface SceneParams {
  /** No scene is shorter than this (before the rhythm's factor), except that nothing can be longer than the recording. */
  minDwellMs: number;
  /** A challenger takes over from the speaker who is on screen only when it is this much louder (dB) on its own microphone while both speak. */
  hysteresisDb: number;
  /** The speaker on screen stays active this long after they stop. */
  hangoverMs: number;
  /** Scales the dwell (calm 1.6x, balanced 1x, lively 0.7x) and sets how short an interjection still counts (700, 400, 250 ms). */
  rhythm: Rhythm;
  layout: LayoutId;
  fit?: Fit;
  /**
   * What to show when nobody speaks or several speak at once (for longer than a moment): all cameras ("wide": grid or
   * side by side) or the last active speaker ("keep"). With a screen the last speaker's camera always stays.
   */
  fallback: "wide" | "keep";
}

export const DEFAULT_SCENE_PARAMS: SceneParams = { minDwellMs: 2500, hysteresisDb: 4, hangoverMs: 600, rhythm: "balanced", layout: "solo", fallback: "keep" };

/** Dwell factor and the interjection limit of each rhythm. */
export const RHYTHMS: Record<Rhythm, { dwell: number; ignoreMs: number }> = {
  calm: { dwell: 1.6, ignoreMs: 700 },
  balanced: { dwell: 1, ignoreMs: 400 },
  lively: { dwell: 0.7, ignoreMs: 250 },
};

/** The shortest scene `planScenes` produces for these params (the recording's own length aside). */
export const effectiveMinDwellMs = (params: SceneParams): number => Math.round(params.minDwellMs * RHYTHMS[params.rhythm].dwell);

/** Simultaneous speech without a louder voice for longer than this is shown as "several speak at once". */
const CROSSTALK_MS = 1500;
/** A new speaker is on screen this long before their first speech frame (when nobody else is speaking then): the first syllable is often too soft to register. */
const LEAD_IN_MS = 150;
/** Half-width in frames of the window over which two voices' loudness is compared. */
const COMPARE_HALF_WINDOW = 2;

export interface Scene {
  /** ms on the project timeline; the scenes of a list tile [0, duration] without gaps. */
  s: number;
  e: number;
  layout: LayoutId;
  /** Ordered, the first is the featured source (the active speaker or the screen). Every source of the project that the layout may show. */
  sources: string[];
  fit?: Fit;
}

const NONE = -1;
const MULTI = -2;
const WIDE = -3;

interface Run {
  /** A speaker index (>= 0), or NONE, MULTI, WIDE. */
  label: number;
  /** Frames [s, e). */
  s: number;
  e: number;
}

/** Per-frame speaker: who is on screen, from the speech flags and levels of the camera tracks. */
function labelFrames(flags: Uint8Array[], levels: Int8Array[], frames: number, params: SceneParams): Int8Array {
  const count = flags.length;
  const hang = Math.ceil(params.hangoverMs / LEVEL_FRAME_MS);
  const crosstalk = Math.ceil(CROSSTALK_MS / LEVEL_FRAME_MS);
  // loudness of a voice while it is speaking: mean power over a short window, only counting frames flagged as speech
  const prefix = flags.map((track, index) => {
    const sums = new Float64Array(frames + 1);
    for (let frame = 0; frame < frames; frame++) {
      const power = track[frame] === 1 ? 10 ** ((levels[index]?.[frame] ?? LEVEL_FLOOR_DB) / 10) : 0;
      sums[frame + 1] = (sums[frame] as number) + power;
    }
    return sums;
  });
  const loudness = (index: number, frame: number): number => {
    const sums = prefix[index] as Float64Array;
    const from = Math.max(0, frame - COMPARE_HALF_WINDOW);
    const to = Math.min(frames, frame + COMPARE_HALF_WINDOW + 1);
    return 10 * Math.log10(((sums[to] as number) - (sums[from] as number)) / (to - from) + 1e-12);
  };

  const labels = new Int8Array(frames);
  const voiced = new Uint8Array(frames);
  let previous = NONE;
  let held = NONE;
  let heldAt = -Infinity;
  let contest = 0;
  const speaking: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    speaking.length = 0;
    for (let index = 0; index < count; index++) if ((flags[index] as Uint8Array)[frame] === 1) speaking.push(index);
    let label: number;
    if (speaking.length === 0) {
      label = held >= 0 && frame - heldAt <= hang ? held : NONE;
      contest = 0;
    } else if (speaking.length === 1) {
      label = speaking[0] as number;
      contest = 0;
    } else {
      // several voices at once: the one on screen stays unless another is clearly louder on its own microphone
      let top = speaking[0] as number;
      let topLevel = loudness(top, frame);
      for (const index of speaking) {
        const level = loudness(index, frame);
        if (level > topLevel) {
          top = index;
          topLevel = level;
        }
      }
      const incumbent = speaking.includes(previous) ? previous : -1;
      if (incumbent >= 0) {
        label = top !== incumbent && topLevel >= loudness(incumbent, frame) + params.hysteresisDb ? top : incumbent;
      } else {
        let second = -Infinity;
        for (const index of speaking) if (index !== top) second = Math.max(second, loudness(index, frame));
        label = topLevel >= second + params.hysteresisDb ? top : MULTI;
      }
      contest = label === top && label !== incumbent ? 0 : contest + 1;
      if (contest > crosstalk) label = MULTI;
    }
    if (label >= 0 && speaking.length > 0) {
      held = label;
      heldAt = frame;
    }
    labels[frame] = label;
    voiced[frame] = speaking.length > 0 ? 1 : 0;
    previous = label;
  }
  const lead = Math.ceil(LEAD_IN_MS / LEVEL_FRAME_MS);
  for (let frame = 1; frame < frames; frame++) {
    const label = labels[frame] as number;
    if (label < 0 || voiced[frame] === 0 || labels[frame - 1] === label) continue;
    for (let back = frame - 1; back >= Math.max(0, frame - lead) && voiced[back] === 0 && labels[back] !== label; back--) labels[back] = label;
  }
  return labels;
}

function toRuns(labels: Int8Array): Run[] {
  const runs: Run[] = [];
  for (let frame = 0; frame < labels.length; frame++) {
    const label = labels[frame] as number;
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.e = frame + 1;
    else runs.push({ label, s: frame, e: frame + 1 });
  }
  return runs;
}

/** Joins neighbours with the same label. */
function joinRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.label === run.label) last.e = run.e;
    else out.push({ ...run });
  }
  return out;
}

/** A speaker whose run holds less than `ignoreFrames` frames of their own speech is an interjection: the picture stays with whoever was on screen. */
function absorbInterjections(input: Run[], flags: Uint8Array[], ignoreFrames: number): Run[] {
  const spoken = (run: Run): number => {
    const own = flags[run.label] as Uint8Array;
    let count = 0;
    for (let frame = run.s; frame < run.e; frame++) count += own[frame] === 1 ? 1 : 0;
    return count;
  };
  let runs = input;
  for (;;) {
    const index = runs.findIndex((run) => run.label >= 0 && spoken(run) < ignoreFrames);
    if (index < 0 || runs.length === 1) return runs;
    const neighbour = runs[index - 1] ?? (runs[index + 1] as Run);
    runs = joinRuns(runs.map((run, at) => (at === index ? { ...run, label: neighbour.label } : run)));
  }
}

/** Nobody speaks, or several do: "wide" shows everybody, otherwise the last speaker stays (the next one before the first). */
function resolveFallback(runs: Run[], wide: boolean): Run[] {
  const neutral = (label: number): boolean => label === NONE || label === MULTI;
  if (wide) return joinRuns(runs.map((run) => (neutral(run.label) ? { ...run, label: WIDE } : run)));
  let last = runs.find((run) => !neutral(run.label))?.label ?? 0;
  return joinRuns(
    runs.map((run) => {
      if (neutral(run.label)) return { ...run, label: last };
      last = run.label;
      return run;
    }),
  );
}

/** Gives the shortest too-short scene the label of its longer neighbour, again and again, until none is shorter than the dwell. */
function enforceDwell(input: Run[], dwellMs: number, durationMs: number): Run[] {
  const length = (run: Run): number => Math.min(run.e * LEVEL_FRAME_MS, durationMs) - run.s * LEVEL_FRAME_MS;
  let runs = input;
  while (runs.length > 1) {
    let shortest = -1;
    runs.forEach((run, index) => {
      if (length(run) < dwellMs && (shortest < 0 || length(run) < length(runs[shortest] as Run))) shortest = index;
    });
    if (shortest < 0) break;
    const before = runs[shortest - 1];
    const after = runs[shortest + 1];
    const target = !before || (after && length(after) > length(before)) ? (after as Run) : before;
    runs = joinRuns(runs.map((run, index) => (index === shortest ? { ...run, label: target.label } : run)));
  }
  return runs;
}

const sameSources = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Two scenes show the same thing. */
export function sameScene(a: Scene, b: Scene): boolean {
  return a.layout === b.layout && a.fit === b.fit && sameSources(a.sources, b.sources);
}

/** Joins neighbours that show the same thing. */
function mergeScenes(scenes: Scene[]): Scene[] {
  const out: Scene[] = [];
  for (const scene of scenes) {
    const last = out[out.length - 1];
    if (last && sameScene(last, scene)) last.e = scene.e;
    else out.push({ ...scene, sources: [...scene.sources] });
  }
  return out;
}

/**
 * Active speaker switching. The cameras are the speakers; speech comes from `speechFrames` of src/shared/vad.ts, so a
 * quiet copy of one voice on another's microphone is not that person talking. In order:
 *  1. per 20 ms frame, who is on screen: the one speaking; when several speak, the one already on screen stays unless
 *     another is `hysteresisDb` louder on its own microphone; simultaneous speech nobody wins for 1.5 s is "several at
 *     once"; after the last speech the speaker stays for `hangoverMs`; a new speaker is on screen 150 ms before their
 *     first speech frame (a soft first syllable is below the speech threshold), never over somebody else's speech;
 *  2. a speaker with less speech than the rhythm's interjection limit leaves the picture with whoever was on screen;
 *  3. "nobody" and "several at once" become a wide scene or hold the last speaker (`fallback`);
 *  4. the shortest scene below the dwell (`effectiveMinDwellMs`) joins its longer neighbour, until none is left.
 * The scene list covers [0, durationMs] with no gaps or overlaps, is deterministic, and no scene is shorter than the
 * dwell unless the whole recording is. With a screen track the layout is always screen-camera with the screen first
 * and only the camera beside it follows the speaker; when no switching can change the picture (one camera, side by
 * side, grid) the result is a single scene.
 */
export function planScenes(tracks: ActivityTrack[], durationMs: number, params: SceneParams, vad: VadOptions = DEFAULT_VAD): Scene[] {
  if (!(durationMs > 0) || tracks.length === 0) return [];
  const screens = tracks.filter((track) => track.kind === "screen");
  const cameras = tracks.filter((track) => track.kind !== "screen");
  const withScreen = screens.length > 0 && cameras.length > 0;
  const fit = params.fit === undefined ? {} : { fit: params.fit };
  const ids = cameras.map((track) => track.id);
  const screenId = screens[0]?.id;
  const whole = (layout: LayoutId, sources: string[]): Scene[] => [{ s: 0, e: durationMs, layout, sources: [...sources], ...fit }];
  // without a screen to feature, screen-camera shows the cameras like a grid
  const baseLayout: LayoutId = params.layout === "screen-camera" && !withScreen ? "grid" : params.layout;

  if (cameras.length === 0) return whole("solo", screens.map((track) => track.id));
  const showsEveryone = !withScreen && (baseLayout === "side-by-side" || baseLayout === "grid");
  if (cameras.length === 1 || showsEveryone) {
    return whole(withScreen ? "screen-camera" : effectiveLayout(baseLayout, cameras.length), withScreen ? [screenId as string, ...ids] : ids);
  }

  const frames = Math.ceil(durationMs / LEVEL_FRAME_MS);
  const levels = cameras.map((track) => track.levels);
  const flags = cameras.map((track, index) => track.speech ?? speechFrames(track.levels, vad, levels.filter((_, other) => other !== index)));
  const labels = labelFrames(flags, levels, frames, params);
  const dwell = effectiveMinDwellMs(params);
  let runs = toRuns(labels);
  runs = absorbInterjections(runs, flags, Math.ceil(RHYTHMS[params.rhythm].ignoreMs / LEVEL_FRAME_MS));
  runs = resolveFallback(runs, params.fallback === "wide" && !withScreen);
  runs = enforceDwell(runs, dwell, durationMs);

  const sceneOf = (run: Run): Scene => {
    const s = run.s * LEVEL_FRAME_MS;
    const e = Math.min(run.e * LEVEL_FRAME_MS, durationMs);
    if (run.label === WIDE) return { s, e, layout: effectiveLayout("grid", cameras.length), sources: [...ids], ...fit };
    const order = [ids[run.label] as string, ...ids.filter((_, index) => index !== run.label)];
    if (withScreen) return { s, e, layout: "screen-camera", sources: [screenId as string, ...order], ...fit };
    return { s, e, layout: effectiveLayout(baseLayout, cameras.length), sources: order, ...fit };
  };
  return mergeScenes(runs.map(sceneOf));
}

// ---- reading and carrying scenes ----------------------------------------------------------------------------------------

/** The scene at `ms` (a boundary belongs to the scene that starts there); before the first or at/after the end it is the first or last scene. Null for an empty list. */
export function sceneAt(scenes: Scene[], ms: number): Scene | null {
  if (scenes.length === 0) return null;
  let low = 0;
  let high = scenes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((scenes[mid] as Scene).s <= ms) low = mid;
    else high = mid - 1;
  }
  return scenes[low] as Scene;
}

/**
 * The scenes on the output timeline of an edit decision list: scenes inside a removed range disappear, the others lose
 * the removed time, neighbours that now show the same thing merge. A scene that a cut makes shorter than the dwell stays.
 */
export function remapScenes(scenes: Scene[], edl: Edl): Scene[] {
  const mapped: Scene[] = [];
  for (const scene of scenes) {
    const s = toOutput(edl, scene.s);
    const e = toOutput(edl, scene.e);
    if (e > s) mapped.push({ ...scene, s, e, sources: [...scene.sources] });
  }
  return mergeScenes(mapped);
}

// ---- manual edits over the automatic scenes -----------------------------------------------------------------------------

/** What to change for a time range. A field left out keeps what the automatic plan (or an earlier override) says. */
export interface SceneOverride {
  s: number;
  e: number;
  layout?: LayoutId;
  sources?: string[];
  fit?: Fit;
}

/**
 * The automatic scenes with the overrides on top. Overrides apply in order, so a later one wins where they overlap. Scenes
 * are split at the edges of an override (clipped to the span of `auto`); the result is sorted, gap-free over the same
 * span, and neighbours that show the same thing are merged (also across an override edge that changes nothing).
 */
export function applyOverrides(auto: Scene[], overrides: SceneOverride[]): Scene[] {
  const first = auto[0];
  const last = auto[auto.length - 1];
  if (!first || !last) return [];
  const edits = overrides
    .map((override) => ({ ...override, s: Math.max(first.s, Math.round(override.s)), e: Math.min(last.e, Math.round(override.e)) }))
    .filter((override) => override.e > override.s);
  if (edits.length === 0) return mergeScenes(auto);
  const points = new Set<number>([first.s, last.e]);
  for (const scene of auto) points.add(scene.s);
  for (const edit of edits) {
    points.add(edit.s);
    points.add(edit.e);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out: Scene[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const s = sorted[index] as number;
    const e = sorted[index + 1] as number;
    const base = sceneAt(auto, s) as Scene;
    const scene: Scene = { s, e, layout: base.layout, sources: [...base.sources], ...(base.fit === undefined ? {} : { fit: base.fit }) };
    for (const edit of edits) {
      if (edit.s > s || edit.e < e) continue;
      if (edit.layout !== undefined) scene.layout = edit.layout;
      if (edit.sources !== undefined) scene.sources = [...edit.sources];
      if (edit.fit !== undefined) scene.fit = edit.fit;
    }
    out.push(scene);
  }
  return mergeScenes(out);
}

export interface ScenePlan {
  params: SceneParams;
  /** In the order they were made: later ones win. */
  overrides: SceneOverride[];
}

export const newPlan = (params: SceneParams = DEFAULT_SCENE_PARAMS): ScenePlan => ({ params, overrides: [] });

const sameOverride = (a: SceneOverride, b: SceneOverride): boolean =>
  a.s === b.s && a.e === b.e && a.layout === b.layout && a.fit === b.fit && (a.sources === undefined ? b.sources === undefined : b.sources !== undefined && sameSources(a.sources, b.sources));

/** An earlier override that a later one covers entirely and overwrites in every field it sets no longer matters. */
const shadowed = (earlier: SceneOverride, later: SceneOverride): boolean =>
  later.s <= earlier.s && earlier.e <= later.e && (earlier.layout === undefined || later.layout !== undefined) && (earlier.sources === undefined || later.sources !== undefined) && (earlier.fit === undefined || later.fit !== undefined);

/** Adds an override on top of the others. Times are rounded to whole ms; an empty range changes nothing; overrides the new one fully replaces are dropped. */
export function addOverride(plan: ScenePlan, override: SceneOverride): ScenePlan {
  const next: SceneOverride = { s: Math.round(override.s), e: Math.round(override.e) };
  if (!(next.e > next.s)) return plan;
  if (override.layout !== undefined) next.layout = override.layout;
  if (override.sources !== undefined) next.sources = [...override.sources];
  if (override.fit !== undefined) next.fit = override.fit;
  return { params: plan.params, overrides: [...plan.overrides.filter((earlier) => !shadowed(earlier, next)), next] };
}

export function removeOverrideAt(plan: ScenePlan, index: number): ScenePlan {
  if (!Number.isInteger(index) || index < 0 || index >= plan.overrides.length) return plan;
  return { params: plan.params, overrides: plan.overrides.filter((_, at) => at !== index) };
}

export function clearOverrides(plan: ScenePlan): ScenePlan {
  return plan.overrides.length === 0 ? plan : { params: plan.params, overrides: [] };
}

/** Changes some parameters of the automatic plan (the overrides stay). */
export function setParams(plan: ScenePlan, patch: Partial<SceneParams>): ScenePlan {
  const params = { ...plan.params, ...patch };
  return sameParams(plan.params, params) ? plan : { params, overrides: plan.overrides };
}

const sameParams = (a: SceneParams, b: SceneParams): boolean =>
  a.minDwellMs === b.minDwellMs && a.hysteresisDb === b.hysteresisDb && a.hangoverMs === b.hangoverMs && a.rhythm === b.rhythm && a.layout === b.layout && a.fit === b.fit && a.fallback === b.fallback;

export const samePlan = (a: ScenePlan, b: ScenePlan): boolean =>
  sameParams(a.params, b.params) && a.overrides.length === b.overrides.length && a.overrides.every((override, index) => sameOverride(override, b.overrides[index] as SceneOverride));

// ---- history ------------------------------------------------------------------------------------------------------------

export interface PlanHistory {
  past: ScenePlan[];
  present: ScenePlan;
  future: ScenePlan[];
}

export const newPlanHistory = (present: ScenePlan = newPlan()): PlanHistory => ({ past: [], present, future: [] });

/** Makes `next` the present plan. A no-op change is not recorded. */
export function commitPlan(history: PlanHistory, next: ScenePlan): PlanHistory {
  if (samePlan(history.present, next)) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoPlan(history: PlanHistory): PlanHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redoPlan(history: PlanHistory): PlanHistory {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}
