import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "../..");
// Patterns are assembled at run time so this file itself never contains the thing it forbids.
const PROJECT_KEY = new RegExp(`${"ph"}${"c_"}[A-Za-z0-9]{8,}`);
const HOSTED_HOST = new RegExp(`${"post"}${"hog"}\\.com`, "i");
const canary = `canary-${randomBytes(8).toString("hex")}`;
const out = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "syncrecord-bundle-"));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const text = (file: string): string => readFileSync(file, "latin1");

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("built output carries no telemetry key", () => {
  // The values are set while building, as they would be on a machine that has telemetry configured; none may end up in the output.
  it("keeps the key and host out of the web bundle and the server build, and ships no analytics client in the web bundle", async () => {
    process.env.POSTHOG_KEY = canary;
    process.env.POSTHOG_HOST = `https://${canary}.invalid`;
    try {
      await build({ root: path.join(root, "src/web"), configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: path.join(out, "web"), emptyOutDir: true } });
      execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json", "--outDir", path.join(out, "server")], { cwd: root });
    } finally {
      delete process.env.POSTHOG_KEY;
      delete process.env.POSTHOG_HOST;
    }
    const web = filesUnder(path.join(out, "web"));
    const server = filesUnder(path.join(out, "server"));
    expect(web.length).toBeGreaterThan(0);
    expect(server.length).toBeGreaterThan(0);
    for (const file of [...web, ...server]) {
      const content = text(file);
      expect(content.includes(canary), file).toBe(false);
      expect(PROJECT_KEY.test(content), file).toBe(false);
      expect(HOSTED_HOST.test(content), file).toBe(false);
    }
    for (const file of web) expect(/posthog/i.test(text(file)), file).toBe(false);
  }, 180_000);

  it("has no project key or hosted host in any tracked file (source, docs, fixtures, Dockerfile)", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const binary = /\.(png|jpe?g|webp|woff2?|ttf|flac|webm|mp4)$/;
    for (const file of tracked) {
      if (binary.test(file)) continue;
      const content = text(path.join(root, file));
      expect(PROJECT_KEY.test(content), file).toBe(false);
      expect(HOSTED_HOST.test(content), file).toBe(false);
    }
  });
});
