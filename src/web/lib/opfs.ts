// Local recording store on the Origin Private File System.
//
// Layout: syncrecord/<sessionId>/<recordingId>/{meta.json, c000000, c000001, ...}
// Every MediaRecorder chunk is its own file, written whole and closed before the
// next one, so a killed tab loses at most the chunk being written. Chunks are NOT
// standalone media: only chunk 0 has the WebM header, so order is the index order.

import type { ClockSample, EndReason, MarkerRecord, TrackKind } from "../../shared/protocol.js";

export interface RecordingMeta {
  version: 1;
  recordingId: string;
  sessionId: string;
  participantId: string;
  trackId: string;
  kind: TrackKind;
  mime: string;
  settings: Record<string, number | string | boolean | null>;
  startCallClientMs: number;
  startClientMs: number;
  offsetMs: number;
  rttMs: number;
  declareSamples: ClockSample[];
  state: "recording" | "stopped";
  endClientMs: number | null;
  endReason: EndReason | null;
  /** Set once the collector confirmed the finished track. */
  complete: boolean;
  declared: boolean;
  clockSamples: ClockSample[];
  markers: MarkerRecord[];
}

const ROOT = "syncrecord";
const META = "meta.json";
const chunkName = (seq: number): string => `c${String(seq).padStart(6, "0")}`;
const CHUNK_PATTERN = /^c(\d{6})$/;

async function root(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

async function writeWhole(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

export class LocalRecording {
  private writing: Promise<void> = Promise.resolve();
  private pending = 0;
  private listeners = new Set<() => void>();
  writeError: unknown = null;

  private constructor(
    private readonly dir: FileSystemDirectoryHandle,
    readonly meta: RecordingMeta,
    private sizes: number[],
  ) {}

  get chunkCount(): number {
    return this.sizes.length;
  }

  get totalBytes(): number {
    return this.sizes.reduce((sum, size) => sum + size, 0);
  }

  static async create(meta: RecordingMeta): Promise<LocalRecording> {
    const session = await (await root()).getDirectoryHandle(meta.sessionId, { create: true });
    const dir = await session.getDirectoryHandle(meta.recordingId, { create: true });
    const recording = new LocalRecording(dir, meta, []);
    await recording.saveMeta();
    return recording;
  }

  static async list(sessionId?: string): Promise<LocalRecording[]> {
    const base = await root();
    const sessions: [string, FileSystemDirectoryHandle][] = [];
    for await (const [name, handle] of base.entries()) {
      if (handle.kind === "directory" && (sessionId === undefined || name === sessionId)) {
        sessions.push([name, handle as FileSystemDirectoryHandle]);
      }
    }
    const found: LocalRecording[] = [];
    for (const [, session] of sessions) {
      for await (const [, handle] of session.entries()) {
        if (handle.kind !== "directory") continue;
        const recording = await LocalRecording.open(handle as FileSystemDirectoryHandle);
        if (recording) found.push(recording);
      }
    }
    return found.sort((a, b) => a.meta.startClientMs - b.meta.startClientMs);
  }

  private static async open(dir: FileSystemDirectoryHandle): Promise<LocalRecording | null> {
    let meta: RecordingMeta;
    try {
      const file = await (await dir.getFileHandle(META)).getFile();
      meta = JSON.parse(await file.text()) as RecordingMeta;
    } catch {
      return null; // not a recording directory, or metadata lost
    }
    const found = new Map<number, number>();
    for await (const [name, handle] of dir.entries()) {
      const match = CHUNK_PATTERN.exec(name);
      if (match && handle.kind === "file") {
        found.set(Number(match[1]), (await (handle as FileSystemFileHandle).getFile()).size);
      }
    }
    // Only the unbroken prefix 0..n counts: a chunk after a gap is not decodable.
    const sizes: number[] = [];
    while (found.has(sizes.length)) sizes.push(found.get(sizes.length) ?? 0);
    return new LocalRecording(dir, meta, sizes);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves on the next appended chunk or metadata change. */
  nextChange(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.onChange(() => {
        off();
        resolve();
      });
    });
  }

  /** Queues a chunk; chunks are written strictly in arrival order. */
  append(chunk: Blob): Promise<void> {
    const seq = this.sizes.length + this.pending;
    this.pending += 1;
    const job = this.writing.then(async () => {
      try {
        await writeWhole(this.dir, chunkName(seq), chunk);
        this.sizes.push(chunk.size);
        this.notify();
      } catch (error) {
        this.writeError = error;
        throw error;
      } finally {
        this.pending -= 1;
      }
    });
    this.writing = job.catch(() => undefined);
    return job;
  }

  /** Resolves when every queued chunk is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  async saveMeta(): Promise<void> {
    await writeWhole(this.dir, META, JSON.stringify(this.meta));
    this.notify();
  }

  /** Reads up to `max` bytes starting at byte `offset` of the concatenated chunks. */
  async read(offset: number, max: number): Promise<Blob> {
    const parts: Blob[] = [];
    let position = 0;
    let remaining = max;
    for (let seq = 0; seq < this.sizes.length && remaining > 0; seq += 1) {
      const size = this.sizes[seq] ?? 0;
      const end = position + size;
      if (end > offset) {
        const from = Math.max(0, offset - position);
        const file = await (await this.dir.getFileHandle(chunkName(seq))).getFile();
        const slice = file.slice(from, Math.min(size, from + remaining));
        parts.push(slice);
        remaining -= slice.size;
        offset += slice.size;
      }
      position = end;
    }
    return new Blob(parts);
  }

  /** The whole track as one Blob, for "download to disk". */
  async toBlob(): Promise<Blob> {
    return this.read(0, Number.MAX_SAFE_INTEGER);
  }

  async remove(): Promise<void> {
    const parent = await root();
    const session = await parent.getDirectoryHandle(this.meta.sessionId);
    await session.removeEntry(this.meta.recordingId, { recursive: true });
  }
}

export function newId(): string {
  return crypto.randomUUID();
}
