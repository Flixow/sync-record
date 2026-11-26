import path from "node:path";
import { readFileSync } from "node:fs";
import { telemetryOrigin, type TelemetrySettings } from "./telemetry.js";
import { DEFAULT_LLM_TIMEOUT_MS, LLM_PROVIDER_NAMES, llmTransport, type LlmProviderName, type LlmSettings } from "./post/llm.js";

export type StorageDriverName = "local" | "s3";

export interface S3Config {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface Config {
  host: string;
  port: number;
  tokenSecret: string;
  createKey: string | null;
  tokenTtlMs: number;
  maxUploadBytes: number;
  storageDriver: StorageDriverName;
  localDir: string;
  s3: S3Config | null;
  ffmpegPath: string;
  ffprobePath: string;
  webDir: string;
  version: string;
  /** Optional telemetry; null (off) unless POSTHOG_KEY and POSTHOG_HOST are both set. */
  telemetry: TelemetrySettings | null;
  post: PostConfig;
}

/** Settings of the post-production side (conform, transcripts, renders). Everything runs on this machine. */
export interface PostConfig {
  /** Directory for projects, intermediates and exports. Always a local directory, whatever the storage driver. */
  dir: string;
  /** How many heavy jobs run at once. */
  concurrency: number;
  /** Unix niceness of every child process a job starts (0 to 19). */
  nice: number;
  /** Threads handed to ffmpeg and the speech engine per job; 0 picks min(4, cpus). */
  threads: number;
  /** A job refuses to start when the post directory has less free space than this. */
  minFreeBytes: number;
  /** keep-exports: proxies are deleted once an export finished; keep-all: nothing is deleted automatically. */
  retention: "keep-exports" | "keep-all";
  /** Target loudness of exports, LUFS integrated. */
  loudnessLufs: number;
  /** True-peak ceiling of exports, dBTP. */
  truePeakDb: number;
  /** Directory where speech models are downloaded to on first use (never inside the repository). */
  modelsDir: string;
  asr: { python: string; model: string | null; computeType: string };
  /** Optional language model (a local llama.cpp server, an OMP gateway, any OpenAI-compatible service). Null (the default) keeps every feature on its built-in heuristics. */
  llm: null | LlmSettings;
}

type Env = Record<string, string | undefined>;

function text(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** CTranslate2 compute types (faster-whisper `compute_type`); the engine checks what the CPU supports. */
const COMPUTE_TYPES = ["default", "auto", "int8", "int8_float32", "int8_float16", "int8_bfloat16", "int16", "float16", "bfloat16", "float32"];

function computeType(value: string): string {
  if (!COMPUTE_TYPES.includes(value)) throw new Error(`ASR_COMPUTE_TYPE must be one of ${COMPUTE_TYPES.join(", ")}`);
  return value;
}

function number(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * The language model settings; null when `LLM_URL` is empty. A key comes from `LLM_API_KEY` or from the file `LLM_API_KEY_FILE`
 * (a Docker or Kubernetes secret), never both. A key is only ever sent over https or a path that is encrypted anyway.
 */
function loadLlm(env: Env): LlmSettings | null {
  const url = text(env, "LLM_URL");
  if (url === undefined) return null;
  const transport = llmTransport(url);
  if (transport === null) throw new Error("LLM_URL must be an http or https URL");
  const providerRaw = text(env, "LLM_PROVIDER") ?? "openai-compatible";
  if (!(LLM_PROVIDER_NAMES as readonly string[]).includes(providerRaw)) throw new Error(`LLM_PROVIDER must be one of ${LLM_PROVIDER_NAMES.join(", ")}`);
  const provider = providerRaw as LlmProviderName;
  const keyFile = text(env, "LLM_API_KEY_FILE");
  if (keyFile !== undefined && text(env, "LLM_API_KEY") !== undefined) throw new Error("set LLM_API_KEY or LLM_API_KEY_FILE, not both");
  let apiKey = text(env, "LLM_API_KEY") ?? null;
  if (keyFile !== undefined) {
    try {
      apiKey = readFileSync(keyFile, "utf8").trim() || null;
    } catch {
      throw new Error("LLM_API_KEY_FILE cannot be read");
    }
  }
  const model = text(env, "LLM_MODEL");
  if (provider === "omp-gateway") {
    if (apiKey === null) throw new Error("LLM_PROVIDER=omp-gateway needs LLM_API_KEY or LLM_API_KEY_FILE (the gateway client token)");
    if (model === undefined) throw new Error("LLM_PROVIDER=omp-gateway needs LLM_MODEL (a provider/model id or a role such as @smol)");
  }
  if (apiKey !== null && !transport.protectedPath) throw new Error("LLM_API_KEY would be sent unencrypted: use an https LLM_URL, a loopback or Tailscale address");
  return { url, model: model ?? "default", timeoutMs: integer(env, "LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS, 1000, 600_000), provider, apiKey };
}

/** Reads the whole configuration from environment variables. Throws a readable error when it is unusable. */
/** Both variables or neither; a host that is not https (or this machine) is a configuration error, not a silent off. */
function loadTelemetry(env: Env): TelemetrySettings | null {
  const key = text(env, "POSTHOG_KEY");
  const host = text(env, "POSTHOG_HOST");
  if (key === undefined || host === undefined) return null;
  const origin = telemetryOrigin(host);
  if (origin === null) throw new Error("POSTHOG_HOST must be an https:// origin (http only for localhost)");
  return { key, host: origin };
}

export function loadConfig(env: Env = process.env): Config {
  const tokenSecret = text(env, "TOKEN_SIGNING_SECRET");
  if (!tokenSecret || tokenSecret.length < 16) {
    throw new Error("TOKEN_SIGNING_SECRET is required and must be at least 16 characters");
  }

  const driverRaw = text(env, "STORAGE_DRIVER") ?? "local";
  if (driverRaw !== "local" && driverRaw !== "s3") {
    throw new Error("STORAGE_DRIVER must be 'local' or 's3'");
  }

  let s3: S3Config | null = null;
  if (driverRaw === "s3") {
    const bucket = text(env, "S3_BUCKET");
    const accessKeyId = text(env, "S3_ACCESS_KEY_ID");
    const secretAccessKey = text(env, "S3_SECRET_ACCESS_KEY");
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    s3 = {
      endpoint: text(env, "S3_ENDPOINT"),
      region: text(env, "S3_REGION") ?? "us-east-1",
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: text(env, "S3_FORCE_PATH_STYLE") === "true",
    };
  }

  const localDir = path.resolve(text(env, "STORAGE_LOCAL_DIR") ?? "./data");
  const retention = text(env, "POST_RETENTION") ?? "keep-exports";
  if (retention !== "keep-exports" && retention !== "keep-all") {
    throw new Error("POST_RETENTION must be 'keep-exports' or 'keep-all'");
  }
  const postDir = path.resolve(text(env, "POST_DIR") ?? (driverRaw === "local" ? path.join(localDir, "post") : "./post"));

  return {
    host: text(env, "HOST") ?? "127.0.0.1",
    port: integer(env, "PORT", 8080, 0, 65535),
    tokenSecret,
    createKey: text(env, "SESSION_CREATE_KEY") ?? null,
    tokenTtlMs: integer(env, "TOKEN_TTL_HOURS", 72, 1, 24 * 365) * 3_600_000,
    maxUploadBytes: integer(env, "MAX_UPLOAD_BYTES", 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    storageDriver: driverRaw,
    localDir,
    s3,
    ffmpegPath: text(env, "FFMPEG_PATH") ?? "ffmpeg",
    ffprobePath: text(env, "FFPROBE_PATH") ?? "ffprobe",
    webDir: path.resolve(text(env, "WEB_DIR") ?? "./dist/web"),
    version: text(env, "APP_VERSION") ?? "0.1.0",
    telemetry: loadTelemetry(env),
    post: {
      dir: postDir,
      concurrency: integer(env, "POST_CONCURRENCY", 1, 1, 8),
      nice: integer(env, "POST_NICE", 10, 0, 19),
      threads: integer(env, "POST_THREADS", 0, 0, 64),
      minFreeBytes: integer(env, "POST_MIN_FREE_GB", 10, 0, 100_000) * 1024 ** 3,
      retention,
      loudnessLufs: number(env, "LOUDNESS_LUFS", -16, -40, -5),
      truePeakDb: number(env, "TRUE_PEAK_DBTP", -1, -9, 0),
      modelsDir: path.resolve(text(env, "MODELS_DIR") ?? path.join(postDir, "models")),
      asr: {
        python: text(env, "ASR_PYTHON") ?? "python3",
        model: text(env, "ASR_MODEL") ?? null,
        computeType: computeType(text(env, "ASR_COMPUTE_TYPE") ?? "int8"),
      },
      llm: loadLlm(env),
    },
  };
}
