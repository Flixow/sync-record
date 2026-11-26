import { Collector, CLAIM_TTL_MS } from "./collector.js";
import { loadConfig } from "./config.js";
import { createStorage } from "./storage/index.js";
import * as v from "./validate.js";

async function main(): Promise<void> {
  const [sessionId, base] = process.argv.slice(2);
  if (!sessionId) {
    console.error("usage: node dist/server/claim-cli.js <sessionId> [baseUrl]");
    process.exit(2);
  }
  const config = loadConfig();
  const collector = new Collector(config, createStorage(config));
  try {
    const sid = v.id(sessionId, "sessionId");
    const { claimToken } = await collector.hostClaimToken(sid);
    const origin = (base ?? process.env.PUBLIC_URL ?? `http://localhost:${config.port}`).replace(/\/+$/, "");
    console.log(`${origin}/claim/${sid}#${claimToken}`);
    console.error(`Valid for ${CLAIM_TTL_MS / 60_000} minutes and works once. Open it in the browser that should get host access.`);
  } finally {
    collector.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
