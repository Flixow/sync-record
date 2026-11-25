// Types and constants shared by the collector and the web client.

export const APP_NAME = "syncrecord";
export const MAX_PARTICIPANTS = 4;
export const MANIFEST_SCHEMA_VERSION = 1;
export const CONSENT_VERSION = "2026-11-v1";

export const TRACK_KINDS = ["audio", "camera", "screen"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export type PresenceState = "idle" | "ready" | "recording" | "stopped";

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;

export interface ClockSample {
  /** Client clock (performance.timeOrigin + performance.now()) when the sample finished, in ms. */
  atClientMs: number;
  /** serverTimeMs - clientTimeMs, in ms. */
  offsetMs: number;
  rttMs: number;
}

export interface MarkerRecord {
  id: string;
  kind: "start-beep" | "host-beep";
  /** Client clock instant at which the beep was scheduled to start playing, in ms. */
  atClientMs: number;
  outputLatencyMs: number | null;
}

export interface RosterEntry {
  participantId: string;
  name: string;
  host: boolean;
  online: boolean;
  state: PresenceState;
  kinds: TrackKind[];
}

export interface SessionView {
  sessionId: string;
  ended: boolean;
  maxParticipants: number;
  roster: RosterEntry[];
  /** A fresh token with a new expiry for the caller (sliding expiry: every visit renews it). */
  renewedToken: string;
}

export interface CreateSessionRequest {
  name: string;
  createKey?: string;
}
export interface CreateSessionResponse {
  sessionId: string;
  participantId: string;
  participantToken: string;
  inviteToken: string;
}
export interface JoinRequest {
  name: string;
}
export interface JoinResponse {
  sessionId: string;
  participantId: string;
  participantToken: string;
}

export interface ClockResponse {
  serverRecvMs: number;
  serverSendMs: number;
}

export interface StatusRequest {
  state: PresenceState;
  kinds: TrackKind[];
  consentVersion?: string;
}

export interface DeclareTrackRequest {
  trackId: string;
  kind: TrackKind;
  mime: string;
  settings: Record<string, number | string | boolean | null>;
  /** Client clock instant of the recorder "start" event, in ms. */
  startClientMs: number;
  /** Client clock instant when MediaRecorder.start() was called, in ms. */
  startCallClientMs: number;
  /** Best clock offset (serverTimeMs - clientTimeMs) known at the start, in ms. */
  offsetMs: number;
  rttMs: number;
  clockSamples: ClockSample[];
}

export interface TrackStateResponse {
  trackId: string;
  received: number;
  finalized: boolean;
}

export interface UploadResponse {
  received: number;
}
export interface OffsetGapResponse {
  error: "offset_gap";
  received: number;
}

export type EndReason = "stopped" | "trackEnded" | "sessionEnded" | "crash" | "forced" | "error";

export interface FinalizeRequest {
  totalBytes: number;
  chunkCount: number;
  endClientMs: number | null;
  endReason: EndReason;
  clockSamples: ClockSample[];
  markers: MarkerRecord[];
}

export interface MarkerEvent {
  id: string;
  atServerMs: number;
}

export type ServerEvent =
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "marker"; marker: MarkerEvent }
  | { type: "ended" };

export type TrackOutputStatus = "receiving" | "pending" | "ok" | "failed";

export interface ManifestTrack {
  trackId: string;
  kind: TrackKind;
  segment: number;
  /** Path relative to the participant directory, e.g. "audio.webm". Null until remuxed. */
  file: string | null;
  mime: string;
  settings: Record<string, number | string | boolean | null>;
  startCallClientMs: number;
  startClientMs: number;
  startServerMsEstimated: number;
  clock: {
    convention: "serverTimeMs = clientTimeMs + offsetMs";
    offsetMs: number;
    rttMs: number;
    /** Half the round trip of the chosen sample; null when the handshake could not run before the start. */
    uncertaintyMs: number | null;
    samples: ClockSample[];
  };
  markers: (MarkerRecord & { atServerMsEstimated: number })[];
  endClientMs: number | null;
  endReason: EndReason | null;
  bytesReceived: number;
  chunkCount: number | null;
  durationSec: number | null;
  status: TrackOutputStatus;
  error: string | null;
}

export interface ManifestParticipant {
  participantId: string;
  displayName: string;
  host: boolean;
  joinedAtServerMs: number;
  consent: { version: string; atServerMs: number } | null;
  userAgent: string | null;
  tracks: ManifestTrack[];
}

export interface Manifest {
  schemaVersion: number;
  app: { name: string; version: string };
  sessionId: string;
  createdAtServerMs: number;
  endedAtServerMs: number | null;
  participants: ManifestParticipant[];
}
