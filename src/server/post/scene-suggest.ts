import { readFile } from "node:fs/promises";
import path from "node:path";
import { suggestClips } from "../../shared/clips.js";
import { planSegments, overridesFor, spansFor, type Span } from "../../shared/scene-plan.js";
import type { SceneOverride } from "../../shared/scenes.js";
import { DEFAULT_SILENCE, detectSilences } from "../../shared/silence.js";
import { HttpError } from "../errors.js";
import { languageOf, speakerLevels, transcriptOf } from "./api-publish.js";
import type { PostProduction } from "./index.js";
import { activityTracks, resolveScenes } from "./layout-plan.js";
import { createLlmClient, llmScenePlan } from "./llm.js";
import { readScenes } from "./scenes-store.js";

/** The rule-based fallback only points at silences at least this long as "could go". */
const LONG_SILENCE_MS = 4000;
const MAX_RULE_CUTS = 10;
const MAX_RULE_HIGHLIGHTS = 3;

export interface SceneSuggestion {
  /** "llm": the model chose the layouts; "rules": no model (or it failed), so there are no overrides and the lists come from rules. */
  source: "llm" | "rules";
  llmAvailable: boolean;
  /** Short code of why a requested model did not answer; null otherwise. */
  llmFailure: string | null;
  /** How many segments were described to the model (0 on the rules path). */
  segments: number;
  /** Plain scene overrides, ready for the editor's own undo history. Empty on the rules path. */
  overrides: SceneOverride[];
  /** Stretches worth featuring and stretches that could go; advisory, nothing is applied. `reason` is free text from the model, or a code on the rules path. */
  highlights: Span[];
  cuts: Span[];
}

/**
 * A scene plan suggestion for a project. Never changes the project: the host's browser applies the overrides to its own
 * (undoable, hand-editable) plan. With no model, a failing model or an unusable answer the plan stays as the rules made it.
 */
export async function suggestScenePlan(post: PostProduction, sid: string, useModel: boolean): Promise<SceneSuggestion> {
  const project = await post.store.require(sid);
  const dir = post.store.dir(sid);
  const transcript = await transcriptOf(post, sid);
  const file = await readScenes(dir);
  const notPrepared = (error: unknown): never => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, "not_prepared");
    throw error;
  };
  const scenes = await resolveScenes(project, dir, file.plan).catch(notPrepared);
  const tracks = await activityTracks(project, dir).catch(notPrepared);
  const llmAvailable = post.config.post.llm !== null;
  const llm = createLlmClient(useModel ? post.config.post.llm : null);
  const segments = planSegments(scenes, tracks, transcript.words);
  const choices = llm.enabled ? await llmScenePlan(llm, segments) : null;
  if (choices !== null) {
    const screens = new Set(tracks.filter((track) => track.kind === "screen").map((track) => track.id));
    return { source: "llm", llmAvailable, llmFailure: null, segments: segments.length, overrides: overridesFor(scenes, segments, choices, screens), ...spansFor(segments, choices) };
  }

  // rules: long dead air as cuts, the best clip suggestions as highlights
  const levels: Int8Array[] = [];
  for (const source of project.sources) {
    if (!source.audio) continue;
    levels.push(new Int8Array(await readFile(path.join(dir, source.audio.levels)).then((buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), notPrepared)));
  }
  const cuts = detectSilences(levels, project.durationMs, DEFAULT_SILENCE)
    .filter((silence) => silence.endMs - silence.startMs >= LONG_SILENCE_MS)
    .slice(0, MAX_RULE_CUTS)
    .map((silence): Span => ({ s: silence.startMs, e: silence.endMs, reason: "silence" }));
  const clips = suggestClips({ words: transcript.words, levels: await speakerLevels(project, dir), highlights: project.highlights.map((h) => ({ tMs: h.atMs })), durationMs: project.durationMs, limit: MAX_RULE_HIGHLIGHTS }, { lang: languageOf(transcript) });
  const highlights = clips.map((clip): Span => ({ s: clip.s, e: clip.e, reason: clip.reasons[0] ?? "complete-thought" }));
  return { source: "rules", llmAvailable, llmFailure: llm.enabled ? (llm.lastFailure ?? "bad_answer") : null, segments: 0, overrides: [], highlights, cuts };
}
