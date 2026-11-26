// A scene plan suggested from small per-segment summaries (never raw video): the automatic scenes are grouped into a few
// dozen segments, each described by the transcript text and a handful of numbers, and a model (or nothing) picks a layout
// per segment. The result is plain `SceneOverride`s, which the editor already shows, edits and undoes like manual ones.
// Pure functions; the model call lives in src/server/post/llm.ts and a missing or failing model means "no overrides".

import { LAYOUT_IDS, type LayoutId } from "./layout.js";
import { trimTo } from "./lexicon.js";
import { LEVEL_FRAME_MS } from "./project.js";
import type { ActivityTrack, Scene, SceneOverride } from "./scenes.js";
import type { TranscriptWord } from "./transcript.js";
import { DEFAULT_VAD, speechFrames } from "./vad.js";

/** At most this many segments are described to the model, however long the recording is. */
export const MAX_SEGMENTS = 48;
/** A segment is at least this long, unless the whole recording is shorter. */
export const MIN_SEGMENT_MS = 20_000;
const TEXT_HEAD_CHARS = 170;
const TEXT_TAIL_CHARS = 100;
const REASON_CHARS = 120;

export interface SegmentSignals {
  /** Share of the segment in which at least one microphone has speech, 0 to 100. */
  speechPct: number;
  /** Share of the segment in which two or more microphones have speech at once. */
  overlapPct: number;
  /** Share in which nobody speaks. */
  silencePct: number;
  /** Mean level in dBFS of the loudest speaking microphone over the speech frames; null without speech. */
  energyDb: number | null;
  /** How many times the speaker changes in the transcript of the segment. */
  turns: number;
  /** A screen share is on screen in the segment. The recording has no measure of motion on it, so this is presence only. */
  screenShare: boolean;
}

export interface PlanSegment {
  i: number;
  /** ms on the project timeline. */
  s: number;
  e: number;
  /** The automatic scenes of the segment are `scenes[first..last)`. */
  first: number;
  last: number;
  /** The layout the automatic plan has for most of the segment. */
  layout: LayoutId;
  /** The layouts the segment's pictures can fill. */
  allowed: LayoutId[];
  signals: SegmentSignals;
  /** The transcript of the segment, shortened to its beginning and end. */
  text: string;
}

export interface SegmentOptions {
  maxSegments?: number;
  minSegmentMs?: number;
}

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/** Groups consecutive scenes into segments of about `duration / maxSegments`, at least `minSegmentMs`, cut only at scene boundaries. */
function groupScenes(scenes: Scene[], options: SegmentOptions): { first: number; last: number }[] {
  const total = (scenes[scenes.length - 1]?.e ?? 0) - (scenes[0]?.s ?? 0);
  const target = Math.max(options.minSegmentMs ?? MIN_SEGMENT_MS, total / (options.maxSegments ?? MAX_SEGMENTS));
  const groups: { first: number; last: number }[] = [];
  let first = 0;
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index] as Scene;
    if (scene.e - (scenes[first] as Scene).s >= target) {
      groups.push({ first, last: index + 1 });
      first = index + 1;
    }
  }
  if (first < scenes.length) {
    const tail = { first, last: scenes.length };
    const previous = groups[groups.length - 1];
    // a leftover shorter than half a segment joins the one before it
    if (previous && (scenes[scenes.length - 1] as Scene).e - (scenes[first] as Scene).s < target / 2) previous.last = tail.last;
    else groups.push(tail);
  }
  return groups;
}

/** The layouts that make sense for `cameras` pictures and, when `screen`, a screen share. */
export function allowedLayouts(cameras: number, screen: boolean): LayoutId[] {
  if (cameras === 0) return ["solo"];
  const allowed: LayoutId[] = ["solo"];
  if (cameras >= 2) allowed.push("side-by-side", "speaker-thumbs");
  if (cameras >= 3) allowed.push("grid");
  if (screen) allowed.push("screen-camera");
  return allowed;
}

function textOf(words: TranscriptWord[]): string {
  const text = words.map((word) => word.t).join(" ").replace(/\s+/g, " ").trim();
  return text.length <= TEXT_HEAD_CHARS + TEXT_TAIL_CHARS + 5 ? text : `${trimTo(text, TEXT_HEAD_CHARS)} [...] ${text.slice(-TEXT_TAIL_CHARS).replace(/^\S*\s/u, "")}`;
}

/**
 * Segments of the automatic scenes with their signals. Empty when there are no scenes. The words are those of the project
 * timeline; the tracks are the same as `planScenes` took (a camera's microphone levels, a screen track without levels).
 */
export function planSegments(scenes: Scene[], tracks: ActivityTrack[], words: TranscriptWord[], options: SegmentOptions = {}): PlanSegment[] {
  if (scenes.length === 0) return [];
  const cameras = tracks.filter((track) => track.kind !== "screen");
  const screens = new Set(tracks.filter((track) => track.kind === "screen").map((track) => track.id));
  const levels = cameras.map((track) => track.levels);
  const flags = cameras.map((track, index) => track.speech ?? speechFrames(track.levels, DEFAULT_VAD, levels.filter((_, other) => other !== index)));
  return groupScenes(scenes, options).map((group, i) => {
    const members = scenes.slice(group.first, group.last);
    const s = (members[0] as Scene).s;
    const e = (members[members.length - 1] as Scene).e;
    const from = Math.floor(s / LEVEL_FRAME_MS);
    const to = Math.ceil(e / LEVEL_FRAME_MS);
    let speech = 0;
    let overlap = 0;
    let energy = 0;
    for (let frame = from; frame < to; frame++) {
      let speaking = 0;
      let loudest = -Infinity;
      for (let index = 0; index < cameras.length; index++) {
        if ((flags[index] as Uint8Array)[frame] !== 1) continue;
        speaking++;
        loudest = Math.max(loudest, (levels[index] as Int8Array)[frame] ?? -Infinity);
      }
      if (speaking > 0) {
        speech++;
        energy += Number.isFinite(loudest) ? loudest : 0;
      }
      if (speaking > 1) overlap++;
    }
    const frames = Math.max(1, to - from);
    const inside = words.filter((word) => word.s >= s && word.s < e);
    let turns = 0;
    for (let index = 1; index < inside.length; index++) if ((inside[index] as TranscriptWord).pid !== (inside[index - 1] as TranscriptWord).pid) turns++;
    const screenShare = members.some((scene) => scene.sources.some((id) => screens.has(id)));
    const cameraCount = Math.max(...members.map((scene) => scene.sources.filter((id) => !screens.has(id)).length));
    // the layout most of the segment has now
    const weight = new Map<LayoutId, number>();
    for (const scene of members) weight.set(scene.layout, (weight.get(scene.layout) ?? 0) + scene.e - scene.s);
    const layout = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "solo";
    return {
      i,
      s,
      e,
      first: group.first,
      last: group.last,
      layout,
      allowed: allowedLayouts(cameraCount, screenShare),
      signals: { speechPct: pct(speech, frames), overlapPct: pct(overlap, frames), silencePct: 100 - pct(speech, frames), energyDb: speech === 0 ? null : Math.round(energy / speech), turns, screenShare },
      text: textOf(inside),
    };
  });
}

/** What the model may suggest for a segment; `layout` is checked against the segment's allowed layouts. */
export interface SegmentChoice {
  i: number;
  layout?: LayoutId;
  /** Why this stretch is worth featuring, or why it could go; advisory only. */
  highlight?: string;
  cut?: string;
}

const cleanReason = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = trimTo(value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim(), REASON_CHARS);
  return text === "" ? undefined : text;
};

const fieldOf = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

/**
 * The usable part of a model's answer `{"segments":[{"i":0,"layout":"solo","highlight":"…","cut":"…"}]}`. Entries naming an
 * unknown segment, saying nothing usable, or repeating a segment already taken are skipped one by one (a layout the segment cannot show is dropped, the rest of the entry stays); null when the answer
 * has the wrong shape or nothing usable is left.
 */
export function parseSegmentChoices(answer: unknown, segments: PlanSegment[]): SegmentChoice[] | null {
  const entries = fieldOf(answer, "segments");
  if (!Array.isArray(entries)) return null;
  const seen = new Set<number>();
  const choices: SegmentChoice[] = [];
  for (const entry of entries as unknown[]) {
    const i = fieldOf(entry, "i");
    const segment = typeof i === "number" && Number.isInteger(i) ? segments[i] : undefined;
    if (!segment || seen.has(segment.i)) continue;
    const layout = fieldOf(entry, "layout");
    const choice: SegmentChoice = { i: segment.i };
    if (typeof layout === "string" && (LAYOUT_IDS as readonly string[]).includes(layout) && segment.allowed.includes(layout as LayoutId)) choice.layout = layout as LayoutId;
    const highlight = cleanReason(fieldOf(entry, "highlight"));
    const cut = cleanReason(fieldOf(entry, "cut"));
    if (highlight !== undefined) choice.highlight = highlight;
    if (cut !== undefined && highlight === undefined) choice.cut = cut;
    if (choice.layout === undefined && choice.highlight === undefined && choice.cut === undefined) continue;
    seen.add(segment.i);
    choices.push(choice);
  }
  return choices.length > 0 ? choices : null;
}

/**
 * The overrides that put the chosen layouts on the segments, one per automatic scene whose picture changes (so the active
 * speaker keeps leading inside a segment). A layout without the screen drops the screen from the scene's sources.
 */
export function overridesFor(scenes: Scene[], segments: PlanSegment[], choices: SegmentChoice[], screenIds: ReadonlySet<string>): SceneOverride[] {
  const overrides: SceneOverride[] = [];
  for (const choice of choices) {
    const segment = segments[choice.i];
    if (!segment || choice.layout === undefined) continue;
    for (const scene of scenes.slice(segment.first, segment.last)) {
      const sources = choice.layout === "screen-camera" ? scene.sources : scene.sources.filter((id) => !screenIds.has(id));
      if (scene.layout === choice.layout && sources.length === scene.sources.length) continue;
      overrides.push({ s: scene.s, e: scene.e, layout: choice.layout, ...(sources.length === scene.sources.length ? {} : { sources }) });
    }
  }
  return overrides;
}

/** A stretch of the timeline the plan points at; advisory, never applied by itself. */
export interface Span {
  s: number;
  e: number;
  reason: string;
}

/** Highlight and cut suggestions of the model, as spans of the segments they name. */
export function spansFor(segments: PlanSegment[], choices: SegmentChoice[]): { highlights: Span[]; cuts: Span[] } {
  const highlights: Span[] = [];
  const cuts: Span[] = [];
  for (const choice of choices) {
    const segment = segments[choice.i];
    if (!segment) continue;
    if (choice.highlight !== undefined) highlights.push({ s: segment.s, e: segment.e, reason: choice.highlight });
    if (choice.cut !== undefined) cuts.push({ s: segment.s, e: segment.e, reason: choice.cut });
  }
  return { highlights, cuts };
}

/** The prompt body: one line per segment with its numbers and text. */
export function describeSegments(segments: PlanSegment[]): string {
  const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  return segments
    .map((segment) => {
      const g = segment.signals;
      const numbers = `speech ${g.speechPct}%, overlap ${g.overlapPct}%, silence ${g.silencePct}%, energy ${g.energyDb === null ? "n/a" : `${g.energyDb} dB`}, turns ${g.turns}, screen share ${g.screenShare ? "yes" : "no"}`;
      return `#${segment.i} ${clock(segment.s)}-${clock(segment.e)} | now: ${segment.layout} | allowed: ${segment.allowed.join(", ")} | ${numbers}\n"${segment.text}"`;
    })
    .join("\n\n");
}
