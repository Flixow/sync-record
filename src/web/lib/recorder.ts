import type { EndReason, TrackKind } from "../../shared/protocol.js";
import { BITRATE_BPS } from "./storage-math.js";
import { clientNowMs } from "./clock.js";
import { LocalRecording, newId, type RecordingMeta } from "./opfs.js";

export const TIMESLICE_MS = 1000;

/** First supported container, VP9 preferred (VP8 only as a fallback for older builds). */
export function pickMime(kind: TrackKind): string | null {
  const candidates =
    kind === "audio"
      ? ["audio/webm;codecs=opus"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8"];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export interface RecorderInit {
  kind: TrackKind;
  stream: MediaStream;
  sessionId: string;
  participantId: string;
  /** Latest clock handshake result, taken right before start. */
  clock: { offsetMs: number; rttMs: number };
  clockSamples: RecordingMeta["declareSamples"];
  settings: RecordingMeta["settings"];
  onEnded: (recorder: TrackRecorder, reason: EndReason) => void;
  onError: (recorder: TrackRecorder, error: unknown, cause: "storage" | "encoder") => void;
}

/**
 * One MediaRecorder for one kind of track (audio, camera or screen), writing
 * every chunk to its own recording in OPFS. A failure of one recorder never
 * touches the others.
 */
export class TrackRecorder {
  readonly kind: TrackKind;
  private recorder: MediaRecorder | null = null;
  private stopping: Promise<void> | null = null;
  recording!: LocalRecording;

  /** The captured stream this recorder writes. The call publishes clones of its tracks, never the tracks themselves. */
  get stream(): MediaStream {
    return this.init.stream;
  }

  private constructor(private readonly init: RecorderInit) {
    this.kind = init.kind;
  }

  static async start(init: RecorderInit): Promise<TrackRecorder> {
    const instance = new TrackRecorder(init);
    await instance.begin();
    return instance;
  }

  private async begin(): Promise<void> {
    const mime = pickMime(this.kind);
    if (!mime) throw new Error(`no supported WebM codec for ${this.kind}`);
    const recorder = new MediaRecorder(this.init.stream, {
      mimeType: mime,
      ...(this.kind === "audio"
        ? { audioBitsPerSecond: BITRATE_BPS.audio }
        : { videoBitsPerSecond: BITRATE_BPS[this.kind] }),
    });
    this.recorder = recorder;

    const meta: RecordingMeta = {
      version: 1,
      recordingId: newId(),
      sessionId: this.init.sessionId,
      participantId: this.init.participantId,
      trackId: newId(),
      kind: this.kind,
      mime,
      settings: this.init.settings,
      startCallClientMs: 0,
      startClientMs: 0,
      offsetMs: this.init.clock.offsetMs,
      rttMs: this.init.clock.rttMs,
      declareSamples: this.init.clockSamples,
      state: "recording",
      endClientMs: null,
      endReason: null,
      complete: false,
      declared: false,
      clockSamples: [],
      markers: [],
    };

    const started = new Promise<void>((resolve, reject) => {
      // Track start time = the instant of the recorder "start" event on the client clock.
      recorder.onstart = () => {
        meta.startClientMs = clientNowMs();
        resolve();
      };
      recorder.onerror = (event) => reject((event as ErrorEvent).error ?? new Error("recorder error"));
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.recording.append(event.data).catch((error: unknown) => {
        this.init.onError(this, error, "storage");
        void this.stop("error");
      });
    };

    for (const track of this.init.stream.getTracks()) {
      track.addEventListener("ended", () => void this.stop("trackEnded"));
    }

    // The metadata must exist on disk before the first chunk can arrive.
    this.recording = await LocalRecording.create(meta);
    meta.startCallClientMs = clientNowMs();
    recorder.start(TIMESLICE_MS);
    await started;
    recorder.onerror = (event) => {
      this.init.onError(this, (event as ErrorEvent).error ?? new Error("recorder error"), "encoder");
      void this.stop("error");
    };
    await this.recording.saveMeta();
  }

  get active(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Stops the recorder, writes the final chunk and marks the recording stopped. Safe to call twice. */
  stop(reason: EndReason): Promise<void> {
    this.stopping ??= this.finish(reason);
    return this.stopping;
  }

  private async finish(reason: EndReason): Promise<void> {
    const stopRequestedMs = clientNowMs();
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop(); // fires a last dataavailable, then stop
      });
    }
    for (const track of this.init.stream.getTracks()) track.stop();
    await this.recording.flush().catch(() => undefined);
    const { meta } = this.recording;
    meta.state = "stopped";
    meta.endClientMs = stopRequestedMs;
    meta.endReason = reason;
    await this.recording.saveMeta();
    this.init.onEnded(this, reason);
  }
}
