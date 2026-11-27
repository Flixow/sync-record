import { createHmac } from "node:crypto";

/** Connection to a LiveKit server (rtc.syncgrowth.pl in production). All three values come from the environment, never from the repository. */
export interface LivekitSettings {
  /** The public signalling URL handed to browsers: wss:// (ws:// only for this machine). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Lifetime of a call token. Short on purpose: a token is only needed to (re)connect, a connected client is refreshed by the server. */
  tokenTtlSeconds: number;
}

export const DEFAULT_CALL_TOKEN_TTL_SECONDS = 600;

/** Sources a participant may publish. Recording is separate and never goes through the call. */
const PUBLISH_SOURCES = ["microphone", "camera", "screen_share"] as const;

export interface CallTokenRequest {
  room: string;
  identity: string;
  name: string;
  host: boolean;
}

export interface CallToken {
  token: string;
  /** Expiry of the token, ms since the epoch. */
  expiresAtMs: number;
}

/** The LiveKit room of a SyncRecord session: one room per session, created by LiveKit on the first join. */
export function callRoomName(sid: string): string {
  return `sr-${sid}`;
}

/** The URL scheme browsers may use for signalling; the connect-src of the page is built from the same origin. */
export function livekitOrigins(url: string): { ws: string; http: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const plain = parsed.protocol === "ws:" || parsed.protocol === "http:";
  if (!secure && !(plain && local)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) return null;
  const tls = secure;
  return { ws: `${tls ? "wss" : "ws"}://${parsed.host}`, http: `${tls ? "https" : "http"}://${parsed.host}` };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A LiveKit access token (HS256 JWT, https://docs.livekit.io/frontends/authentication/tokens/).
 *
 * - The host may also publish data and administer the room (so mute and remove can be added without a new token kind).
 * - Everyone else can publish microphone, camera and screen and subscribe, nothing else.
 * - `hidden` and `recorder` are never set: no invisible participant, no egress.
 */
export function issueCallToken(settings: LivekitSettings, request: CallTokenRequest, now = Date.now()): CallToken {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + settings.tokenTtlSeconds;
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: settings.apiKey,
    sub: request.identity,
    jti: request.identity,
    name: request.name,
    nbf: issuedAt,
    exp: expiresAt,
    video: {
      room: request.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: [...PUBLISH_SOURCES],
      canPublishData: request.host,
      canUpdateOwnMetadata: false,
      ...(request.host ? { roomAdmin: true } : {}),
    },
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", settings.apiSecret).update(signingInput).digest("base64url");
  return { token: `${signingInput}.${signature}`, expiresAtMs: expiresAt * 1000 };
}
