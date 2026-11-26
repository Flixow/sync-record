import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./projects.js";

export interface ExportRecord {
  id: string;
  preset: string;
  /** Path relative to the project directory. */
  file: string;
  bytes: number;
  durationMs: number;
  createdAtMs: number;
  /** Integrated loudness measured on the file, LUFS; null for presets rendered without normalisation. */
  loudnessLufs: number | null;
  /** The edit-list revision the export was rendered from. */
  edlRev: number;
}

const INDEX = "exports.json";
const locks = new Map<string, Promise<unknown>>();

export async function listExports(dir: string): Promise<ExportRecord[]> {
  try {
    return (JSON.parse(await readFile(path.join(dir, INDEX), "utf8")) as ExportRecord[]).sort((a, b) => b.createdAtMs - a.createdAtMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function serial<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(dir) ?? Promise.resolve()).then(work);
  locks.set(dir, next.catch(() => undefined));
  return next;
}

export function addExport(dir: string, record: ExportRecord): Promise<void> {
  return serial(dir, async () => {
    await writeJson(path.join(dir, INDEX), [record, ...(await listExports(dir))]);
  });
}

/** Removes an export and its file; returns false when there is no such export. */
export function removeExport(dir: string, id: string): Promise<boolean> {
  return serial(dir, async () => {
    const all = await listExports(dir);
    const found = all.find((record) => record.id === id);
    if (!found) return false;
    await rm(path.dirname(path.join(dir, found.file)), { recursive: true, force: true });
    await writeJson(path.join(dir, INDEX), all.filter((record) => record.id !== id));
    return true;
  });
}
