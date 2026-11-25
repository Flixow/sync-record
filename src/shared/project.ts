// The project model of post-production. One project exists per session; every edit, render and clip derives from it.

import type { TrackKind } from "./protocol.js";

export const PROJECT_SCHEMA_VERSION = 1;
/** Constant frame rate every proxy and render is conformed to. */
export const DEFAULT_FPS = 30;
export const PROXY_HEIGHT = 480;
export const PEAKS_PER_SECOND = 100;
/** Length of one frame of the level track, in ms. */
export const LEVEL_FRAME_MS = 20;
export const LEVEL_FLOOR_DB = -100;
export const CONFORM_SAMPLE_RATE = 48_000;

export interface SourceAudio {
  /** Path relative to the project directory: a timeline-aligned mono FLAC (starts at project time 0). */
  file: string;
  /** Path of the waveform peaks (one unsigned byte per 10 ms, 0..255). */
  peaks: string;
  /** Path of the level track: one signed byte per 20 ms, the RMS level in dBFS (-100 is silence). */
  levels: string;
}

export interface SourceVideo {
  /** Path relative to the project directory: a timeline-aligned constant-frame-rate H.264 proxy. */
  file: string;
  width: number;
  height: number;
  fps: number;
}

export interface ProjectSource {
  /** The track id declared by the recording client. */
  id: string;
  participantId: string;
  participantName: string;
  kind: TrackKind;
  segment: number;
  /** Storage key of the remuxed original, relative to the storage root. */
  sourceKey: string;
  /** Where the first sample of this source lands on the project timeline, in ms (0 is the earliest track). */
  offsetMs: number;
  /** Duration of the original file, in seconds. */
  mediaDurationSec: number;
  /** Media seconds per timeline second. 1 means no drift correction. */
  rate: number;
  driftPpm: number;
  driftApplied: boolean;
  /** Why a measured drift was not applied, or other facts about the estimate; null when nothing to say. */
  driftNote: string | null;
  /** Length on the timeline after the drift correction, in ms. */
  timelineDurationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
  audio: SourceAudio | null;
  video: SourceVideo | null;
}

export type ConformStatus = "none" | "running" | "done" | "failed";

export interface ConformState {
  status: ConformStatus;
  atMs: number | null;
  error: string | null;
  /** Measurements of the last run. */
  wallMs: number | null;
}

export interface ProjectHighlight {
  id: string;
  /** Position on the project timeline, in ms. */
  atMs: number;
  participantId: string;
  participantName: string;
}

export interface TranscriptState {
  status: "none" | "running" | "done" | "failed";
  lang: string | null;
  engine: string | null;
  model: string | null;
  wordCount: number;
  atMs: number | null;
  wallMs: number | null;
  error: string | null;
}

export interface ProjectParticipant {
  id: string;
  name: string;
  host: boolean;
}

export interface ProjectFile {
  schemaVersion: number;
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  fps: number;
  /** Server clock instant (ms) that project time 0 corresponds to. */
  originServerMs: number;
  /** Length of the whole timeline in ms (the end of the latest source). */
  durationMs: number;
  participants: ProjectParticipant[];
  sources: ProjectSource[];
  conform: ConformState;
  /** Path of the mixed audio proxy (relative to the project directory), once built. */
  mixProxy: string | null;
  /** Moments participants flagged while recording (key M). */
  highlights: ProjectHighlight[];
  transcript: TranscriptState;
}

export const EMPTY_TRANSCRIPT: TranscriptState = { status: "none", lang: null, engine: null, model: null, wordCount: 0, atMs: null, wallMs: null, error: null };

export interface JobRecord {
  id: string;
  sid: string;
  kind: string;
  params: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  /** 0..1 */
  progress: number;
  stage: string | null;
  error: string | null;
  attempts: number;
  /** Process group of the child currently running for this job. */
  pid: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  result: Record<string, unknown> | null;
}

/** Frame duration in ms for a constant frame rate. */
export const frameMs = (fps: number): number => 1000 / fps;
