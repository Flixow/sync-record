// The shorts agent: a language model cuts the clips instead of the rules of src/shared/clips.ts. One request per call, made
// only when the host configured a model and the user asked for it. Only the transcript text and its timings are sent (see
// buildShortsPrompt: speakers are "S1", "S2", never names); never audio, video or frames. The answer is only a proposal:
// validateReels (src/shared/shorts.ts) decides what becomes a clip. Every failure ends as `{ clips: [], failure }` so the
// caller can fall back on the rules and say why.

import type { ClipSuggestion } from "../../shared/clips.js";
import { buildShortsPrompt, validateReels, type ShortsCompression, type ShortsInput } from "../../shared/shorts.js";
import { DEFAULT_SHORTS_TIMEOUT_MS, type LlmClient } from "./llm.js";

/** Room for the model's thinking (Opus thinks before it answers) and for a list of up to ten reels. */
const MAX_ANSWER_TOKENS = 12_000;

export interface AgentClipsInput extends ShortsInput {
  /** Timeout of the call. 120000 */
  timeoutMs?: number;
}

export interface AgentClipsResult {
  /** The reels that can be cut, best first; empty on any failure. */
  clips: ClipSuggestion[];
  /** Null when `clips` is not empty. "disabled", "no_speech", a failure code of the client ("http_401", "timeout", "not_json", ...), "bad_shape" (no list of reels in the answer) or "no_valid_reels". */
  failure: string | null;
  /** How much the transcript was shortened to fit the prompt budget; "none" for most recordings. */
  compression: ShortsCompression;
}

/** Asks the model for the reels of a recording. Never throws and never makes a request when the model is off or there is no speech. */
export async function agentClips(llm: LlmClient, input: AgentClipsInput): Promise<AgentClipsResult> {
  if (!llm.enabled) return { clips: [], failure: "disabled", compression: "none" };
  const prompt = buildShortsPrompt(input);
  if (prompt === null) return { clips: [], failure: "no_speech", compression: "none" };
  const answer = await llm.rank({ system: prompt.system, user: prompt.user, maxTokens: MAX_ANSWER_TOKENS, timeoutMs: input.timeoutMs ?? DEFAULT_SHORTS_TIMEOUT_MS }).catch(() => null);
  if (answer === null) return { clips: [], failure: llm.lastFailure ?? "failed", compression: prompt.compression };
  const checked = validateReels(answer, input);
  if (checked.clips.length === 0) return { clips: [], failure: checked.shapeOk ? "no_valid_reels" : "bad_shape", compression: prompt.compression };
  return { clips: checked.clips, failure: null, compression: prompt.compression };
}
