import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { EMPTY_TRANSCRIPT, type JobRecord, type ProjectSource } from "../../shared/project.js";
import { TRANSCRIPT_SCHEMA_VERSION, dedupeBleed, wordKey, type TranscriptFile, type TranscriptWord } from "../../shared/transcript.js";
import { DEFAULT_VAD, chunkTimeToTrack, detectSpeech, packChunks, type Chunk } from "../../shared/vad.js";
import type { Config } from "../config.js";
import { ASR_SAMPLE_RATE, writeWav, type AsrEngine } from "./asr.js";
import { ffmpeg } from "./exec.js";
import { microphoneLevels } from "./mic-levels.js";
import type { JobContext } from "./jobs.js";
import { writeJson, type ProjectStore } from "./projects.js";

export interface TranscribeDeps {
  config: Config;
  store: ProjectStore;
  engine: AsrEngine;
  cpus: number;
}

export const TRANSCRIPT_FILE = "transcript.json";
/** Chunks handed to the engine in one call (the model is loaded once per call). */
const BATCH = 16;
const BYTES_PER_MS = (ASR_SAMPLE_RATE / 1000) * 2;

const LANG = /^(auto|[a-z]{2,3})$/;

/** Cuts the packed chunk (speech parts separated by silence) out of a raw PCM file. */
async function chunkPcm(handle: Awaited<ReturnType<typeof open>>, chunk: Chunk, pad: number): Promise<Buffer> {
  const out = Buffer.alloc(Math.ceil(chunk.lengthMs * BYTES_PER_MS) + pad * 2);
  for (const part of chunk.parts) {
    const length = Math.floor(((part.endMs - part.startMs) * BYTES_PER_MS) / 2) * 2;
    const at = Math.floor((part.atMs * BYTES_PER_MS) / 2) * 2;
    const { bytesRead } = await handle.read(out, at, length, Math.floor((part.startMs * BYTES_PER_MS) / 2) * 2);
    if (bytesRead < length) out.fill(0, at + bytesRead, at + length);
  }
  return out;
}

/**
 * Transcript: voice activity per track (with the cross-track test that drops speaker bleed), chunks of speech to the
 * engine, words mapped back to the project timeline, then a de-duplication pass for what bleed still got through.
 */
export function transcribeHandler(deps: TranscribeDeps) {
  return async (ctx: JobContext, job: JobRecord): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    const sid = job.sid;
    const dir = deps.store.dir(sid);
    const requested = typeof job.params.lang === "string" ? job.params.lang : "auto";
    if (!LANG.test(requested)) throw new Error("invalid language");
    await deps.store.update(sid, (project) => {
      project.transcript = { ...EMPTY_TRANSCRIPT, status: "running", atMs: Date.now() };
    });
    const work = path.join(dir, "tmp", job.id);
    try {
      await mkdir(work, { recursive: true });
      const project = await deps.store.require(sid);
      const sources = project.sources.filter((source): source is ProjectSource & { audio: NonNullable<ProjectSource["audio"]> } => source.audio !== null && source.kind === "audio");
      if (sources.length === 0) throw new Error("no conformed audio: run the conform job first");

      ctx.progress(0.01, "model");
      await deps.engine.ensureModel(ctx);

      const { levels } = await microphoneLevels(project, dir);

      // plan: speech chunks per source
      const plans = sources.map((source) => {
        const own = levels.get(source.id) as Int8Array;
        const others = sources.filter((other) => other.participantId !== source.participantId).map((other) => levels.get(other.id) as Int8Array);
        const chunks = packChunks(detectSpeech(own, DEFAULT_VAD, others));
        return { source, chunks, speechMs: chunks.reduce((sum, chunk) => sum + chunk.parts.reduce((s, part) => s + (part.endMs - part.startMs), 0), 0) };
      });
      const totalChunks = plans.reduce((sum, plan) => sum + plan.chunks.length, 0);
      const speechSec = plans.reduce((sum, plan) => sum + plan.speechMs, 0) / 1000;
      const audioSec = sources.reduce((sum, source) => sum + (levels.get(source.id)?.length ?? 0) * 0.02, 0);

      const words: TranscriptWord[] = [];
      let lang = requested === "auto" ? null : requested;
      let engineWallMs = 0;
      let doneChunks = 0;

      for (const plan of plans) {
        if (plan.chunks.length === 0) continue;
        const { source, chunks } = plan;
        const pcmFile = path.join(work, `${source.id}.pcm`);
        await ffmpeg(ctx, { ffmpegPath: deps.config.ffmpegPath, threads: ctx.threads }, ["-i", path.join(dir, source.audio.file), "-ac", "1", "-ar", String(ASR_SAMPLE_RATE), "-f", "s16le", "-threads", String(ctx.threads), pcmFile]);
        const handle = await open(pcmFile, "r");
        try {
          for (let from = 0; from < chunks.length; from += BATCH) {
            const batch = chunks.slice(from, from + BATCH);
            const files: string[] = [];
            for (const [index, chunk] of batch.entries()) {
              const file = path.join(work, `${source.id}-${from + index}.wav`);
              await writeWav(file, await chunkPcm(handle, chunk, 0));
              files.push(file);
            }
            if (lang === null) {
              lang = await deps.engine.detectLanguage(ctx, files.slice(0, 3), ctx.threads);
            }
            const started = Date.now();
            const results = await deps.engine.transcribe(ctx, files, lang, ctx.threads);
            engineWallMs += Date.now() - started;
            for (const [index, result] of results.entries()) {
              const chunk = batch[index];
              if (!chunk) continue;
              for (const word of result) {
                if (wordKey(word.w) === "") continue;
                const start = chunkTimeToTrack(chunk, word.s * 1000);
                const end = Math.max(start + 20, chunkTimeToTrack(chunk, word.e * 1000));
                words.push({ t: word.w, s: Math.round(start), e: Math.round(end), src: source.id, pid: source.participantId });
              }
            }
            for (const file of files) await rm(file, { force: true });
            doneChunks += batch.length;
            ctx.progress(0.1 + 0.88 * (doneChunks / Math.max(1, totalChunks)), `${source.participantName}`);
          }
        } finally {
          await handle.close();
          await rm(pcmFile, { force: true });
        }
      }

      const deduped = dedupeBleed(words, (id) => levels.get(id) ?? null);
      const speakerIds = [...new Set(sources.map((source) => source.participantId))];
      const transcript: TranscriptFile = {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        lang: lang ?? requested,
        engine: deps.engine.id,
        model: deps.engine.model,
        createdAtMs: Date.now(),
        speakers: speakerIds.map((pid) => ({ pid, name: project.participants.find((participant) => participant.id === pid)?.name ?? pid })),
        words: deduped.words,
        bleedDropped: deduped.dropped,
        stats: { engineWallSec: engineWallMs / 1000, speechSec, audioSec },
      };
      await writeJson(path.join(dir, TRANSCRIPT_FILE), transcript);
      const wallMs = Date.now() - startedAt;
      await deps.store.update(sid, (draft) => {
        draft.transcript = { status: "done", lang: transcript.lang, engine: transcript.engine, model: transcript.model, wordCount: transcript.words.length, atMs: Date.now(), wallMs, error: null };
      });
      return { words: transcript.words.length, bleedDropped: deduped.dropped, lang: transcript.lang, engineWallSec: transcript.stats.engineWallSec, speechSec };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.store.update(sid, (draft) => {
        draft.transcript = { ...EMPTY_TRANSCRIPT, status: "failed", atMs: Date.now(), error: message };
      }).catch(() => undefined);
      throw error;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
