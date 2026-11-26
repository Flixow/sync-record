// Optional product telemetry to a PostHog instance the operator runs or pays for. Off unless POSTHOG_KEY and POSTHOG_HOST are
// both set; nothing is sent, no request is made and no key exists in the source or the build otherwise. There is no browser
// SDK, so there is no autocapture or session recording either: the server sends the few events below over the capture API.

import { randomUUID } from "node:crypto";

export interface TelemetrySettings {
  key: string;
  /** Origin of the PostHog instance, no path. */
  host: string;
}

/** Every event that can leave the process, with the only properties it may carry. Nothing else can be sent. */
export interface TelemetryEvents {
  session_created: Record<string, never>;
  session_joined: { participants: number };
  /** Which kinds of track the participant records; no more than three booleans. */
  recording_started: { audio: boolean; camera: boolean; screen: boolean };
  recording_stopped: Record<string, never>;
  session_ended: { participants: number };
  /** The post-production project of a session finished conforming and can be edited. */
  project_ready: Record<string, never>;
  /** A track could not be remuxed into its final file; no message, path or id. */
  remux_failed: Record<string, never>;
  /** `kind` is a job kind of this program (conform, transcribe, render ...), never a message or a path. */
  job_failed: { kind: string };
  /** `error` is the class name of an unexpected request error, never its message. */
  server_error: { error: string };
}

export interface Telemetry {
  readonly enabled: boolean;
  capture<E extends keyof TelemetryEvents>(event: E, properties: TelemetryEvents[E]): void;
}

const TIMEOUT_MS = 3000;

const OFF: Telemetry = { enabled: false, capture: () => undefined };

/** A plain origin: https anywhere, http only for this machine (a collector next to the app, or a test server). */
export function telemetryOrigin(host: string): string | null {
  try {
    const url = new URL(host);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget sender: one POST per event with a short timeout, no queue, no retry, failures ignored. The distinct id is
 * random per process start, so it names no person, user or session; the event is marked as anonymous (no person profile)
 * and without geolocation. Also switch on "Discard client IP data" in the PostHog project settings: the server's own IP
 * address is what the capture request carries.
 */
export function createTelemetry(settings: TelemetrySettings | null): Telemetry {
  if (settings === null) return OFF;
  const instance = randomUUID();
  const endpoint = `${settings.host}/capture/`;
  return {
    enabled: true,
    capture(event, properties) {
      const body = JSON.stringify({
        api_key: settings.key,
        event,
        distinct_id: instance,
        timestamp: new Date().toISOString(),
        properties: { ...properties, $process_person_profile: false, $geoip_disable: true, $lib: "syncrecord-server" },
      });
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }).then(
        (response) => void response.body?.cancel(),
        () => undefined,
      );
    },
  };
}
