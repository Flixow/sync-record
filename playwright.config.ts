import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The acceptance test starts the built collector on an explicit port with its own
// throw-away data directory, drives two Chromium sessions with fake media devices
// and stops everything again. Build first: `npm run build`.
const port = Number(process.env.E2E_PORT ?? 18750);
export const E2E_DATA_DIR = process.env.E2E_DATA_DIR ?? path.join(tmpdir(), `syncrecord-e2e-${port}`);

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: "list",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "node dist/server/index.js",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      TOKEN_SIGNING_SECRET: "e2e-only-secret-not-for-real-use",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: E2E_DATA_DIR,
    },
  },
});
