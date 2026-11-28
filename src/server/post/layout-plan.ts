import { CARD_SIZE, cardSourceId, type LayoutSource } from "../../shared/layout.js";
import { LEVEL_FLOOR_DB, type ProjectFile, type ProjectSource } from "../../shared/project.js";
import { applyOverrides, planScenes, type ActivityTrack, type Scene, type ScenePlan } from "../../shared/scenes.js";
import { microphoneLevels } from "./mic-levels.js";

const isPicture = (source: ProjectSource): boolean => source.hasVideo && Boolean(source.width) && Boolean(source.height) && (source.kind === "camera" || source.kind === "screen");

/** The pictures of the recording: cameras and screens that have video. */
const pictures = (project: ProjectFile): ProjectSource[] => project.sources.filter(isPicture);

/** A participant who recorded a microphone and no camera, shown as a name card. */
export interface Card {
  /** The source id the scenes use (`cardSourceId`). */
  id: string;
  participantId: string;
  name: string;
  /** The participant's microphone tracks (one per segment). */
  microphones: ProjectSource[];
}

/**
 * The participants with a microphone and without a camera picture, in the order their tracks appear. Empty when the project has no
 * picture at all: an audio-only recording has no video to lay out, so it gets no cards either.
 */
export function cardsOf(project: ProjectFile): Card[] {
  if (pictures(project).length === 0) return [];
  const cards: Card[] = [];
  for (const participantId of new Set(project.sources.map((source) => source.participantId))) {
    const own = project.sources.filter((source) => source.participantId === participantId);
    if (own.some((source) => isPicture(source) && source.kind === "camera")) continue;
    const microphones = own.filter((source) => source.kind === "audio" && source.audio !== null);
    const first = microphones[0];
    if (first) cards.push({ id: cardSourceId(participantId), participantId, name: first.participantName, microphones });
  }
  return cards;
}

/** Sources the layouts can show: the video sources with the picture size of the original recording, then a name card for each microphone-only participant. */
export function layoutSources(project: ProjectFile): LayoutSource[] {
  const shown = pictures(project).map((source): LayoutSource => ({ id: source.id, kind: source.kind === "screen" ? "screen" : "camera", width: source.width as number, height: source.height as number }));
  return [...shown, ...cardsOf(project).map((card): LayoutSource => ({ id: card.id, kind: "card", width: CARD_SIZE.width, height: CARD_SIZE.height }))];
}

/** Milliseconds two sources are both recording on the project timeline. */
const overlapMs = (a: ProjectSource, b: ProjectSource): number => Math.max(0, Math.min(a.offsetMs + a.timelineDurationMs, b.offsetMs + b.timelineDurationMs) - Math.max(a.offsetMs, b.offsetMs));

/**
 * The microphone that belongs to a picture source. A participant who records several takes or segments has one microphone
 * per segment, and the camera of segment 2 is spoken over by the microphone of segment 2, not segment 1. Of the owner's
 * audio tracks: one recording at the same time as the picture beats one that does not, then the audio-only track, then
 * the longest time together, then the same segment number.
 */
export function microphoneOf(project: ProjectFile, picture: ProjectSource): ProjectSource | null {
  const rank = (source: ProjectSource): number[] => {
    const together = overlapMs(source, picture);
    return [together > 0 ? 1 : 0, source.kind === "audio" ? 1 : 0, together, source.segment === picture.segment ? 1 : 0];
  };
  const later = (a: number[], b: number[]): boolean => {
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return (a[index] as number) > (b[index] as number);
    return false;
  };
  let best: ProjectSource | null = null;
  let bestRank: number[] = [];
  for (const source of project.sources) {
    if (source.participantId !== picture.participantId || source.audio === null) continue;
    const next = rank(source);
    if (best === null || later(next, bestRank)) {
      best = source;
      bestRank = next;
    }
  }
  return best;
}

/** Per 20 ms frame the loudest of several level tracks (a participant who recorded in several segments is one voice). */
function loudest(tracks: Int8Array[]): Int8Array {
  const first = tracks[0];
  if (tracks.length === 1 && first) return first;
  const out = new Int8Array(Math.max(0, ...tracks.map((track) => track.length))).fill(LEVEL_FLOOR_DB);
  for (const track of tracks) for (let frame = 0; frame < track.length; frame++) if ((track[frame] as number) > (out[frame] as number)) out[frame] = track[frame] as number;
  return out;
}

/**
 * Activity of every source the scenes can feature: a camera is "active" while its owner's microphone has speech, a name
 * card while the microphone of its participant has speech, a screen is a picture only.
 */
export async function activityTracks(project: ProjectFile, dir: string): Promise<ActivityTrack[]> {
  const { levels: byId } = await microphoneLevels(project, dir);
  const levelsOf = (source: ProjectSource | undefined): Int8Array => (source ? byId.get(source.id) : undefined) ?? new Int8Array(0);
  const out: ActivityTrack[] = [];
  for (const source of pictures(project)) {
    if (source.kind === "screen") {
      out.push({ id: source.id, levels: new Int8Array(0), kind: "screen", range: { s: source.offsetMs, e: source.offsetMs + source.timelineDurationMs } });
      continue;
    }
    const mic = microphoneOf(project, source);
    if (!mic?.audio) continue;
    out.push({ id: source.id, levels: levelsOf(mic), kind: "camera" });
  }
  for (const card of cardsOf(project)) {
    out.push({ id: card.id, levels: loudest(card.microphones.map(levelsOf)), kind: "camera" });
  }
  return out;
}

/** Scenes of the whole recording on the project timeline: the automatic plan with the manual overrides on top. */
export async function resolveScenes(project: ProjectFile, dir: string, plan: ScenePlan): Promise<Scene[]> {
  const tracks = await activityTracks(project, dir);
  if (tracks.length === 0) return [];
  return applyOverrides(planScenes(tracks, project.durationMs, plan.params), plan.overrides);
}
