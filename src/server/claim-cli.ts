import { randomUUID } from "node:crypto";
import { CLAIM_TTL_MS } from "./collector.js";
import { loadConfig } from "./config.js";
import type { SessionRecord } from "./model.js";
import { createStorage } from "./storage/index.js";
import { issueToken } from "./tokens.js";
import * as v from "./validate.js";

async function main(): Promise<void> {
  const [sessionId, base] = process.argv.slice(2);
  if (!sessionId) {
    console.error("usage: node dist/server/claim-cli.js <sessionId> [baseUrl]");
    process.exit(2);
  }
  const config = loadConfig();
  const sid = v.id(sessionId, "sessionId");
  const raw = await createStorage(config).get(`session/${sid}/session.json`);
  if (!raw) throw new Error("session not found");
  const host = (JSON.parse(raw.toString("utf8")) as SessionRecord).participants.find((participant) => participant.host);
  if (!host) throw new Error("session has no host");
  const claimToken = issueToken(config.tokenSecret, { sid, role: "claim", pid: host.id, jti: randomUUID(), exp: Date.now() + CLAIM_TTL_MS });
  const origin = (base ?? process.env.PUBLIC_URL ?? `http://localhost:${config.port}`).replace(/\/+$/, "");
  console.log(`${origin}/claim/${sid}#${claimToken}`);
  console.error(`Valid for ${CLAIM_TTL_MS / 60_000} minutes and works once. Open it in the browser that should get host access.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
