import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The acceptance test starts the built collector on an explicit port with its own
// throw-away data directory, drives two Chromium sessions with fake media devices
// and stops everything again. Build first: `npm run build`.
const port = Number(process.env.E2E_PORT ?? 18750);
export const E2E_DATA_DIR = process.env.E2E_DATA_DIR ?? path.join(tmpdir(), `syncrecord-e2e-${port}`);
/** Signing secret of the throw-away collector. A spec signs its own host token with it (tests that start from a prepared session on disk). */
export const E2E_SECRET = "syncrecord-e2e-signing-secret-0123456789";

// The conversation spec (tests/e2e/call.spec.ts) needs a real LiveKit server: with LIVEKIT_E2E_BIN set to a `livekit-server`
// executable it is started on loopback with throw-away keys and the collector is configured for it. Without it nothing changes.
const livekitBin = process.env.LIVEKIT_E2E_BIN;
const livekitPort = Number(process.env.LIVEKIT_E2E_PORT ?? 17880);
export const E2E_LIVEKIT_KEY = "e2elivekitkey";
export const E2E_LIVEKIT_SECRET = "e2e-livekit-secret-0123456789-abcdefghij-throwaway";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: "list",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: [
    {
      command: "node dist/server/index.js",
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: {
        HOST: "127.0.0.1",
        PORT: String(port),
        TOKEN_SIGNING_SECRET: E2E_SECRET,
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_DIR: E2E_DATA_DIR,
        // post-production: a stand-in speech engine and a small disk threshold so a full laptop disk does not fail the run
        ASR_PYTHON: path.resolve("tests/support/fake-asr.sh"),
        POST_MIN_FREE_GB: "0",
        ...(livekitBin ? { LIVEKIT_URL: `ws://127.0.0.1:${livekitPort}`, LIVEKIT_API_KEY: E2E_LIVEKIT_KEY, LIVEKIT_API_SECRET: E2E_LIVEKIT_SECRET } : {}),
      },
    },
    ...(livekitBin
      ? [
          {
            command: `${livekitBin} --config-body "log_level: warn" --bind 127.0.0.1 --node-ip 127.0.0.1 --port ${livekitPort} --keys "${E2E_LIVEKIT_KEY}: ${E2E_LIVEKIT_SECRET}"`,
            url: `http://127.0.0.1:${livekitPort}`,
            reuseExistingServer: false,
            timeout: 30_000,
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
          },
        ]
      : []),
  ],
});
