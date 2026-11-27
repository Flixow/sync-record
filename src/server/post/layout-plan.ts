import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LayoutSource } from "../../shared/layout.js";
import type { ProjectFile, ProjectSource } from "../../shared/project.js";
import { applyOverrides, planScenes, type ActivityTrack, type Scene, type ScenePlan } from "../../shared/scenes.js";

/** Video sources the layouts can show, with the picture size of the original recording. */
export function layoutSources(project: ProjectFile): LayoutSource[] {
  return project.sources
    .filter((source) => source.hasVideo && source.width && source.height && (source.kind === "camera" || source.kind === "screen"))
    .map((source) => ({ id: source.id, kind: source.kind === "screen" ? "screen" : "camera", width: source.width as number, height: source.height as number }));
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

/** Activity of every picture source: a camera is "active" while its owner's microphone has speech. */
export async function activityTracks(project: ProjectFile, dir: string): Promise<ActivityTrack[]> {
  const out: ActivityTrack[] = [];
  for (const source of layoutSources(project)) {
    const owner = project.sources.find((item) => item.id === source.id) as ProjectSource;
    if (source.kind === "screen") {
      out.push({ id: source.id, levels: new Int8Array(0), kind: "screen", range: { s: owner.offsetMs, e: owner.offsetMs + owner.timelineDurationMs } });
      continue;
    }
    const mic = microphoneOf(project, owner);
    if (!mic?.audio) continue;
    const buffer = await readFile(path.join(dir, mic.audio.levels));
    out.push({ id: source.id, levels: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), kind: "camera" });
  }
  return out;
}

/** Scenes of the whole recording on the project timeline: the automatic plan with the manual overrides on top. */
export async function resolveScenes(project: ProjectFile, dir: string, plan: ScenePlan): Promise<Scene[]> {
  const tracks = await activityTracks(project, dir);
  if (tracks.length === 0) return [];
  return applyOverrides(planScenes(tracks, project.durationMs, plan.params), plan.overrides);
}
