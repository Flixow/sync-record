import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord, ProjectFile } from "../../src/shared/project.js";
import { hasFfmpeg } from "./helpers.js";
import { processesOfJob } from "../support/processes.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const SID = "crash-fixture-0001";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(hasFfmpeg() && process.platform === "linux")("a collector killed in the middle of a conform job", () => {
  let dir: string;
  const env = () => ({
    ...process.env,
    TOKEN_SIGNING_SECRET: "crash-test-secret-0123456789",
    STORAGE_LOCAL_DIR: dir,
    POST_MIN_FREE_GB: "0",
    POST_THREADS: "1",
  });
  const worker = (mode: string): ChildProcess =>
    spawn(path.resolve("node_modules/.bin/tsx"), ["tests/support/job-worker.ts", mode, SID], { env: env(), stdio: ["ignore", "pipe", "inherit"] });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "syncrecord-crash-"));
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: dir,
      durationSec: 240,
      cameraSize: "1280x720",
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true },
        { name: "Bartek", startOffsetMs: 1000, audioPpm: 0, clientClockPpm: 0, camera: true },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    // nothing to remove here: the directory lives under the task's temp dir
  });

  it("leaves no orphan and finishes the job after the restart", async () => {
    const first = worker("enqueue");
    let jobId = "";
    let output = "";
    first.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /JOB ([0-9a-f]+)/.exec(output);
      if (match?.[1]) jobId = match[1];
    });
    const jobFile = (): Promise<JobRecord> => readFile(path.join(dir, "post", SID, "jobs", `${jobId}.json`), "utf8").then((raw) => JSON.parse(raw) as JobRecord);
    let pid: number | null = null;
    for (let tries = 0; tries < 300 && pid === null; tries++) {
      await sleep(100);
      if (jobId) pid = (await jobFile().catch(() => null))?.pid ?? null;
    }
    expect(pid, "an ffmpeg child started").not.toBeNull();
    first.kill("SIGKILL"); // no chance to clean up
    await sleep(2500);
    // The child may outlive its parent for a moment; the restart below removes whatever is left.
    const second = worker("resume");
    let secondOutput = "";
    second.stdout?.on("data", (chunk: Buffer) => (secondOutput += chunk.toString()));
    await new Promise<void>((resolve) => second.once("close", () => resolve()));
    expect(secondOutput).toContain("IDLE");
    const job = await jobFile();
    expect(["done", "failed"]).toContain(job.status);
    expect(job.status, job.error ?? "").toBe("done");
    expect(job.attempts).toBe(2);
    expect(await processesOfJob(jobId)).toEqual([]);
    const project = JSON.parse(await readFile(path.join(dir, "post", SID, "project.json"), "utf8")) as ProjectFile;
    expect(project.conform.status).toBe("done");
  }, 240_000);
});
