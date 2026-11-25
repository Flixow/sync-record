import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type App } from "../../src/server/app.js";
import { loadConfig, type Config } from "../../src/server/config.js";
import { LocalStorage } from "../../src/server/storage/local.js";

export const SECRET = "unit-test-secret-0123456789";

export function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function testConfig(dir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({ TOKEN_SIGNING_SECRET: SECRET, STORAGE_LOCAL_DIR: dir, PORT: "0", WEB_DIR: path.join(dir, "web"), ...extra });
}

export interface TestServer {
  app: App;
  base: string;
  dir: string;
  storage: LocalStorage;
  close: () => Promise<void>;
}

export async function startServer(extra: Record<string, string> = {}): Promise<TestServer> {
  const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-unit-"));
  const config = testConfig(dir, extra);
  const storage = new LocalStorage(config.localDir);
  const app = createApp(config, storage);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return {
    app,
    base: `http://127.0.0.1:${address.port}`,
    dir,
    storage,
    close: async () => {
      await app.collector.idle();
      app.collector.close();
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    },
  };
}

export async function api(
  server: TestServer,
  method: string,
  route: string,
  options: { token?: string; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.body) {
    body = new Uint8Array(options.body);
  }
  const response = await fetch(server.base + route, { method, headers, body });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** A real, tiny WebM (Opus) produced by ffmpeg, so the remux path runs on genuine media. */
export function makeWebm(seconds: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "syncrecord-media-"));
  const file = path.join(dir, "sample.webm");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "libopus", "-f", "webm", file]);
  return execFileSync("cat", [file], { maxBuffer: 64 * 1024 * 1024 });
}
