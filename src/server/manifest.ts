import { APP_NAME, MANIFEST_SCHEMA_VERSION, type Manifest, type ManifestTrack } from "../shared/protocol.js";
import type { SessionRecord, TrackRecord } from "./model.js";

function uncertaintyMs(track: TrackRecord): number {
  const rtts = [track.rttMs, ...track.clockSamples.map((sample) => sample.rttMs)].filter((rtt) => rtt >= 0);
  return Math.min(...rtts) / 2;
}

function manifestTrack(track: TrackRecord, received: number): ManifestTrack {
  const markers = track.finalized?.markers ?? [];
  const samples = [...track.clockSamples, ...(track.finalized?.clockSamples ?? [])];
  let status: ManifestTrack["status"] = "receiving";
  if (track.output) status = track.output.status;
  else if (track.finalized) status = "pending";
  return {
    trackId: track.id,
    kind: track.kind,
    segment: track.segment,
    file: track.output?.status === "ok" ? track.output.file : null,
    mime: track.mime,
    settings: track.settings,
    startCallClientMs: track.startCallClientMs,
    startClientMs: track.startClientMs,
    startServerMsEstimated: track.startClientMs + track.offsetMs,
    clock: {
      convention: "serverTimeMs = clientTimeMs + offsetMs",
      offsetMs: track.offsetMs,
      rttMs: track.rttMs,
      uncertaintyMs: uncertaintyMs({ ...track, clockSamples: samples }),
      samples,
    },
    markers: markers.map((marker) => ({ ...marker, atServerMsEstimated: marker.atClientMs + track.offsetMs })),
    endClientMs: track.finalized?.endClientMs ?? null,
    endReason: track.finalized?.endReason ?? null,
    bytesReceived: received,
    chunkCount: track.finalized?.chunkCount ?? null,
    durationSec: track.output?.durationSec ?? null,
    status,
    error: track.output?.error ?? null,
  };
}

/** Builds the manifest from persisted state. `received` gives the byte count stored for a track. */
export function buildManifest(session: SessionRecord, appVersion: string, received: (trackId: string) => number): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    app: { name: APP_NAME, version: appVersion },
    sessionId: session.id,
    createdAtServerMs: session.createdAtMs,
    endedAtServerMs: session.endedAtMs,
    participants: session.participants.map((participant) => ({
      participantId: participant.id,
      displayName: participant.name,
      host: participant.host,
      joinedAtServerMs: participant.joinedAtMs,
      consent: participant.consent ? { version: participant.consent.version, atServerMs: participant.consent.atMs } : null,
      userAgent: participant.userAgent,
      tracks: session.tracks
        .filter((track) => track.pid === participant.id)
        .sort((a, b) => a.startClientMs - b.startClientMs)
        .map((track) => manifestTrack(track, received(track.id))),
    })),
  };
}
