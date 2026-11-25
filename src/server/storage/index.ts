import type { Config } from "../config.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { Storage } from "./types.js";

/** Picks the storage backend from the configuration only. */
export function createStorage(config: Config): Storage {
  if (config.storageDriver === "s3" && config.s3) return new S3Storage(config.s3);
  return new LocalStorage(config.localDir);
}

export type { Storage, StoredObject } from "./types.js";
