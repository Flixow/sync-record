import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenRole = "invite" | "participant";

export interface TokenClaims {
  /** Session id. */
  sid: string;
  role: TokenRole;
  /** Participant id (participant tokens only). */
  pid?: string;
  /** True for the participant that created the session. */
  host?: boolean;
  /** Expiry, ms since the epoch. */
  exp: number;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueToken(secret: string, claims: TokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the claims of a valid, unexpired token, otherwise null. */
export function verifyToken(secret: string, token: string, now = Date.now()): TokenClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(secret, payload), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    if (typeof claims.sid !== "string" || typeof claims.exp !== "number") return null;
    if (claims.role !== "invite" && claims.role !== "participant") return null;
    if (claims.exp < now) return null;
    return claims;
  } catch {
    return null;
  }
}
