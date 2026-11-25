import type { SessionApi } from "./api.js";
import { ApiError, sha256Hex } from "./api.js";
import type { LocalRecording } from "./opfs.js";

/** Bytes per upload request: large enough to be efficient, small enough to retry cheaply. */
export const BATCH_BYTES = 4 * 1024 * 1024;

export type UploadPhase = "waiting" | "uploading" | "retrying" | "done" | "stopped";

export interface UploadStatus {
  phase: UploadPhase;
  uploaded: number;
  error: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Background upload of local recordings, with resume.
 *
 * Chunks are not standalone, so the protocol is an append-only byte stream per
 * track: ask the collector how many bytes it holds, send the next bytes from
 * exactly there, in order. After a crash or reconnect the same loop starts from
 * the collector's answer, and a recovered recording from OPFS follows the same path.
 */
export class Uploader {
  private readonly status = new Map<string, UploadStatus>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: SessionApi) {
    window.addEventListener("online", () => this.notify());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statusOf(recording: LocalRecording): UploadStatus {
    return this.status.get(recording.meta.recordingId) ?? { phase: recording.meta.complete ? "done" : "waiting", uploaded: 0, error: null };
  }

  /** Starts (or keeps) the upload loop of a recording. */
  add(recording: LocalRecording): void {
    const id = recording.meta.recordingId;
    if (recording.meta.complete) {
      this.set(id, { phase: "done", uploaded: recording.totalBytes, error: null });
      return;
    }
    if (this.running.has(id)) return;
    this.cancelled.delete(id);
    const loop = this.drive(recording).finally(() => this.running.delete(id));
    this.running.set(id, loop);
  }

  cancel(recording: LocalRecording): void {
    this.cancelled.add(recording.meta.recordingId);
  }

  /** True while any upload is still in progress. */
  busy(): boolean {
    return this.running.size > 0;
  }

  private set(id: string, status: UploadStatus): void {
    this.status.set(id, status);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async drive(recording: LocalRecording): Promise<void> {
    const { meta } = recording;
    const id = meta.recordingId;
    let uploaded = this.status.get(id)?.uploaded ?? 0;
    let backoff = 1000;

    while (!this.cancelled.has(id)) {
      try {
        if (!meta.declared) {
          await this.api.declare({
            trackId: meta.trackId,
            kind: meta.kind,
            mime: meta.mime,
            settings: meta.settings,
            startClientMs: meta.startClientMs,
            startCallClientMs: meta.startCallClientMs,
            offsetMs: meta.offsetMs,
            rttMs: meta.rttMs,
            clockSamples: meta.declareSamples,
          });
          meta.declared = true;
          await recording.saveMeta();
        }
        // The collector is the source of truth for how much it already holds.
        uploaded = (await this.api.trackState(meta.trackId)).received;
        for (;;) {
          if (this.cancelled.has(id)) return;
          if (uploaded < recording.totalBytes) {
            this.set(id, { phase: "uploading", uploaded, error: null });
            const blob = await recording.read(uploaded, BATCH_BYTES);
            const body = await blob.arrayBuffer();
            try {
              uploaded = (await this.api.upload(meta.trackId, uploaded, body, await sha256Hex(body))).received;
            } catch (error) {
              if (error instanceof ApiError && error.code === "offset_gap") {
                uploaded = Number(error.body.received);
                continue;
              }
              throw error;
            }
            backoff = 1000;
            continue;
          }
          if (meta.state === "stopped") {
            await recording.flush();
            if (uploaded < recording.totalBytes) continue;
            await this.api.finalize(meta.trackId, {
              totalBytes: recording.totalBytes,
              chunkCount: recording.chunkCount,
              endClientMs: meta.endClientMs,
              endReason: meta.endReason ?? "stopped",
              clockSamples: meta.clockSamples,
              markers: meta.markers,
            });
            meta.complete = true;
            await recording.saveMeta();
            this.set(id, { phase: "done", uploaded, error: null });
            return;
          }
          this.set(id, { phase: "waiting", uploaded, error: null });
          await recording.nextChange();
        }
      } catch (error) {
        if (this.cancelled.has(id)) return;
        const message = error instanceof Error ? error.message : "upload failed";
        this.set(id, { phase: "retrying", uploaded, error: message });
        await Promise.race([sleep(backoff), new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true }))]);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    this.set(id, { phase: "stopped", uploaded, error: null });
  }
}
