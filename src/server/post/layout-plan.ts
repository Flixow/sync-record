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

/** The microphone track of a participant: the audio-only source, or any source that carries audio. */
function microphoneOf(project: ProjectFile, participantId: string): ProjectSource | null {
  const own = project.sources.filter((source) => source.participantId === participantId && source.audio !== null);
  return own.find((source) => source.kind === "audio") ?? own[0] ?? null;
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
    const mic = microphoneOf(project, owner.participantId);
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
