import { cardParticipantId, type LayoutId } from "./layout.js";
import { LEVEL_FLOOR_DB, LEVEL_FRAME_MS, PEAKS_PER_SECOND, type ProjectFile, type ProjectSource } from "./project.js";
import { sceneAt, type Scene, type SceneOverride } from "./scenes.js";
import { DEFAULT_VAD, speechFrames } from "./vad.js";

export interface Span {
  s: number;
  e: number;
}

export interface ParticipantLanes {
  participantId: string;
  name: string;
  /** Level files of the participant's microphone tracks, one per segment. */
  audio: string[];
  camera: Span[];
  screen: Span[];
}

export const MIN_SELECTION_MS = 200;
export const SNAP_MS = 100;
export const MAX_PX_PER_SEC = 240;
const PEAK_MS = 1000 / PEAKS_PER_SECOND;
const BAR_RANGE_DB = 50;
const BAR_FLOOR_DB = -60;
const SOUND_GAP_MS = 300;
const SOUND_MIN_MS = 120;
const TICK_STEPS_SEC = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MIN_TICK_PX = 84;

const spanOf = (source: ProjectSource): Span => ({ s: source.offsetMs, e: source.offsetMs + source.timelineDurationMs });

/** One entry per participant of the recording, in the order the project lists them, with what each recorded. */
export function participantLanes(project: ProjectFile): ParticipantLanes[] {
  const known = new Map(project.participants.map((participant) => [participant.id, participant.name]));
  const order = [...new Set([...project.participants.map((participant) => participant.id), ...project.sources.map((source) => source.participantId)])];
  const lanes: ParticipantLanes[] = [];
  for (const participantId of order) {
    const own = project.sources.filter((source) => source.participantId === participantId);
    const lane: ParticipantLanes = {
      participantId,
      name: known.get(participantId) ?? own[0]?.participantName ?? participantId,
      audio: own.filter((source) => source.kind !== "screen" && source.audio !== null).map((source) => (source.audio as NonNullable<ProjectSource["audio"]>).levels),
      camera: own.filter((source) => source.kind === "camera" && source.hasVideo).map(spanOf),
      screen: own.filter((source) => source.kind === "screen" && source.hasVideo).map(spanOf),
    };
    if (lane.audio.length > 0 || lane.camera.length > 0 || lane.screen.length > 0) lanes.push(lane);
  }
  return lanes;
}

/** The participant a scene source belongs to: the owner of a camera or screen, the participant of a name card. */
export function sourceOwner(project: ProjectFile, sourceId: string): string | null {
  return cardParticipantId(sourceId) ?? project.sources.find((source) => source.id === sourceId)?.participantId ?? null;
}

export interface SoundRun extends Span {
  /** Index into the participant list given to `soundRuns`. */
  who: number;
}

/**
 * Who carries the sound at every moment: per 20 ms the participant with the loudest microphone among those the voice
 * detector hears speaking (`levels` are the lifted level tracks, one per participant).
 * Neighbouring frames of one participant join, gaps under 300 ms between two runs of the same one are closed, and runs under 120 ms are dropped.
 */
export function soundRuns(levels: Int8Array[], durationMs: number): SoundRun[] {
  const frames = Math.ceil(durationMs / LEVEL_FRAME_MS);
  const speaking = levels.map((own, who) =>
    speechFrames(
      own,
      DEFAULT_VAD,
      levels.filter((_, other) => other !== who),
    ),
  );
  const owner = new Int16Array(frames).fill(-1);
  for (let frame = 0; frame < frames; frame++) {
    let loudest = LEVEL_FLOOR_DB;
    for (let who = 0; who < levels.length; who++) {
      const value = (levels[who] as Int8Array)[frame] ?? LEVEL_FLOOR_DB;
      if ((speaking[who] as Uint8Array)[frame] === 1 && value > loudest) {
        loudest = value;
        owner[frame] = who;
      }
    }
  }
  const runs: SoundRun[] = [];
  let start = 0;
  for (let frame = 1; frame <= frames; frame++) {
    if (frame < frames && owner[frame] === owner[start]) continue;
    const who = owner[start] as number;
    if (who >= 0) runs.push({ s: start * LEVEL_FRAME_MS, e: frame * LEVEL_FRAME_MS, who });
    start = frame;
  }
  const joined: SoundRun[] = [];
  for (const run of runs) {
    const last = joined[joined.length - 1];
    if (last && last.who === run.who && run.s - last.e <= SOUND_GAP_MS) last.e = run.e;
    else joined.push({ ...run });
  }
  return joined.filter((run) => run.e - run.s >= SOUND_MIN_MS);
}

/** The loudest of several level tracks per frame (a participant who recorded in several segments is one voice). */
export function combineLevels(tracks: Int8Array[]): Int8Array {
  const out = new Int8Array(tracks.reduce((max, track) => Math.max(max, track.length), 0)).fill(LEVEL_FLOOR_DB);
  for (const track of tracks) for (let frame = 0; frame < track.length; frame++) if ((track[frame] as number) > (out[frame] as number)) out[frame] = track[frame] as number;
  return out;
}

/** A level track as bars of 10 ms for `windowColumns`: 0 at -60 dB, 255 at -10 dB. */
export function levelBars(levels: Int8Array): Uint8Array {
  const bars = new Uint8Array(levels.length * 2);
  for (let frame = 0; frame < levels.length; frame++) {
    const bar = Math.round((255 * ((levels[frame] as number) - BAR_FLOOR_DB)) / BAR_RANGE_DB);
    bars[frame * 2] = bars[frame * 2 + 1] = Math.max(0, Math.min(255, bar));
  }
  return bars;
}

/** The loudest bar of `peaks` in each of `width` equal parts of [startMs, endMs). */
export function windowColumns(peaks: Uint8Array, startMs: number, endMs: number, width: number): Uint8Array {
  const columns = new Uint8Array(Math.max(0, width));
  if (width <= 0 || endMs <= startMs) return columns;
  const perColumn = (endMs - startMs) / width / PEAK_MS;
  const first = startMs / PEAK_MS;
  for (let x = 0; x < width; x++) {
    const from = Math.max(0, Math.floor(first + x * perColumn));
    const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil(first + (x + 1) * perColumn)));
    let max = 0;
    for (let index = from; index < to; index++) if ((peaks[index] as number) > max) max = peaks[index] as number;
    columns[x] = max;
  }
  return columns;
}

/** The zoom at which the whole recording fills `viewportPx`. */
export const fitPxPerSec = (durationMs: number, viewportPx: number): number => (durationMs <= 0 ? 1 : (viewportPx * 1000) / durationMs);

export const clampZoom = (pxPerSec: number, durationMs: number, viewportPx: number): number => Math.min(MAX_PX_PER_SEC, Math.max(fitPxPerSec(durationMs, viewportPx), pxPerSec));

export const msToPx = (ms: number, pxPerSec: number): number => (ms / 1000) * pxPerSec;
export const pxToMs = (px: number, pxPerSec: number): number => (px / pxPerSec) * 1000;

/** Distance in ms between ruler ticks that are at least a readable distance apart at this zoom. */
export function tickStepMs(pxPerSec: number): number {
  const step = TICK_STEPS_SEC.find((seconds) => seconds * pxPerSec >= MIN_TICK_PX) ?? (TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1] as number);
  return step * 1000;
}

const snap = (ms: number): number => Math.round(ms / SNAP_MS) * SNAP_MS;

/** The range a drag from `fromMs` to `toMs` selects: ordered, snapped, inside the recording; null when shorter than the minimum. */
export function dragRange(fromMs: number, toMs: number, durationMs: number): Span | null {
  const a = Math.min(Math.max(0, snap(Math.min(fromMs, toMs))), durationMs);
  const b = Math.min(Math.max(0, snap(Math.max(fromMs, toMs))), durationMs);
  return b - a >= MIN_SELECTION_MS ? { s: a, e: b } : null;
}

/** The scene under `ms` as a range, or null outside the scenes. */
export function sceneRange(scenes: Scene[], ms: number): Span | null {
  const scene = sceneAt(scenes, ms);
  return scene ? { s: scene.s, e: scene.e } : null;
}

/** The scenes that overlap a range. */
export const scenesIn = (scenes: Scene[], range: Span): Scene[] => scenes.filter((scene) => scene.s < range.e && scene.e > range.s);

/** What the scenes of a range have in common: a value when all agree, null when they differ or there is none. */
export function commonOf<T>(scenes: Scene[], pick: (scene: Scene) => T): T | null {
  const first = scenes[0];
  if (!first) return null;
  const value = pick(first);
  return scenes.every((scene) => pick(scene) === value) ? value : null;
}

/** The override that puts `sourceId` in front for a range; the other sources of the scene at its start stay behind it. */
export function sourceOverride(scenes: Scene[], range: Span, sourceId: string): SceneOverride {
  const rest = sceneAt(scenes, range.s)?.sources.filter((id) => id !== sourceId) ?? [];
  return { s: range.s, e: range.e, sources: [sourceId, ...rest] };
}

export const layoutOverride = (range: Span, layout: LayoutId): SceneOverride => ({ s: range.s, e: range.e, layout });

/** Whether a manual change touches the range. */
export const touchesOverride = (overrides: SceneOverride[], range: Span): boolean => overrides.some((override) => override.s < range.e && override.e > range.s);
