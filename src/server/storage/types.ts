import type { Readable } from "node:stream";

export interface StoredObject {
  key: string;
  size: number;
}

/**
 * Minimal object store used by the collector. Keys are slash separated and are
 * only ever built from validated ids, never from raw user input.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  /** Streams a local file into the object store (used for large remuxed tracks). */
  putFile(key: string, filePath: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  readStream(key: string): Promise<Readable>;
  /** Lists every object whose key starts with the prefix, sorted by key. */
  list(prefix: string): Promise<StoredObject[]>;
}
