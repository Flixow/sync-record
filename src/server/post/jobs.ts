import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "../../shared/project.js";
import type { PostConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { nullTelemetry, type Telemetry } from "../telemetry.js";
import { CanceledError, type ToolContext } from "./exec.js";

export interface JobContext extends ToolContext {
  threads: number;
  /** Reports progress (0..1) and optionally the name of the current stage. */
  progress(fraction: number, stage?: string): void;
}

export type JobHandler = (ctx: JobContext, job: JobRecord) => Promise<Record<string, unknown> | void>;

/** Free bytes on the filesystem holding `dir` (which must exist). */
export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return info.bavail * info.bsize;
}

/** True when the process with this id belongs to the given job (it carries SYNCRECORD_JOB=<id> in its environment). */
async function belongsToJob(pid: number, jobId: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`);
    return environ.toString("utf8").split("\0").includes(`SYNCRECORD_JOB=${jobId}`);
  } catch {
    return false;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

const MAX_ATTEMPTS = 3;

/**
 * Persistent job queue. Every job is a JSON file next to its project; a collector that is killed and
 * restarted finds the jobs that were running, removes the child process they left behind and queues them
 * again (handlers are idempotent) or, after too many attempts, marks them failed with the reason.
 */
export class JobRunner {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly running = new Map<string, Running>();
  private readonly lastWrite = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly config: PostConfig,
    private readonly handlers: Record<string, JobHandler>,
    private readonly cpus: number,
    private readonly telemetry: Telemetry = nullTelemetry,
  ) {}

  private file(job: Pick<JobRecord, "sid" | "id">): string {
    return path.join(this.config.dir, job.sid, "jobs", `${job.id}.json`);
  }

  /** Loads persisted jobs and recovers the ones a crashed process left running. */
  async init(): Promise<void> {
    await mkdir(this.config.dir, { recursive: true });
    const sessions = await readdir(this.config.dir).catch(() => [] as string[]);
    for (const sid of sessions) {
      const files = await readdir(path.join(this.config.dir, sid, "jobs")).catch(() => [] as string[]);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        try {
          const job = JSON.parse(await readFile(path.join(this.config.dir, sid, "jobs", name), "utf8")) as JobRecord;
          this.jobs.set(job.id, job);
        } catch {
          // a half written file is ignored; the writes are atomic, so this means a foreign file
        }
      }
    }
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      if (job.pid !== null && (await belongsToJob(job.pid, job.id))) {
        try {
          process.kill(-job.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      job.pid = null;
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status = "failed";
        job.error = `interrupted by a restart of the collector ${job.attempts} times`;
        job.endedAtMs = Date.now();
      } else {
        job.status = "queued";
        job.stage = "resumed after a restart";
        job.progress = 0;
      }
      await this.persist(job);
    }
    this.pump();
  }

  list(sid: string): JobRecord[] {
    return [...this.jobs.values()].filter((job) => job.sid === sid).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  get(sid: string, id: string): JobRecord | null {
    const job = this.jobs.get(id);
    return job && job.sid === sid ? job : null;
  }

  /** Queues a job. An identical queued or running job is returned instead of a duplicate. */
  async enqueue(sid: string, kind: string, params: Record<string, unknown> = {}): Promise<JobRecord> {
    if (!this.handlers[kind]) throw new HttpError(400, "unknown_job_kind", { kind });
    const key = JSON.stringify(params);
    for (const job of this.jobs.values()) {
      if (job.sid === sid && job.kind === kind && (job.status === "queued" || job.status === "running") && JSON.stringify(job.params) === key) return job;
    }
    await this.preflight();
    const job: JobRecord = {
      id: randomBytes(8).toString("hex"),
      sid,
      kind,
      params,
      status: "queued",
      progress: 0,
      stage: null,
      error: null,
      attempts: 0,
      pid: null,
      createdAtMs: Date.now(),
      startedAtMs: null,
      endedAtMs: null,
      result: null,
    };
    this.jobs.set(job.id, job);
    await this.persist(job);
    this.pump();
    return job;
  }

  /** Throws 507 when the disk is too full to start a heavy job. */
  async preflight(): Promise<void> {
    await mkdir(this.config.dir, { recursive: true });
    const free = await freeBytes(this.config.dir);
    if (free < this.config.minFreeBytes) throw new HttpError(507, "disk_low", { freeBytes: free, requiredBytes: this.config.minFreeBytes });
  }

  async cancel(sid: string, id: string): Promise<JobRecord> {
    const job = this.get(sid, id);
    if (!job) throw new HttpError(404, "job_not_found");
    if (job.status === "queued") {
      job.status = "canceled";
      job.endedAtMs = Date.now();
      await this.persist(job);
    } else if (job.status === "running") {
      this.running.get(id)?.controller.abort();
      await this.running.get(id)?.done;
    }
    return job;
  }

  /** Resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || [...this.jobs.values()].some((job) => job.status === "queued")) {
      await Promise.all([...this.running.values()].map((entry) => entry.done));
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (this.closed) return;
    }
  }

  /** Stops accepting work and ends the running children. Jobs stay `running` on disk only if the process is killed, not on a clean close. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.running.values()) entry.controller.abort();
    await Promise.all([...this.running.values()].map((entry) => entry.done));
  }

  private pump(): void {
    if (this.closed) return;
    while (this.running.size < this.config.concurrency) {
      const next = [...this.jobs.values()].filter((job) => job.status === "queued").sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (!next) return;
      this.start(next);
    }
  }

  private start(job: JobRecord): void {
    const handler = this.handlers[job.kind];
    const controller = new AbortController();
    job.status = "running";
    job.attempts += 1;
    job.startedAtMs = Date.now();
    job.error = null;
    const ctx: JobContext = {
      jobId: job.id,
      signal: controller.signal,
      nice: this.config.nice,
      threads: this.config.threads > 0 ? this.config.threads : Math.max(1, Math.min(4, this.cpus)),
      onPid: (pid) => {
        job.pid = pid;
        void this.persist(job);
      },
      progress: (fraction, stage) => {
        job.progress = Math.max(0, Math.min(1, fraction));
        if (stage !== undefined) job.stage = stage;
        const now = Date.now();
        if (now - (this.lastWrite.get(job.id) ?? 0) > 2000) void this.persist(job);
      },
    };
    const done = (async () => {
      await this.persist(job);
      try {
        await this.preflight();
        if (!handler) throw new Error(`no handler for ${job.kind}`);
        const result = await handler(ctx, job);
        job.status = "done";
        job.progress = 1;
        job.result = result ?? null;
      } catch (error) {
        if (this.closed && (error instanceof CanceledError || controller.signal.aborted)) {
          // A clean shutdown pauses the job: the next start runs it again.
          job.status = "queued";
          job.stage = "paused for shutdown";
          job.attempts = Math.max(0, job.attempts - 1);
          job.progress = 0;
        } else if (error instanceof CanceledError || controller.signal.aborted) {
          job.status = "canceled";
        } else {
          job.status = "failed";
          job.error = error instanceof Error ? error.message.slice(0, 500) : "job failed";
          this.telemetry.capture({ name: "error", source: "job", code: `${job.kind.replace(/-/g, "_")}_failed` });
        }
      }
      job.pid = null;
      if (job.status !== "queued") job.endedAtMs = Date.now();
      await this.persist(job);
    })().finally(() => {
      this.running.delete(job.id);
      this.pump();
    });
    this.running.set(job.id, { controller, done });
  }

  /** Writes are chained per job so an older progress write can never land after the final state. */
  private persist(job: JobRecord): Promise<void> {
    this.lastWrite.set(job.id, Date.now());
    const snapshot = JSON.stringify(job);
    const write = (): Promise<void> => atomicJson(this.file(job), JSON.parse(snapshot) as unknown).catch(() => undefined);
    const next = (this.writes.get(job.id) ?? Promise.resolve()).then(write);
    this.writes.set(job.id, next);
    return next;
  }
}
