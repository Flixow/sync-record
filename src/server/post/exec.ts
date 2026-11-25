import { spawn } from "node:child_process";
import { setPriority } from "node:os";

/** What a running job lends to the tools it starts: cancellation, niceness and a record of the child's process group. */
export interface ToolContext {
  jobId: string;
  signal: AbortSignal;
  nice: number;
  /** Called with the child's process group id when it starts and with null when it ended. */
  onPid(pid: number | null): void;
}

export interface ToolOptions {
  /** Receives raw stdout (used for tools that stream data, such as PCM for the waveform). */
  onStdout?: (chunk: Buffer) => void;
  /** Receives one line of the `-progress` stream of ffmpeg (key=value). */
  onProgressLine?: (line: string) => void;
  /** Extra environment variables. */
  env?: Record<string, string>;
  cwd?: string;
}

export interface ToolResult {
  stdout: string;
  stderr: string;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class CanceledError extends Error {
  constructor() {
    super("canceled");
  }
}

const TAIL = 4000;

/**
 * Runs an external tool in its own process group at the job's niceness. The group id is reported through
 * `onPid`, so the runner can remove a leftover child after a crash, and cancellation ends the whole group.
 * File descriptor 3 carries ffmpeg's `-progress` output so stdout stays free for data.
 */
export function runTool(ctx: ToolContext, cmd: string, args: string[], options: ToolOptions = {}): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new CanceledError());
      return;
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, SYNCRECORD_JOB: ctx.jobId },
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const pid = child.pid;
    if (pid === undefined) {
      child.once("error", (error) => reject(new ToolError(`cannot start ${cmd}: ${error.message}`, null, "")));
      return;
    }
    try {
      setPriority(pid, ctx.nice);
    } catch {
      // Niceness is a courtesy: a platform that refuses it still runs the job.
    }
    ctx.onPid(pid);

    let stdout = "";
    let stderr = "";
    let canceled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.onStdout) options.onStdout(chunk);
      else if (stdout.length < TAIL * 4) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-TAIL);
    });
    const progress = child.stdio[3];
    if (progress && "on" in progress) {
      let pending = "";
      progress.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          options.onProgressLine?.(pending.slice(0, newline).trim());
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });
    }

    const kill = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-pid, signal);
      } catch {
        // already gone
      }
    };
    let hardKill: NodeJS.Timeout | null = null;
    const onAbort = (): void => {
      canceled = true;
      kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 3000);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (hardKill) clearTimeout(hardKill);
      ctx.onPid(null);
      reject(new ToolError(`cannot run ${cmd}: ${error.message}`, null, stderr));
    });
    child.once("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (hardKill) clearTimeout(hardKill);
      ctx.onPid(null);
      if (canceled) reject(new CanceledError());
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError(`${cmd} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`, code, stderr));
    });
  });
}

export interface FfmpegRun {
  ffmpegPath: string;
  threads: number;
  /** Duration the run should produce, in seconds; turns ffmpeg progress into a fraction. */
  expectedSec?: number;
  onProgress?: (fraction: number) => void;
}

/** Runs ffmpeg with the options every job shares. `args` are everything after the global options. */
export function ffmpeg(ctx: ToolContext, run: FfmpegRun, args: string[], options: Pick<ToolOptions, "onStdout"> = {}): Promise<ToolResult> {
  const global = ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:3", "-y"];
  return runTool(ctx, run.ffmpegPath, [...global, ...args], {
    ...options,
    onProgressLine: (line) => {
      if (!run.onProgress || !run.expectedSec) return;
      if (line.startsWith("out_time_us=")) {
        const micro = Number(line.slice("out_time_us=".length));
        if (Number.isFinite(micro) && micro >= 0) run.onProgress(Math.min(1, micro / 1e6 / run.expectedSec));
      }
    },
  });
}

/** Resolved thread count for a tool: the setting, or min(4, cpus). */
export function threadsFor(configured: number, cpus: number): number {
  return configured > 0 ? configured : Math.max(1, Math.min(4, cpus));
}
