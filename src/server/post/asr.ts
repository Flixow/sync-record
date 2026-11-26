// Speech recognition through faster-whisper (CTranslate2, MIT) in a small Python helper that runs as a child process.
// The engine only ever sees speech chunks of at most ~28 s that the voice activity step cut out, so silence costs
// nothing and a silent track produces no text. The spike (scripts/asr-spike) chose it over whisper.cpp and Parakeet:
// it meets the word-error gates in English and Polish and its word times are the closest to the reference.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { runTool, ToolError, type ToolContext } from "./exec.js";
import { memoryCapacityBytes, modelsFittingIn, smallestTierBytes } from "./memory.js";

export const ASR_SAMPLE_RATE = 16_000;

export interface AsrWord {
  w: string;
  /** Seconds from the start of the chunk. */
  s: number;
  e: number;
}

export interface AsrEngine {
  readonly id: string;
  readonly model: string;
  /** Makes sure the model is present (downloads it into the models directory on first use). */
  ensureModel(ctx: ToolContext): Promise<void>;
  /** Transcribes 16 kHz mono WAV files; one list of words per file. `lang` null lets the engine detect the language of each file. */
  transcribe(ctx: ToolContext, files: string[], lang: string | null, threads: number): Promise<AsrWord[][]>;
  /** The language most of the given files are spoken in. */
  detectLanguage(ctx: ToolContext, files: string[], threads: number): Promise<string>;
}

const MODEL_NAME = /^[A-Za-z0-9._/-]+$/;

/** Little-endian 16-bit mono WAV around raw PCM. */
export function wavFile(pcm: Buffer, sampleRate = ASR_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function writeWav(file: string, pcm: Buffer): Promise<void> {
  await writeFile(file, wavFile(pcm));
}

/** The helper. It reads a JSON request from argv[1] and writes a JSON result to the path in the request. */
export const HELPER = String.raw`
import json, sys, wave
import numpy as np
req = json.loads(sys.argv[1])
from faster_whisper import WhisperModel
model = WhisperModel(req["model"], device="cpu", compute_type=req["compute"], cpu_threads=req["threads"], download_root=req["root"])
out = {"files": []}
for path in req.get("files", []):
    with wave.open(path, "rb") as wav:
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segments, info = model.transcribe(audio, language=req.get("lang"), word_timestamps=True, vad_filter=False, beam_size=1, condition_on_previous_text=False, temperature=0.0)
    words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segments for w in seg.words if w.word.strip()]
    out["files"].append({"lang": info.language, "words": words})
with open(req["out"], "w", encoding="utf8") as fh:
    json.dump(out, fh)
`;

interface HelperResult {
  files: { lang: string; words: AsrWord[] }[];
}

const mib = (bytes: number): number => Math.round(bytes / 1024 ** 2);

const wasKilled = (error: unknown): boolean => error instanceof ToolError && (error.signal === "SIGKILL" || error.code === 137);

export class FasterWhisperEngine implements AsrEngine {
  readonly id = "faster-whisper";
  private readonly candidates: string[];
  private readonly explicit: boolean;
  private index = 0;

  constructor(
    private readonly config: Config,
    private readonly capacityBytes: number | null = memoryCapacityBytes(),
  ) {
    const chosen = config.post.asr.model;
    this.explicit = chosen !== null;
    if (chosen !== null && (!MODEL_NAME.test(chosen) || chosen.includes(".."))) throw new Error("ASR_MODEL is not a valid model name");
    this.candidates = chosen === null ? modelsFittingIn(capacityBytes) : [chosen];
  }

  get model(): string {
    return this.candidates[this.index] ?? "none";
  }

  private tooLittleMemory(detail?: string): Error {
    const have = this.capacityBytes === null ? "unknown" : `${mib(this.capacityBytes)} MiB`;
    return new Error(
      `Not enough memory for speech recognition: ${have} available to the server, the smallest model needs about ${mib(smallestTierBytes())} MiB.` +
        (detail ? ` ${detail}` : "") +
        " Free memory or give the container (and the Docker VM) more.",
    );
  }

  private async run(ctx: ToolContext, model: string, files: string[], lang: string | null, threads: number): Promise<HelperResult> {
    const root = this.config.post.modelsDir;
    await mkdir(root, { recursive: true });
    const out = path.join(root, `.result-${ctx.jobId}-${Date.now()}.json`);
    const request = JSON.stringify({ model, compute: this.config.post.asr.computeType, root, threads, lang, files, out });
    try {
      await runTool(ctx, this.config.post.asr.python, ["-c", HELPER, request], { env: { HF_HUB_DISABLE_TELEMETRY: "1", HF_HOME: path.join(root, "hf"), TOKENIZERS_PARALLELISM: "false" } });
      return JSON.parse(await readFile(out, "utf8")) as HelperResult;
    } catch (error) {
      if (error instanceof ToolError && error.code === null && /ENOENT/.test(error.message)) {
        throw new Error(`speech engine not found: ${this.config.post.asr.python} (set ASR_PYTHON to a Python with faster-whisper installed)`, { cause: error });
      }
      throw error;
    } finally {
      await rm(out, { force: true });
    }
  }

  private async call(ctx: ToolContext, files: string[], lang: string | null, threads: number): Promise<HelperResult> {
    for (;;) {
      if (this.index >= this.candidates.length) throw this.tooLittleMemory();
      const model = this.model;
      try {
        return await this.run(ctx, model, files, lang, threads);
      } catch (error) {
        if (!wasKilled(error)) throw error;
        const detail = `Model ${model} was killed by the system. (${error instanceof Error ? error.message : "SIGKILL"})`;
        if (this.explicit || this.index + 1 >= this.candidates.length) throw this.tooLittleMemory(detail);
        console.warn(`speech model ${model} was killed for lack of memory, falling back to ${this.candidates[this.index + 1]}`);
        this.index += 1;
      }
    }
  }

  async ensureModel(ctx: ToolContext): Promise<void> {
    await this.call(ctx, [], null, 1);
  }

  async transcribe(ctx: ToolContext, files: string[], lang: string | null, threads: number): Promise<AsrWord[][]> {
    if (files.length === 0) return [];
    return (await this.call(ctx, files, lang, threads)).files.map((file) => file.words);
  }

  async detectLanguage(ctx: ToolContext, files: string[], threads: number): Promise<string> {
    const result = await this.call(ctx, files, null, threads);
    const votes = new Map<string, number>();
    for (const file of result.files) votes.set(file.lang, (votes.get(file.lang) ?? 0) + file.words.length);
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
  }
}
