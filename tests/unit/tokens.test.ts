import { describe, expect, it } from "vitest";
import { issueToken, verifyToken } from "../../src/server/tokens.js";

const SECRET = "a-long-enough-secret-value";

describe("tokens", () => {
  const claims = { sid: "abc123def456", role: "invite" as const, exp: Date.now() + 60_000 };

  it("round-trips valid claims", () => {
    expect(verifyToken(SECRET, issueToken(SECRET, claims))).toEqual(claims);
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyToken("another-secret-value-here", issueToken(SECRET, claims))).toBeNull();
  });

  it("rejects tampered payloads", () => {
    const [payload, signature] = issueToken(SECRET, claims).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "participant", pid: "p1-x" })).toString("base64url");
    expect(verifyToken(SECRET, `${forged}.${signature}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("rejects expired tokens", () => {
    const token = issueToken(SECRET, { ...claims, exp: Date.now() - 1 });
    expect(verifyToken(SECRET, token)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyToken(SECRET, "")).toBeNull();
    expect(verifyToken(SECRET, "nodot")).toBeNull();
    expect(verifyToken(SECRET, "a.b")).toBeNull();
  });
});
