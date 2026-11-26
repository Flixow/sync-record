// Container smoke test of the speech engine: runs INSIDE the built image (see scripts/smoke-image.sh).
// It goes through the same code as the transcript job (compiled FasterWhisperEngine and the Config from the
// environment), so it fails when python3, faster-whisper, the model download or the env wiring is broken.
// Fixture: polish.flac, 16 kHz mono, synthesized with espeak-ng (see README.md in this directory).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const { loadConfig } = await import("/app/dist/server/config.js");
const { FasterWhisperEngine } = await import("/app/dist/server/post/asr.js");

const config = loadConfig(process.env);
const engine = new FasterWhisperEngine(config);
const ctx = { jobId: "smoke", signal: new AbortController().signal, nice: 0, onPid() {} };
const fixture = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "polish.flac");
const work = mkdtempSync(path.join(tmpdir(), "asr-smoke-"));

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
}

try {
  console.log(`engine ${engine.id}, model ${config.post.asr.model}, compute ${config.post.asr.computeType}, models dir ${config.post.modelsDir}`);
  const wav = path.join(work, "polish.wav");
  execFileSync(config.ffmpegPath, ["-v", "error", "-y", "-i", fixture, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);

  let t = performance.now();
  await engine.ensureModel(ctx);
  console.log(`model ready in ${((performance.now() - t) / 1000).toFixed(1)} s (first run downloads it into the models dir)`);

  t = performance.now();
  const [words] = await engine.transcribe(ctx, [wav], "pl", 2);
  const text = words.map((word) => word.w).join(" ");
  console.log(`transcribed ${words.length} words in ${((performance.now() - t) / 1000).toFixed(1)} s: ${text}`);

  if (words.length === 0 || text.trim() === "") fail("empty transcript");
  else if (!words.every((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e >= word.s)) fail("word times are not valid");
  else console.log("SMOKE OK");
} catch (error) {
  fail(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
