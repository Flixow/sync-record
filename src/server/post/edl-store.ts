import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalize, type Edl, type Range } from "../../shared/edl.js";
import { HttpError } from "../errors.js";
import { writeJson } from "./projects.js";

export const EDL_FILE = "edl.json";
export const MAX_RANGES = 20_000;

export interface EdlFile extends Edl {
  schemaVersion: 1;
  /** Counts saves; a client that saves must name the revision it started from. */
  rev: number;
  updatedAtMs: number;
}

export async function readEdl(dir: string): Promise<EdlFile> {
  try {
    return JSON.parse(await readFile(path.join(dir, EDL_FILE), "utf8")) as EdlFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, rev: 0, updatedAtMs: 0, removed: [] };
    throw error;
  }
}

/** Checks the ranges of a request: integers, inside the timeline, not absurdly many. */
export function parseRanges(value: unknown, durationMs: number): Range[] {
  if (!Array.isArray(value) || value.length > MAX_RANGES) throw new HttpError(400, "invalid_field", { field: "removed" });
  const ranges: Range[] = value.map((item) => {
    const range = item as Partial<Range> | null;
    if (!range || !Number.isFinite(range.s) || !Number.isFinite(range.e) || (range.s as number) < 0 || (range.e as number) <= (range.s as number)) throw new HttpError(400, "invalid_field", { field: "removed" });
    return { s: range.s as number, e: range.e as number };
  });
  return normalize(ranges, durationMs);
}

const writes = new Map<string, Promise<unknown>>();

/** Saves a new list if `baseRev` is still the current revision (otherwise the client edited a stale copy). */
export function saveEdl(dir: string, baseRev: number, removed: Range[]): Promise<EdlFile> {
  const previous = writes.get(dir) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current = await readEdl(dir);
    if (current.rev !== baseRev) throw new HttpError(409, "edl_conflict", { rev: current.rev });
    const file: EdlFile = { schemaVersion: 1, rev: current.rev + 1, updatedAtMs: Date.now(), removed };
    await writeJson(path.join(dir, EDL_FILE), file);
    return file;
  });
  writes.set(dir, next.catch(() => undefined));
  return next;
}
