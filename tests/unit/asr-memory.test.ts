import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FasterWhisperEngine } from "../../src/server/post/asr.js";
import { runTool, ToolError, type ToolContext } from "../../src/server/post/exec.js";
import { memoryCapacityBytes, modelsFittingIn } from "../../src/server/post/memory.js";
import { testConfig } from "./helpers.js";

const GIB = 1024 ** 3;
const files = (map: Record<string, string>) => (file: string) => map[file] ?? null;
const meminfo = (kb: number) => `MemTotal:       ${kb} kB\nMemFree: 1 kB\n`;

describe("memory capacity and model choice", () => {
  it("takes the lower of the cgroup limit and the machine memory", () => {
    // the container allows 4 GiB but the Docker VM behind it has 970 MiB
    expect(memoryCapacityBytes(files({ "/sys/fs/cgroup/memory.max": "4294967296\n", "/proc/meminfo": meminfo(993904) }))).toBe(993904 * 1024);
    expect(memoryCapacityBytes(files({ "/sys/fs/cgroup/memory.max": "1073741824\n", "/proc/meminfo": meminfo(16 * 1024 * 1024) }))).toBe(GIB);
    expect(memoryCapacityBytes(files({ "/sys/fs/cgroup/memory.max": "max\n", "/proc/meminfo": meminfo(8 * 1024 * 1024) }))).toBe(8 * GIB);
    expect(memoryCapacityBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n", "/proc/meminfo": meminfo(2 * 1024 * 1024) }))).toBe(2 * GIB);
    expect(memoryCapacityBytes(files({}))).toBeNull();
  });

  it("picks the largest model that fits and none when even base does not", () => {
    expect(modelsFittingIn(8 * GIB)[0]).toBe("deepdml/faster-whisper-large-v3-turbo-ct2");
    expect(modelsFittingIn(2 * GIB)).toEqual(["small", "base"]);
    expect(modelsFittingIn(993904 * 1024)).toEqual(["base"]);
    expect(modelsFittingIn(300 * 1024 ** 2)).toEqual([]);
    expect(modelsFittingIn(null)).toHaveLength(3);
  });
});

const ctx = (): ToolContext => ({ jobId: "j1", signal: new AbortController().signal, nice: 0, onPid: () => undefined });

async function fakePython(killAbove: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-fakepy-"));
  const file = path.join(dir, "python");
  await writeFile(
    file,
    `#!/usr/bin/env node
const req = JSON.parse(process.argv[4]);
if (${JSON.stringify(killAbove)}.includes(req.model)) process.kill(process.pid, "SIGKILL");
require("node:fs").writeFileSync(req.out, JSON.stringify({ files: req.files.map(() => ({ lang: "pl", words: [{ w: req.model, s: 0, e: 1 }] })) }));
`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("speech engine under memory pressure", () => {
  const engineFor = async (killed: string[], capacity: number | null, env: Record<string, string> = {}) => {
    const python = await fakePython(killed);
    const dir = await mkdtemp(path.join(tmpdir(), "syncrecord-asr-"));
    return new FasterWhisperEngine(testConfig(dir, { ASR_PYTHON: python, ...env }), capacity);
  };

  it("falls back to a smaller model when the system kills the larger one", async () => {
    const engine = await engineFor(["deepdml/faster-whisper-large-v3-turbo-ct2", "small"], 8 * GIB);
    expect(engine.model).toBe("deepdml/faster-whisper-large-v3-turbo-ct2");
    const words = await engine.transcribe(ctx(), ["a.wav"], "pl", 1);
    expect(engine.model).toBe("base");
    expect(words[0]?.[0]?.w).toBe("base");
  });

  it("reports not enough memory when the smallest model is killed too, and when nothing fits", async () => {
    const killed = await engineFor(["base"], 1 * GIB);
    await expect(killed.ensureModel(ctx())).rejects.toThrow(/Not enough memory.*base was killed by the system.*SIGKILL/s);
    const none = await engineFor([], 200 * 1024 ** 2);
    await expect(none.ensureModel(ctx())).rejects.toThrow(/Not enough memory.*200 MiB/);
  });

  it("does not replace a model the user pinned", async () => {
    const engine = await engineFor(["small"], 8 * GIB, { ASR_MODEL: "small" });
    await expect(engine.ensureModel(ctx())).rejects.toThrow(/Not enough memory.*small was killed/s);
    expect(engine.model).toBe("small");
  });
});

describe("tool errors", () => {
  it("names the signal and keeps the stderr tail instead of 'exited with null'", async () => {
    const error = await runTool(ctx(), "sh", ["-c", "echo boom >&2; kill -9 $$"]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe("sh was stopped by SIGKILL (usually the system ran out of memory): boom");
    expect((error as ToolError).signal).toBe("SIGKILL");
  });
});
