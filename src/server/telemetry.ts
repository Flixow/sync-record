import { createHmac, randomUUID } from "node:crypto";
import type { TrackKind } from "../shared/protocol.js";

/**
 * Optional usage and error telemetry. Off unless the operator sets both POSTHOG_KEY and POSTHOG_HOST.
 *
 * Design rules, enforced by the types below:
 * - Server side only. The web client never talks to a telemetry service (its CSP would refuse it anyway),
 *   so no key, host or SDK exists in the built web bundle.
 * - Events are a closed union and each one is mapped to its properties field by field. Nothing is spread from a
 *   caller-supplied object, so a name, an e-mail, a transcript, a file name or an error message cannot slip in.
 * - Sessions are referenced by a keyed hash of the session id, never by the id itself, and the sender identity is a
 *   random id created at process start and never stored.
 */

export interface TelemetrySettings {
  /** Project API key of the PostHog project, from POSTHOG_KEY. */
  key: string;
  /** Ingestion host, without a trailing slash, from POSTHOG_HOST. */
  host: string;
}

export type ErrorSource = "http" | "job" | "remux" | "recorder";

export type TelemetryEvent =
  | { name: "session_created"; sid: string }
  | { name: "session_joined"; sid: string; participants: number }
  | { name: "recording_started"; sid: string; kinds: readonly TrackKind[] }
  | { name: "recording_stopped"; sid: string }
  | { name: "session_ended"; sid: string; participants: number; audioTracks: number; cameraTracks: number; screenTracks: number; forced: boolean; durationSec: number }
  | { name: "project_ready"; sid: string; sources: number; durationSec: number }
  | { name: "error"; source: ErrorSource; code: string; status?: number };

export interface Telemetry {
  readonly enabled: boolean;
  /** Fire and forget: never throws, never blocks the caller, never retries. */
  capture(event: TelemetryEvent): void;
  /** Resolves when every event already handed to `capture` was sent or dropped (used on shutdown and by tests). */
  flush(): Promise<void>;
}

/** The default: does nothing and touches no network. */
export const nullTelemetry: Telemetry = {
  enabled: false,
  capture() {},
  flush: () => Promise.resolve(),
};

const CODE = /^[a-z0-9_]{1,48}$/;
const MAX_IN_FLIGHT = 20;
const SEND_TIMEOUT_MS = 3000;

const count = (value: number): number => (Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 1_000_000) : 0);

/** Parses POSTHOG_KEY / POSTHOG_HOST: both or nothing. A host that is not an http(s) URL is a configuration error. */
export function telemetrySettings(key: string | undefined, host: string | undefined): TelemetrySettings | null {
  if (key === undefined || host === undefined) return null;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error("POSTHOG_HOST must be an http or https URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("POSTHOG_HOST must be an http or https URL");
  return { key, host: url.origin + url.pathname.replace(/\/+$/, "") };
}

class PostHogTelemetry implements Telemetry {
  readonly enabled = true;
  private readonly instance = randomUUID();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly settings: TelemetrySettings,
    private readonly secret: string,
    private readonly version: string,
  ) {}

  /** A stable per-session reference that cannot be turned back into the session id (or its URL) by the receiver. */
  private ref(sid: string): string {
    return createHmac("sha256", this.secret).update(`telemetry:${sid}`).digest("hex").slice(0, 16);
  }

  private properties(event: TelemetryEvent): Record<string, unknown> {
    switch (event.name) {
      case "session_created":
        return { session: this.ref(event.sid) };
      case "session_joined":
        return { session: this.ref(event.sid), participants: count(event.participants) };
      case "recording_started":
        return { session: this.ref(event.sid), audio: event.kinds.includes("audio"), camera: event.kinds.includes("camera"), screen: event.kinds.includes("screen") };
      case "recording_stopped":
        return { session: this.ref(event.sid) };
      case "session_ended":
        return {
          session: this.ref(event.sid),
          participants: count(event.participants),
          audio_tracks: count(event.audioTracks),
          camera_tracks: count(event.cameraTracks),
          screen_tracks: count(event.screenTracks),
          forced: event.forced,
          duration_sec: count(event.durationSec),
        };
      case "project_ready":
        return { session: this.ref(event.sid), sources: count(event.sources), duration_sec: count(event.durationSec) };
      case "error":
        return { source: event.source, code: CODE.test(event.code) ? event.code : "unknown", ...(event.status === undefined ? {} : { status: count(event.status) }) };
    }
  }

  capture(event: TelemetryEvent): void {
    if (this.pending.size >= MAX_IN_FLIGHT) return;
    const body = JSON.stringify({
      api_key: this.settings.key,
      event: event.name,
      distinct_id: this.instance,
      timestamp: new Date().toISOString(),
      properties: {
        ...this.properties(event),
        app_version: this.version,
        $lib: "syncrecord-collector",
        // One anonymous instance id, no person profiles, no GeoIP lookup of the collector's address.
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    const send = fetch(`${this.settings.host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
      .then((response) => void response.body?.cancel())
      .catch(() => undefined)
      .finally(() => this.pending.delete(send));
    this.pending.add(send);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}

/** Returns the PostHog sender when settings exist, otherwise the null object. `secret` keys the session reference hash. */
export function createTelemetry(settings: TelemetrySettings | null, secret: string, version: string): Telemetry {
  return settings === null ? nullTelemetry : new PostHogTelemetry(settings, secret, version);
}
