import type { Chapter, ChapterIssue } from "../../shared/chapters.js";
import type { ClipProject, ClipSuggestion } from "../../shared/clips.js";
import type { Edl, Range } from "../../shared/edl.js";
import type { Aspect, Background, LayoutSource } from "../../shared/layout.js";
import type { JobRecord, ProjectFile } from "../../shared/project.js";
import type { PublishDraft, ThumbnailKind, ThumbnailSpec } from "../../shared/publish.js";
import type { Span } from "../../shared/scene-plan.js";
import type { Scene, SceneOverride, ScenePlan } from "../../shared/scenes.js";
import type { Silence } from "../../shared/silence.js";
import type { TranscriptFile } from "../../shared/transcript.js";
import { ApiError } from "./api.js";

export interface ProjectState {
  project: ProjectFile;
  jobs: JobRecord[];
  disk: { freeBytes: number | null; minFreeBytes: number };
  settings: { loudnessLufs: number; truePeakDb: number; retention: string; llm: boolean; llmRemote: boolean };
}

/** The saved edit decision list of a project; `rev` counts its saves. */
export interface EdlFile extends Edl {
  schemaVersion: number;
  rev: number;
  updatedAtMs: number;
}

export interface SilenceReport {
  options: { minSilenceMs: number; keepMs: number; edgeMs: number };
  silences: Silence[];
}

export interface SilenceQuery {
  minSilenceMs: number;
  keepMs: number;
}

/** What the edit state needs of the server: the EDL file and a revision-checked save. */
export interface EdlBackend {
  edl(): Promise<EdlFile>;
  /** `keepalive` lets the request finish while the page is being left. */
  saveEdl(baseRev: number, removed: Range[], keepalive?: boolean): Promise<EdlFile>;
}

/** What a layout save carries: the plan, the shape of the picture and what is behind the tiles. */
export interface ScenesBody {
  plan: ScenePlan;
  aspect: Aspect;
  background: Background;
}

/** The saved layout of a project, with the scenes it resolves to on the project timeline and the picture sources it can show. */
export interface ScenesFile extends ScenesBody {
  schemaVersion: number;
  rev: number;
  updatedAtMs: number;
  scenes: Scene[];
  sources: LayoutSource[];
}

/** What the layout state needs of the server: the scenes file and a revision-checked save. */
export interface ScenesBackend {
  scenes(): Promise<ScenesFile>;
  saveScenes(baseRev: number, body: ScenesBody, keepalive?: boolean): Promise<ScenesFile>;
}

/** One finished export of a project. */
export interface ExportRecord {
  id: string;
  preset: string;
  /** Path relative to the project directory. */
  file: string;
  bytes: number;
  durationMs: number;
  createdAtMs: number;
  /** Integrated loudness the file was normalised to; null when it was not normalised. */
  loudnessLufs: number | null;
  /** The revision of the cut list the export was rendered from. */
  edlRev: number;
}

/** The saved clips of a project; `rev` counts the saves (a save made on another revision is refused). */
export interface ClipsFile {
  schemaVersion: number;
  rev: number;
  updatedAtMs: number;
  clips: ClipProject[];
}

export interface ClipSuggestions {
  suggestions: ClipSuggestion[];
  /** The language model re-ranked the list. */
  llmUsed: boolean;
  /** The host configured a language model. */
  llmAvailable: boolean;
}

export interface ChapterValidation {
  ok: boolean;
  errors: string[];
  issues: ChapterIssue[];
}

/** Chapters of the edited program, whether YouTube accepts them, and the description text. */
export interface ChaptersReport {
  chapters: Chapter[];
  validation: ChapterValidation;
  text: string;
}

export interface PublishDraftReport {
  draft: PublishDraft;
  llmUsed: boolean;
  llmAvailable: boolean;
  chapters: Chapter[];
  validation: ChapterValidation;
}

/** A suggested scene plan: overrides for the editor's own plan, and lists of stretches that are advisory only. */
export interface ScenePlanSuggestion {
  source: "llm" | "rules";
  llmAvailable: boolean;
  llmFailure: string | null;
  segments: number;
  overrides: SceneOverride[];
  /** Free text when `source` is "llm", otherwise a code (a clip reason key or "silence"). */
  highlights: Span[];
  cuts: Span[];
}

/** Suggested moments (project time, ms) for a thumbnail, and the picture it has to be. */
export interface ThumbnailCandidates {
  spec: ThumbnailSpec;
  candidates: number[];
}

async function call<T>(token: string, method: string, path: string, json?: unknown, keepalive = false): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(path, { method, headers, body, keepalive, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const parsed = ((): Record<string, unknown> => {
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  if (!response.ok) throw new ApiError(response.status, String(parsed.error ?? "request_failed"), parsed);
  return parsed as T;
}

/** Host-only API of the post-production project of one session. */
export class ProjectApi implements EdlBackend, ScenesBackend {
  constructor(
    readonly sid: string,
    readonly token: string,
  ) {}

  private path(suffix = ""): string {
    return `/api/sessions/${this.sid}/project${suffix}`;
  }

  state = () => call<ProjectState>(this.token, "GET", this.path());
  create = () => call<ProjectFile>(this.token, "POST", this.path());
  startJob = (kind: string, params: Record<string, unknown> = {}) => call<JobRecord>(this.token, "POST", this.path("/jobs"), { kind, params });
  cancelJob = (id: string) => call<JobRecord>(this.token, "POST", this.path(`/jobs/${id}/cancel`));
  transcript = () => call<TranscriptFile>(this.token, "GET", this.path("/transcript"));
  edl = () => call<EdlFile>(this.token, "GET", this.path("/edl"));
  saveEdl = (baseRev: number, removed: Range[], keepalive = false) => call<EdlFile>(this.token, "PUT", this.path("/edl"), { baseRev, removed }, keepalive);
  silences = (query: SilenceQuery) => call<SilenceReport>(this.token, "GET", this.path(`/silences?minSilenceMs=${Math.round(query.minSilenceMs)}&keepMs=${Math.round(query.keepMs)}`));
  scenes = () => call<ScenesFile>(this.token, "GET", this.path("/scenes"));
  saveScenes = (baseRev: number, body: ScenesBody, keepalive = false) => call<ScenesFile>(this.token, "PUT", this.path("/scenes"), { baseRev, ...body }, keepalive);
  exports = async () => (await call<{ exports: ExportRecord[] }>(this.token, "GET", this.path("/exports"))).exports;
  deleteExport = async (id: string) => (await call<{ exports: ExportRecord[] }>(this.token, "DELETE", this.path(`/exports/${encodeURIComponent(id)}`))).exports;
  suggestScenePlan = (llm: boolean) => call<ScenePlanSuggestion>(this.token, "POST", this.path("/scenes/suggest"), { llm });
  dropCache = (scope: "proxies" | "all") => call<ProjectFile>(this.token, "DELETE", this.path("/cache"), { scope });
  clips = () => call<ClipsFile>(this.token, "GET", this.path("/clips"));
  saveClips = (baseRev: number, clips: ClipProject[]) => call<ClipsFile>(this.token, "PUT", this.path("/clips"), { baseRev, clips });
  suggestClips = (limit: number, llm: boolean) => call<ClipSuggestions>(this.token, "POST", this.path("/clips/suggest"), { limit, llm });
  chapters = () => call<ChaptersReport>(this.token, "GET", this.path("/chapters"));
  publishDraft = (llm: boolean) => call<PublishDraftReport>(this.token, "POST", this.path("/publish/draft"), { llm });
  thumbnails = (kind: ThumbnailKind) => call<ThumbnailCandidates>(this.token, "GET", this.path(`/thumbnails?kind=${kind}`));
  /** Downloads the denoiser model onto the server: the one request of post-production that reaches the internet. */
  downloadDenoiseModel = () => call<{ ok: boolean }>(this.token, "POST", this.path("/audio/denoise-model"));

  /** Download URL of the transcript in a text format. */
  transcriptUrl(format: "srt" | "vtt" | "txt", speakers: boolean): string {
    return `${this.path(`/transcript/${format}`)}?token=${encodeURIComponent(this.token)}&speakers=${speakers ? 1 : 0}`;
  }

  /** URL of a project file for media elements; they cannot send headers, so the token goes in the query. */
  mediaUrl(relative: string): string {
    return `${this.path("/media/")}${relative.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(this.token)}`;
  }

  /** A waveform peaks file (one unsigned byte per 10 ms, aligned to the project timeline). */
  async peaks(relative: string): Promise<Uint8Array> {
    const response = await fetch(this.mediaUrl(relative), { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new ApiError(response.status, "request_failed", {});
    return new Uint8Array(await response.arrayBuffer());
  }
}
