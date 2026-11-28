// Synthetic recording sessions with known truth: tone bursts and video flashes at known instants of one shared timeline,
// recorded by tracks that start at known offsets and whose audio clock drifts by a known amount.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Manifest, ManifestParticipant, ManifestTrack } from "../../src/shared/protocol.js";

const run = promisify(execFile);

export interface SyntheticParticipant {
  name: string;
  /** True start of this participant's tracks after the first participant started, in ms. */
  startOffsetMs: number;
  /** Audio device clock drift: media seconds per true second minus one, in ppm. */
  audioPpm: number;
  /** Drift of the client clock against the server clock in ppm (what the handshake samples reveal). */
  clientClockPpm: number;
  camera: boolean;
  /** Use this audio file (speech, noise, silence) instead of the tone bursts. Its length sets the track length; offset and drift still apply. */
  audioFile?: string;
  /** Share of camera frames dropped to make the frame rate variable, 0..1. */
  droppedFrames?: number;
  /** Screen shares during the take, in order: each one is its own screen track (screen.webm, screen-2.webm, ...) starting this long after the participant's tracks. */
  screens?: { startMs: number; durationSec: number }[];
}

export interface SyntheticOptions {
  sessionId: string;
  storageDir: string;
  /** Length of the shared timeline in seconds (every track records until its own end). */
  durationSec: number;
  participants: SyntheticParticipant[];
  /** Timeline instants (ms) of the tone bursts and flashes. */
  eventsMs?: number[];
  /** Error of the clock handshake's start estimate, per participant in ms (default 0). */
  startErrorMs?: number[];
  /** Camera resolution; small by default so an hour renders quickly. */
  cameraSize?: string;
  cameraFps?: number;
  /** Camera picture: "flash" (black with white flashes at the events, default) or "barcode" (a moving test pattern with the media frame number as a 16-bit barcode in the top left corner). */
  cameraPicture?: "flash" | "barcode";
}

export interface SyntheticTruth {
  sessionId: string;
  eventsMs: number[];
  participants: { id: string; startOffsetMs: number; audioPpm: number }[];
}

export const BURST_SEC = 0.12;
/** Barcode of the media frame number: 16 bits, each BARCODE_BIT pixels wide, least significant bit on the left. */
export const BARCODE_BIT = 20;
export const BARCODE_WIDTH = 16 * BARCODE_BIT;
export const BARCODE_HEIGHT = 24;
export const FLASH_SEC = 0.25;

/** Default events: near the start, then evenly spread, the last one close to the end. */
export function defaultEvents(durationSec: number): number[] {
  const events = [3000];
  const steps = 6;
  for (let step = 1; step < steps; step++) events.push(Math.round((durationSec * 1000 * step) / steps));
  events.push(durationSec * 1000 - 4000);
  return events;
}

const ffmpeg = (args: string[]): Promise<unknown> => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });

async function probeSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

function window(starts: number[], length: number): string {
  return starts.map((start) => `between(t,${start.toFixed(4)},${(start + length).toFixed(4)})`).join("+") || "0";
}

export async function makeSyntheticSession(options: SyntheticOptions): Promise<SyntheticTruth> {
  const events = options.eventsMs ?? defaultEvents(options.durationSec);
  const origin = 1_900_000_000_000; // server clock instant of the first track's start
  const participants: ManifestParticipant[] = [];
  const truth: SyntheticTruth = { sessionId: options.sessionId, eventsMs: events, participants: [] };
  const sessionDir = path.join(options.storageDir, "session", options.sessionId);

  for (const [index, spec] of options.participants.entries()) {
    const pid = `p${index + 1}-${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const dir = path.join(sessionDir, pid);
    await mkdir(dir, { recursive: true });
    const rate = 1 + spec.audioPpm * 1e-6;
    const trueSpanSec = options.durationSec - spec.startOffsetMs / 1000;
    const fileSec = spec.audioFile ? await probeSeconds(spec.audioFile) : null;
    const mediaSec = fileSec ?? trueSpanSec * rate;
    // An event at timeline time T is heard (T - start) true seconds after the track began, which is (T - start) * rate of media.
    const positions = events.map((event) => ((event - spec.startOffsetMs) / 1000) * rate).filter((position) => position > 0.2 && position < mediaSec - 0.5);

    const audio = path.join(dir, "audio.webm");
    if (spec.audioFile) {
      await ffmpeg(["-i", spec.audioFile, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-f", "webm", audio]);
    } else {
      await ffmpeg([
        "-f", "lavfi", "-i", `sine=frequency=${900 + index * 150}:sample_rate=48000:duration=${mediaSec.toFixed(4)}`,
        "-af", `volume=0:enable='1-(${window(positions, BURST_SEC)})'`,
        "-c:a", "libopus", "-b:a", "48k", "-f", "webm", audio,
      ]);
    }
    const tracks: ManifestTrack[] = [];
    const clientStart = 5_000_000 + index * 1_234_567;
    const slope = -spec.clientClockPpm * 1e-6;
    const startError = options.startErrorMs?.[index] ?? 0;
    const trueStartServer = origin + spec.startOffsetMs;
    const offset0 = trueStartServer - clientStart;
    const clientSpanMs = (trueSpanSec * 1000) / (1 + slope);
    const samples = [] as { atClientMs: number; offsetMs: number; rttMs: number }[];
    for (let at = 0; at <= clientSpanMs; at += 60_000) {
      samples.push({ atClientMs: clientStart + at, offsetMs: offset0 + slope * at, rttMs: 6 + ((at / 60_000) % 3) });
    }
    samples.push({ atClientMs: clientStart + clientSpanMs, offsetMs: offset0 + slope * clientSpanMs, rttMs: 7 });
    const common = {
      segment: 1,
      mime: "",
      settings: {},
      startCallClientMs: clientStart - 5,
      startClientMs: clientStart,
      startServerMsEstimated: trueStartServer + startError,
      clock: { convention: "serverTimeMs = clientTimeMs + offsetMs" as const, offsetMs: offset0, rttMs: 6, uncertaintyMs: 3, samples },
      markers: [],
      endClientMs: clientStart + clientSpanMs,
      endReason: "stopped" as const,
      bytesReceived: 1,
      chunkCount: 1,
      status: "ok" as const,
      error: null,
    };
    tracks.push({ ...common, trackId: `${pid}-audio-0001`.replace(/_/g, "-"), kind: "audio", file: "audio.webm", mime: "audio/webm;codecs=opus", durationSec: mediaSec });

    if (spec.camera) {
      const fps = options.cameraFps ?? 30;
      const camera = path.join(dir, "camera.webm");
      const size = options.cameraSize ?? "320x180";
      const flashes = events.map((event) => ((event - spec.startOffsetMs) / 1000) * rate).filter((position) => position > 0.2 && position < mediaSec - 0.5);
      const drop = spec.droppedFrames ?? 0.1;
      const filters = [`drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${window(flashes, FLASH_SEC)}'`];
      // Frames are dropped at random (a variable frame rate) except while a flash is on, so the flash is always seen.
      if (drop > 0) filters.push(`select='gt(random(0)\\,${drop})+${window(flashes, FLASH_SEC)}'`);
      if (options.cameraPicture === "barcode") {
        await ffmpeg([
          "-f", "lavfi", "-i", `testsrc2=s=${size}:r=${fps}:d=${mediaSec.toFixed(4)}`,
          "-f", "lavfi", "-i", `color=c=black:s=${BARCODE_WIDTH}x${BARCODE_HEIGHT}:r=${fps}:d=${mediaSec.toFixed(4)},format=gray,geq=lum='255*bitand(floor(N+0.5)\\,pow(2\\,floor(X/${BARCODE_BIT})))/pow(2\\,floor(X/${BARCODE_BIT}))'`,
          "-filter_complex", "[0:v][1:v]overlay=0:0,format=yuv420p[v]", "-map", "[v]",
          "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-tile-columns", "2", "-threads", "4", "-crf", "18", "-b:v", "0", "-g", "60", "-f", "webm", camera,
        ]);
      } else {
        await ffmpeg([
          "-f", "lavfi", "-i", `color=c=black:s=${size}:r=${fps}:d=${mediaSec.toFixed(4)}`,
          "-vf", filters.join(","), "-fps_mode", "vfr", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "120k", "-pix_fmt", "yuv420p", "-f", "webm", camera,
        ]);
      }
      tracks.push({ ...common, trackId: `${pid}-camera-0001`, kind: "camera", file: "camera.webm", mime: "video/webm;codecs=vp9", durationSec: mediaSec });
    }
    for (const [n, share] of (spec.screens ?? []).entries()) {
      const file = n === 0 ? "screen.webm" : `screen-${n + 1}.webm`;
      await ffmpeg([
        "-f", "lavfi", "-i", `testsrc2=s=${options.cameraSize ?? "320x180"}:r=10:d=${share.durationSec.toFixed(4)}`,
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "150k", "-pix_fmt", "yuv420p", "-f", "webm", path.join(dir, file),
      ]);
      tracks.push({
        ...common,
        trackId: `${pid}-screen-${String(n + 1).padStart(4, "0")}`,
        kind: "screen",
        segment: n + 1,
        file,
        mime: "video/webm;codecs=vp9",
        durationSec: share.durationSec,
        startCallClientMs: clientStart + share.startMs - 5,
        startClientMs: clientStart + share.startMs,
        startServerMsEstimated: trueStartServer + share.startMs + startError,
        endClientMs: clientStart + share.startMs + share.durationSec * 1000,
      });
    }
    participants.push({
      participantId: pid,
      displayName: spec.name,
      host: index === 0,
      joinedAtServerMs: origin - 10_000,
      consent: { version: "test", atServerMs: origin - 5000 },
      userAgent: null,
      tracks,
    });
    truth.participants.push({ id: pid, startOffsetMs: spec.startOffsetMs, audioPpm: spec.audioPpm });
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    app: { name: "syncrecord", version: "test" },
    sessionId: options.sessionId,
    createdAtServerMs: origin - 20_000,
    endedAtServerMs: origin + options.durationSec * 1000 + 1000,
    participants,
  };
  await writeFile(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(sessionDir, "truth.json"), JSON.stringify(truth, null, 2));
  return truth;
}

/** Instants (ms on the timeline) at which a mono 48 kHz s16le stream rises above the threshold after silence. */
export class BurstDetector {
  private index = 0;
  private quiet = 0;
  readonly onsets: number[] = [];
  private pendingByte: Buffer = Buffer.alloc(0);
  constructor(
    private readonly threshold = 3000,
    private readonly sampleRate = 48_000,
    /** Silence needed before a rise counts as a new burst, in samples. */
    private readonly gap = 0.4 * 48_000,
  ) {
    this.quiet = this.gap;
  }

  push(chunk: Buffer): void {
    const data = this.pendingByte.length > 0 ? Buffer.concat([this.pendingByte, chunk]) : chunk;
    const whole = data.length - (data.length % 2);
    for (let offset = 0; offset < whole; offset += 2) {
      const value = Math.abs(data.readInt16LE(offset));
      if (value > this.threshold) {
        if (this.quiet >= this.gap) this.onsets.push((this.index / this.sampleRate) * 1000);
        this.quiet = 0;
      } else {
        this.quiet += 1;
      }
      this.index += 1;
    }
    this.pendingByte = data.subarray(whole);
  }
}
