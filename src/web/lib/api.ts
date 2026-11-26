import type {
  ClaimLinkResponse,
  ClaimResponse,
  ClockResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeclareTrackRequest,
  FinalizeRequest,
  JoinResponse,
  Manifest,
  MarkerEvent,
  SessionView,
  StatusRequest,
  TrackStateResponse,
  UploadResponse,
} from "../../shared/protocol.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(code);
  }
}

export interface PublicConfig {
  createKeyRequired: boolean;
  maxParticipants: number;
  version: string;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function call<T>(
  method: string,
  path: string,
  options: { token?: string; json?: unknown; body?: ArrayBuffer; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.body) {
    body = options.body;
  }
  // A stalled connection must fail (and be retried) instead of hanging forever.
  const response = await fetch(path, { method, headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const parsed = parseObject(text);
  if (!response.ok) throw new ApiError(response.status, String(parsed.error ?? "request_failed"), parsed);
  return parsed as T;
}

export const publicApi = {
  config: () => call<PublicConfig>("GET", "/api/config"),
  createSession: (request: CreateSessionRequest) => call<CreateSessionResponse>("POST", "/api/sessions", { json: request }),
  join: (sid: string, inviteToken: string, name: string) =>
    call<JoinResponse>("POST", `/api/sessions/${sid}/join`, { token: inviteToken, json: { name } }),
  claim: (sid: string, claimToken: string) => call<ClaimResponse>("POST", `/api/sessions/${sid}/claim`, { token: claimToken, json: {} }),
};

/** API of one joined participant. */
export class SessionApi {
  constructor(
    readonly sid: string,
    public token: string,
  ) {}

  private path(suffix = ""): string {
    return `/api/sessions/${this.sid}${suffix}`;
  }

  view = () => call<SessionView>("GET", this.path(), { token: this.token });
  claimLink = () => call<ClaimLinkResponse>("POST", this.path("/claim-links"), { token: this.token, json: {} });
  clock = () => call<ClockResponse>("POST", this.path("/clock"), { token: this.token, timeoutMs: 4000 });
  status = (request: StatusRequest) => call<void>("POST", this.path("/status"), { token: this.token, json: request });
  marker = () => call<MarkerEvent>("POST", this.path("/markers"), { token: this.token, json: {} });
  end = (force: boolean) => call<Manifest>("POST", this.path("/end"), { token: this.token, json: { force } });
  manifest = () => call<Manifest>("GET", this.path("/manifest"), { token: this.token });
  declare = (request: DeclareTrackRequest) => call<TrackStateResponse>("POST", this.path("/tracks"), { token: this.token, json: request });
  trackState = (tid: string) => call<TrackStateResponse>("GET", this.path(`/tracks/${tid}`), { token: this.token });
  upload = (tid: string, offset: number, body: ArrayBuffer, sha256: string) =>
    call<UploadResponse>("PUT", this.path(`/tracks/${tid}/data?offset=${offset}`), {
      token: this.token,
      body,
      headers: { "x-sha256": sha256, "content-type": "application/octet-stream" },
    });
  finalize = (tid: string, request: FinalizeRequest) =>
    call<TrackStateResponse>("POST", this.path(`/tracks/${tid}/finalize`), { token: this.token, json: request });

  /** The event stream authenticates with a query parameter because EventSource cannot set headers. */
  eventsUrl(): string {
    return this.path(`/events?token=${encodeURIComponent(this.token)}`);
  }
}

// ---- credentials kept in this browser ------------------------------------

export interface StoredCredentials {
  participantId: string;
  participantToken: string;
  name: string;
  host: boolean;
  inviteToken?: string;
}

const key = (sid: string): string => `syncrecord.session.${sid}`;

export function loadCredentials(sid: string): StoredCredentials | null {
  try {
    const raw = localStorage.getItem(key(sid));
    return raw ? (JSON.parse(raw) as StoredCredentials) : null;
  } catch {
    return null;
  }
}

export function saveCredentials(sid: string, credentials: StoredCredentials): void {
  localStorage.setItem(key(sid), JSON.stringify(credentials));
}

export function forgetCredentials(sid: string): void {
  localStorage.removeItem(key(sid));
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
