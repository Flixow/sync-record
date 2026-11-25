import path from "node:path";

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

/** Reads the whole configuration from environment variables. Throws a readable error when it is unusable. */
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

  return {
    host: text(env, "HOST") ?? "127.0.0.1",
    port: integer(env, "PORT", 8080, 0, 65535),
    tokenSecret,
    createKey: text(env, "SESSION_CREATE_KEY") ?? null,
    tokenTtlMs: integer(env, "TOKEN_TTL_HOURS", 72, 1, 24 * 365) * 3_600_000,
    maxUploadBytes: integer(env, "MAX_UPLOAD_BYTES", 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    storageDriver: driverRaw,
    localDir: path.resolve(text(env, "STORAGE_LOCAL_DIR") ?? "./data"),
    s3,
    ffmpegPath: text(env, "FFMPEG_PATH") ?? "ffmpeg",
    ffprobePath: text(env, "FFPROBE_PATH") ?? "ffprobe",
    webDir: path.resolve(text(env, "WEB_DIR") ?? "./dist/web"),
    version: text(env, "APP_VERSION") ?? "0.1.0",
  };
}
