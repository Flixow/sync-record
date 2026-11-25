import { APP_NAME, MANIFEST_SCHEMA_VERSION, type Manifest, type ManifestTrack } from "../shared/protocol.js";
import type { SessionRecord, TrackRecord } from "./model.js";

/** Round trip the client reports when the clock handshake could not run before the recording started. */
const UNKNOWN_RTT_MS = 1e9;

interface ClockChoice {
  offsetMs: number;
  rttMs: number;
}

/** The handshake taken before the start; when that failed, the lowest-latency sample taken later. */
function chooseClock(track: TrackRecord, samples: ClockChoice[]): ClockChoice {
  if (track.rttMs < UNKNOWN_RTT_MS) return { offsetMs: track.offsetMs, rttMs: track.rttMs };
  const later = samples.filter((sample) => sample.rttMs >= 0 && sample.rttMs < UNKNOWN_RTT_MS);
  if (later.length === 0) return { offsetMs: track.offsetMs, rttMs: track.rttMs };
  return later.reduce((best, sample) => (sample.rttMs < best.rttMs ? sample : best));
}

function uncertaintyMs(rttMs: number): number | null {
  return rttMs < UNKNOWN_RTT_MS ? rttMs / 2 : null;
}

function manifestTrack(track: TrackRecord, received: number): ManifestTrack {
  const markers = track.finalized?.markers ?? [];
  const samples = [...track.clockSamples, ...(track.finalized?.clockSamples ?? [])];
  let status: ManifestTrack["status"] = "receiving";
  if (track.output) status = track.output.status;
  else if (track.finalized) status = "pending";
  const clock = chooseClock(track, samples);
  return {
    trackId: track.id,
    kind: track.kind,
    segment: track.segment,
    file: track.output?.status === "ok" ? track.output.file : null,
    mime: track.mime,
    settings: track.settings,
    startCallClientMs: track.startCallClientMs,
    startClientMs: track.startClientMs,
    startServerMsEstimated: track.startClientMs + clock.offsetMs,
    clock: {
      convention: "serverTimeMs = clientTimeMs + offsetMs",
      offsetMs: clock.offsetMs,
      rttMs: clock.rttMs,
      uncertaintyMs: uncertaintyMs(clock.rttMs),
      samples,
    },
    markers: markers.map((marker) => ({ ...marker, atServerMsEstimated: marker.atClientMs + clock.offsetMs })),
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
