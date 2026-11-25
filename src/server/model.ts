import type { ClockSample, EndReason, MarkerRecord, TrackKind } from "../shared/protocol.js";

export interface ParticipantRecord {
  id: string;
  name: string;
  host: boolean;
  joinedAtMs: number;
  userAgent: string | null;
  consent: { version: string; atMs: number } | null;
}

export interface TrackRecord {
  id: string;
  pid: string;
  kind: TrackKind;
  /** 1 for the first recording of this kind by this participant, then 2, 3 ... */
  segment: number;
  mime: string;
  settings: Record<string, number | string | boolean | null>;
  startCallClientMs: number;
  startClientMs: number;
  offsetMs: number;
  rttMs: number;
  clockSamples: ClockSample[];
  declaredAtMs: number;
  finalized: null | {
    totalBytes: number;
    chunkCount: number;
    endClientMs: number | null;
    endReason: EndReason;
    clockSamples: ClockSample[];
    markers: MarkerRecord[];
    atMs: number;
  };
  output: null | {
    status: "ok" | "failed";
    file: string;
    bytes: number;
    durationSec: number | null;
    error?: string;
  };
}

export interface SessionRecord {
  id: string;
  createdAtMs: number;
  endedAtMs: number | null;
  participants: ParticipantRecord[];
  tracks: TrackRecord[];
}
