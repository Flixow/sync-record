import {
  CONSENT_VERSION,
  type EndReason,
  type Manifest,
  type MarkerEvent,
  type PresenceState,
  type RosterEntry,
  type ServerEvent,
  type TrackKind,
  type ClockSample,
} from "../../shared/protocol.js";
import { ApiError, SessionApi, saveCredentials, type StoredCredentials } from "./api.js";
import { playBeep, unlockAudio } from "./audio.js";
import { ClockSync, clientNowMs } from "./clock.js";
import {
  listDevices,
  measureBleed,
  onDeviceChange,
  openCamera,
  openMic,
  openScreen,
  streamSettings,
  watchLevel,
  type DeviceLists,
} from "./devices.js";
import { guessHeadphones, type BleedVerdict, type HeadphoneGuess } from "./headphones.js";
import { LocalRecording } from "./opfs.js";
import { TrackRecorder, pickMime } from "./recorder.js";
import { screenControls, takeContinues, type ScreenControls } from "./screen-share.js";
import { minutesLeft, storageLevel, type StorageLevel } from "./storage-math.js";
import { Uploader } from "./uploader.js";
import { t } from "../i18n/index.js";
import { supported } from "./support.js";

export type Phase = "setup" | "recording" | "finished";
export type Permission = "unknown" | "granted" | "denied";
export type Headphones = "unset" | "yes" | "skipped";

export interface Notice {
  id: number;
  kind: "info" | "warn" | "error";
  text: string;
}

export interface StorageInfo {
  quota: number;
  usage: number;
  free: number;
}

/** Round trip recorded when the clock handshake could not run; the manifest treats it as "offset unknown". */
export const UNKNOWN_RTT_MS = 1e9;
const LOCK_PREFIX = "syncrecord:session:";

/**
 * All logic of one participant in one session: devices, consent, recording,
 * crash recovery, uploads, presence. The DOM only reads `state` and calls the
 * methods; `subscribe` fires after every change.
 */
export class Room {
  readonly api: SessionApi;
  readonly uploader: Uploader;
  readonly clock: ClockSync;

  // observable state
  phase: Phase = "setup";
  missingFeatures: string[] = supported();
  fatal: "invalid" | "notFound" | null = null;
  lock: "checking" | "held" | "blocked" = "checking";
  permission: Permission = "unknown";
  devices: DeviceLists = { mics: [], cameras: [], outputs: [] };
  micId = "";
  camId = "";
  wantCamera = true;
  wantScreen = false;
  deviceError: string | null = null;
  level = 0;
  previewCamera: MediaStream | null = null;
  headphones: Headphones = "unset";
  /** True while the ticked box came from the device-name guess, not from the user. */
  headphonesAuto = false;
  guess: { guess: HeadphoneGuess; matched: string | null } = { guess: "unknown", matched: null };
  bleed: { verdict: BleedVerdict; riseDb: number } | null = null;
  bleedBusy = false;
  consent = false;
  storage: StorageInfo | null = null;
  persisted: boolean | null = null;
  liveStorage: { level: StorageLevel; free: number; minutes: number } | null = null;
  starting = false;
  roster: RosterEntry[] = [];
  ended = false;
  recorders: TrackRecorder[] = [];
  recordings: LocalRecording[] = [];
  recoveredCount = 0;
  private recoveredIds = new Set<string>();
  /** True while a recovered recording still waits for its upload to finish. */
  get recoveryPending(): boolean {
    return this.recordings.some((rec) => this.recoveredIds.has(rec.meta.recordingId) && !rec.meta.complete);
  }
  startedAtMs: number | null = null;
  clapUntilMs = 0;
  results: Manifest | null = null;
  notices: Notice[] = [];
  online = true;

  private micStream: MediaStream | null = null;
  private camStream: MediaStream | null = null;
  private stopLevel: (() => void) | null = null;
  private events: EventSource | null = null;
  private listeners = new Set<() => void>();
  private levelListeners = new Set<(level: number) => void>();
  private releaseLock: (() => void) | null = null;
  private storageTimer: number | null = null;
  private resultsTimer: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private lastPresence = "";
  private noticeSeq = 0;
  private disposed = false;
  private offDeviceChange: (() => void) | null = null;

  constructor(
    readonly sid: string,
    readonly creds: StoredCredentials,
  ) {
    this.api = new SessionApi(sid, creds.participantToken);
    this.uploader = new Uploader(this.api);
    this.clock = new ClockSync(() => this.api.clock());
    // Samples taken while recording go into every active recording, so a crash keeps them.
    this.clock.onSample = (sample) => {
      for (const recorder of this.recorders.filter((r) => r.active)) {
        recorder.recording.meta.clockSamples.push(sample);
        void recorder.recording.saveMeta();
      }
    };
    this.uploader.subscribe(() => this.notify());
    window.addEventListener("beforeunload", this.onBeforeUnload);
    document.addEventListener("visibilitychange", this.onVisibility);
    document.addEventListener("keydown", this.onKeyDown);
  }

  // ---- plumbing ----------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The microphone level changes ~12 times a second, so it has its own cheap channel. */
  onLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
    this.syncPresence();
  }

  get isHost(): boolean {
    return this.creds.host;
  }

  get kinds(): TrackKind[] {
    const kinds: TrackKind[] = ["audio"];
    if (this.wantCamera && this.devices.cameras.length > 0) kinds.push("camera");
    if (this.wantScreen) kinds.push("screen");
    return kinds;
  }

  /** Recordings of this participant on this device that are not fully uploaded yet. */
  get unfinishedRecordings(): LocalRecording[] {
    return this.recordings.filter((rec) => !rec.meta.complete);
  }

  get recordingKinds(): TrackKind[] {
    return this.recorders.filter((recorder) => recorder.active).map((recorder) => recorder.kind);
  }

  /** Reasons the Start button is still disabled. */
  get missingToStart(): string[] {
    const missing: string[] = [];
    if (this.permission !== "granted" || !this.micStream) missing.push(t("start.need.mic"));
    if (!this.consent) missing.push(t("start.need.consent"));
    if (this.headphones === "unset") missing.push(t("start.need.headphones"));
    return missing;
  }

  private notice(kind: Notice["kind"], text: string): void {
    this.notices = [...this.notices.filter((item) => item.text !== text), { id: (this.noticeSeq += 1), kind, text }];
    this.notify();
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((item) => item.id !== id);
    this.notify();
  }

  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.recordingKinds.length > 0 || this.uploader.busy()) event.preventDefault();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible" && this.recordingKinds.length > 0) void this.acquireWakeLock();
  };

  private async acquireWakeLock(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null; // best effort only
    }
  }

  private syncPresence(): void {
    if (this.fatal || this.lock !== "held") return;
    let state: PresenceState = "idle";
    if (this.recordingKinds.length > 0) state = "recording";
    else if (this.phase === "finished") state = "stopped";
    else if (this.missingToStart.length === 0) state = "ready";
    const kinds = state === "recording" ? this.recordingKinds : [];
    const key = `${state}:${kinds.join(",")}`;
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    void this.api
      .status({ state, kinds, ...(state === "recording" ? { consentVersion: CONSENT_VERSION } : {}) })
      .catch(() => {
        this.lastPresence = ""; // retried on the next change
      });
  }

  // ---- startup -----------------------------------------------------------

  async init(): Promise<void> {
    if (this.missingFeatures.length > 0) return this.notify();
    await this.acquireLock();
    if (this.lock !== "held") return this.notify();
    await this.afterLock();
  }

  /** "Try again" after the user closed the other tab. The lock is never taken from a tab that may still be recording. */
  async retryLock(): Promise<void> {
    await this.acquireLock();
    if (this.lock === "held") await this.afterLock();
    this.notify();
  }

  private async acquireLock(): Promise<void> {
    // A tab that just crashed may still hold the lock for a moment: retry before giving up.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const acquired = await new Promise<boolean>((resolve) => {
        void navigator.locks.request(LOCK_PREFIX + this.sid, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return new Promise<void>((release) => {
            this.releaseLock = release;
          });
        });
      });
      if (acquired) {
        this.lock = "held";
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.lock = "blocked";
  }

  private async afterLock(): Promise<void> {
    try {
      const view = await this.api.view();
      if (view.renewedToken) this.api.token = view.renewedToken; // sliding expiry: every visit renews the token
      if (view.renewedInviteToken) this.creds.inviteToken = view.renewedInviteToken; // the invite link of a host that comes back must not have expired
      this.roster = view.roster;
      this.ended = view.ended;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.fatal = "invalid";
      else if (error instanceof ApiError && error.status === 404) this.fatal = "notFound";
      else this.notice("error", t("err.server"));
      if (this.fatal) {
        // Local copies stay reachable (download or delete) even when the token is no longer accepted.
        this.recordings = (await LocalRecording.list(this.sid).catch(() => [])).filter((rec) => rec.meta.participantId === this.creds.participantId);
        return this.notify();
      }
    }
    saveCredentials(this.sid, { ...this.creds, participantToken: this.api.token });
    void this.clock.handshake().then(() => this.notify()).catch(() => this.notice("error", t("err.server")));
    this.connectEvents();
    await this.recoverRecordings();
    await this.refreshStorage();
    this.offDeviceChange = onDeviceChange(() => void this.refreshDevices());
    await this.refreshDevices();
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (status.state === "granted") await this.requestPermissions();
    } catch {
      // permission query is optional
    }
    if (this.ended) this.phase = "finished";
    this.notify();
    if (this.ended && this.isHost) void this.pollResults();
  }

  private connectEvents(): void {
    const source = new EventSource(this.api.eventsUrl());
    this.events = source;
    source.onmessage = (message) => this.onEvent(JSON.parse(message.data as string) as ServerEvent);
    source.onerror = () => {
      this.online = false;
      this.notify();
    };
    source.onopen = () => {
      this.online = true;
      this.notify();
    };
  }

  private onEvent(event: ServerEvent): void {
    if (event.type === "roster") {
      this.roster = event.roster;
    } else if (event.type === "marker") {
      this.onMarker(event.marker);
    } else if (event.type === "ended") {
      this.ended = true;
      void this.stopMine("sessionEnded").then(() => {
        if (this.isHost) void this.pollResults();
      });
    }
    this.notify();
  }

  // ---- crash recovery ----------------------------------------------------

  /** Finds recordings left in OPFS (also from a tab that was killed) and resumes their upload. */
  private async recoverRecordings(): Promise<void> {
    try {
      this.recordings = (await LocalRecording.list(this.sid)).filter((rec) => rec.meta.participantId === this.creds.participantId);
    } catch (error) {
      this.notice("warn", t("err.generic", { message: error instanceof Error ? error.message : "OPFS" }));
      return;
    }
    let unfinished = 0;
    for (const recording of this.recordings) {
      const { meta } = recording;
      if (meta.state === "recording") {
        // The tab that owned this recorder is gone: close the recording where it ends.
        meta.state = "stopped";
        meta.endReason = "crash";
        meta.endClientMs = null;
        await recording.saveMeta();
      }
      if (!meta.complete) unfinished += 1;
      this.uploader.add(recording);
    }
    this.recoveredCount = unfinished;
    this.recoveredIds = new Set(this.recordings.filter((rec) => !rec.meta.complete).map((rec) => rec.meta.recordingId));
  }

  // ---- devices -----------------------------------------------------------

  private async refreshDevices(): Promise<void> {
    try {
      this.devices = await listDevices();
    } catch {
      return;
    }
    // Re-run on every device change: the guess depends on what is plugged in.
    this.guess = guessHeadphones([...this.devices.mics, ...this.devices.outputs].map((d) => ({ kind: d.kind, label: d.label })));
    if (this.headphones === "unset" && this.guess.guess === "likely") {
      this.headphones = "yes";
      this.headphonesAuto = true;
    } else if (this.headphonesAuto && this.headphones === "yes" && this.guess.guess !== "likely") {
      // The device that made us tick the box is gone (unplugged): hand the decision back to the user.
      this.headphones = "unset";
      this.headphonesAuto = false;
    }
    if (!this.devices.mics.some((d) => d.deviceId === this.micId)) this.micId = "";
    if (!this.devices.cameras.some((d) => d.deviceId === this.camId)) this.camId = "";
    this.notify();
  }

  async requestPermissions(): Promise<void> {
    this.deviceError = null;
    try {
      await this.openPreviewMic();
      if (this.wantCamera) await this.openPreviewCamera().catch(() => undefined);
      this.permission = "granted";
    } catch (error) {
      const name = (error as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") this.permission = "denied";
      else this.deviceError = error instanceof Error ? error.message : String(error);
    }
    await this.refreshDevices();
  }

  private async openPreviewMic(): Promise<void> {
    this.stopLevel?.();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = await openMic(this.micId || undefined);
    this.micId = this.micStream.getAudioTracks()[0]?.getSettings().deviceId ?? this.micId;
    this.stopLevel = watchLevel(this.micStream, (level) => {
      this.level = level;
      this.levelListeners.forEach((listener) => listener(level));
    });
  }

  private async openPreviewCamera(): Promise<void> {
    this.camStream?.getTracks().forEach((track) => track.stop());
    this.camStream = await openCamera(this.camId || undefined);
    this.camId = this.camStream.getVideoTracks()[0]?.getSettings().deviceId ?? this.camId;
    this.previewCamera = this.camStream;
  }

  async selectMic(deviceId: string): Promise<void> {
    this.micId = deviceId;
    this.deviceError = null;
    try {
      await this.openPreviewMic();
    } catch (error) {
      this.deviceError = t("setup.deviceError", { message: error instanceof Error ? error.message : String(error) });
    }
    this.notify();
  }

  async selectCamera(deviceId: string): Promise<void> {
    this.camId = deviceId;
    this.deviceError = null;
    try {
      await this.openPreviewCamera();
    } catch (error) {
      this.deviceError = t("setup.deviceError", { message: error instanceof Error ? error.message : String(error) });
    }
    this.notify();
  }

  async setWantCamera(value: boolean): Promise<void> {
    this.wantCamera = value;
    if (!value) {
      this.camStream?.getTracks().forEach((track) => track.stop());
      this.camStream = null;
      this.previewCamera = null;
    } else if (this.permission === "granted") {
      await this.openPreviewCamera().catch(() => undefined);
    }
    this.notify();
  }

  setWantScreen(value: boolean): void {
    this.wantScreen = value;
    this.notify();
  }

  // ---- headphones --------------------------------------------------------

  setHeadphones(value: Headphones): void {
    this.headphones = value;
    this.headphonesAuto = false;
    this.notify();
  }

  async runBleedTest(): Promise<void> {
    if (!this.micStream || this.bleedBusy) return;
    this.bleedBusy = true;
    this.bleed = null;
    this.notify();
    try {
      await unlockAudio();
      this.bleed = await measureBleed(this.micStream);
      if (this.bleed.verdict === "bleed" && this.headphones === "yes" && this.headphonesAuto) {
        this.headphones = "unset"; // the measurement contradicts the guess
        this.headphonesAuto = false;
      }
    } finally {
      this.bleedBusy = false;
      this.notify();
    }
  }

  setConsent(value: boolean): void {
    this.consent = value;
    this.notify();
  }

  // ---- storage -----------------------------------------------------------

  async refreshStorage(): Promise<void> {
    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      this.storage = { quota, usage, free: Math.max(0, quota - usage) };
      this.persisted = (await navigator.storage.persisted?.()) ?? null;
      if (this.persisted === false) this.persisted = (await navigator.storage.persist?.()) ?? false;
    } catch {
      this.storage = null;
    }
    this.notify();
  }

  private async checkStorageWhileRecording(): Promise<void> {
    await this.refreshStorage();
    if (!this.storage) return;
    const kinds = this.recordingKinds;
    const level = storageLevel(this.storage.free, kinds);
    this.liveStorage = { level, free: this.storage.free, minutes: minutesLeft(this.storage.free, kinds) };
    this.notify();
  }

  // ---- recording ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.starting || this.missingToStart.length > 0) return;
    this.starting = true;
    this.notify();
    try {
      // Browsers only allow the screen picker straight after a click, so it goes first.
      void unlockAudio();
      let screen: MediaStream | null = null;
      if (this.wantScreen) {
        try {
          screen = await openScreen();
        } catch {
          this.notice("warn", t("err.screenDenied"));
        }
      }
      const mic = await this.liveStream("audio");
      const camera = this.wantCamera && this.devices.cameras.length > 0 ? await this.liveStream("camera").catch(() => null) : null;

      for (const [kind, stream] of [["audio", mic], ["camera", camera], ["screen", screen]] as const) {
        if (stream && !pickMime(kind)) {
          stream.getTracks().forEach((track) => track.stop());
          this.notice("error", t("err.codec", { kind: t(`rec.track.${kind}`) }));
          if (kind === "audio") throw new Error(t("err.codec", { kind: t("rec.track.audio") }));
        }
      }

      // Clock handshake right before the recorders start: the start time of each
      // track is converted to server time with this offset.
      let best: { offsetMs: number; rttMs: number };
      try {
        await this.clock.handshake(5);
        best = this.clock.best();
      } catch {
        // Local-first: an unreachable collector must not stop the recording. The offset is marked
        // unknown (huge round trip) and later periodic samples let post-production fix the start time.
        best = this.clock.hasSamples() ? this.clock.best() : { offsetMs: 0, rttMs: UNKNOWN_RTT_MS };
        this.notice("warn", t("err.clockUnavailable"));
      }
      const samples = this.clock.samples.slice(-5);
      const make = (kind: TrackKind, stream: MediaStream): Promise<TrackRecorder> => this.startRecorder(kind, stream, best, samples);

      const wanted: [TrackKind, MediaStream][] = [["audio", mic]];
      if (camera) wanted.push(["camera", camera]);
      if (screen) wanted.push(["screen", screen]);
      const results = await Promise.allSettled(wanted.map(([kind, stream]) => make(kind, stream)));
      const started = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const audioFailed = results[0]?.status === "rejected";
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.notice("error", t("err.start", { message: `${t(`rec.track.${wanted[index]?.[0] ?? "audio"}`)}: ${message}` }));
        }
      });
      if (audioFailed || started.length === 0) {
        await Promise.all(started.map((recorder) => recorder.stop("error")));
        wanted.forEach(([, stream]) => stream.getTracks().forEach((track) => track.stop()));
        return;
      }

      this.recorders = [...this.recorders, ...started];
      for (const recorder of started) {
        this.adopt(recorder);
        const stream = wanted.find(([kind]) => kind === recorder.kind)?.[1];
        // The mic and camera previews were handed to the recorders: reopen them on the next setup.
        if (stream === this.micStream) this.micStream = null;
        if (stream === this.camStream) {
          this.camStream = null;
          this.previewCamera = null;
        }
      }
      this.stopLevel?.();
      this.stopLevel = null;
      this.phase = "recording";
      this.startedAtMs = clientNowMs();
      this.clock.startPeriodic();
      this.storageTimer = window.setInterval(() => void this.checkStorageWhileRecording(), 15_000);
      void this.checkStorageWhileRecording();
      void this.acquireWakeLock();
      await this.markNow("start-beep");
      this.notify();
    } catch (error) {
      this.notice("error", t("err.start", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.starting = false;
      this.notify();
    }
  }

  /** The stream for a kind: the preview stream when still live, otherwise a fresh one. */
  private async liveStream(kind: "audio" | "camera"): Promise<MediaStream> {
    const existing = kind === "audio" ? this.micStream : this.camStream;
    if (existing && existing.getTracks().every((track) => track.readyState === "live")) return existing;
    const stream = kind === "audio" ? await openMic(this.micId || undefined) : await openCamera(this.camId || undefined);
    if (kind === "audio") this.micStream = stream;
    else this.camStream = stream;
    return stream;
  }

  private startRecorder(kind: TrackKind, stream: MediaStream, clock: { offsetMs: number; rttMs: number }, clockSamples: ClockSample[]): Promise<TrackRecorder> {
    return TrackRecorder.start({
      kind,
      stream,
      sessionId: this.sid,
      participantId: this.creds.participantId,
      clock: { offsetMs: clock.offsetMs, rttMs: clock.rttMs },
      clockSamples,
      settings: streamSettings(stream),
      onEnded: (recorder, reason) => this.onRecorderEnded(recorder, reason),
      onError: (_recorder, error, cause) =>
        this.notice("error", t(cause === "storage" ? "err.disk" : "err.recorder", { message: error instanceof Error ? error.message : String(error) })),
    });
  }

  /** A started recorder joins the take: it is listed, saved and uploaded like the others. */
  private adopt(recorder: TrackRecorder): void {
    this.recordings = [...this.recordings, recorder.recording];
    recorder.recording.onChange(() => this.notify());
    this.uploader.add(recorder.recording);
  }

  // ---- screen sharing during the take -------------------------------------

  private sharePending = false;

  /** What the Share screen and Stop sharing buttons may do now. */
  get screenControls(): ScreenControls {
    return screenControls(this.phase === "recording", this.recorders, this.sharePending);
  }

  /**
   * Starts a screen recorder of its own (a new segment on the server) while the take runs. Needs the click that calls it:
   * the picker only opens on a user gesture. The microphone and camera are not touched.
   */
  async shareScreen(): Promise<void> {
    if (!this.screenControls.share) return;
    this.sharePending = true;
    this.notify();
    let stream: MediaStream | null = null;
    try {
      try {
        stream = await openScreen();
      } catch {
        this.notice("warn", t("err.screenDenied"));
        return;
      }
      // the take may have been stopped while the picker was open
      if (this.phase !== "recording") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!pickMime("screen")) {
        stream.getTracks().forEach((track) => track.stop());
        this.notice("error", t("err.codec", { kind: t("rec.track.screen") }));
        return;
      }
      const best = this.clock.hasSamples() ? this.clock.best() : { offsetMs: 0, rttMs: UNKNOWN_RTT_MS };
      const recorder = await this.startRecorder("screen", stream, best, this.clock.samples.slice(-5));
      stream = null;
      this.recorders = [...this.recorders, recorder];
      this.adopt(recorder);
      this.notices = this.notices.filter((item) => item.text !== t("rec.screenEnded"));
      // the take was stopped while the recorder started: keep what it has and close it with the rest
      if (this.phase !== "recording") await recorder.stop("stopped");
      else void this.checkStorageWhileRecording();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      this.notice("error", t("err.start", { message: `${t("rec.track.screen")}: ${error instanceof Error ? error.message : String(error)}` }));
    } finally {
      this.sharePending = false;
      this.notify();
    }
  }

  /** Stops the screen recorder only; the take goes on with the other tracks. */
  async stopSharing(): Promise<void> {
    await Promise.all(this.recorders.filter((recorder) => recorder.kind === "screen" && recorder.active).map((recorder) => recorder.stop("stopped")));
    this.notify();
  }

  private onRecorderEnded(recorder: TrackRecorder, reason: EndReason): void {
    if (reason === "trackEnded") {
      this.notice("warn", recorder.kind === "screen" ? t("rec.screenEnded") : t("rec.trackEnded", { kind: t(`rec.track.${recorder.kind}`) }));
    }
    if (!takeContinues(this.recorders) && this.phase === "recording") this.finishRecording();
    this.notify();
  }

  private finishRecording(): void {
    this.phase = "finished";
    this.clock.stopPeriodic();
    if (this.storageTimer !== null) window.clearInterval(this.storageTimer);
    this.storageTimer = null;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.liveStorage = null;
    this.clapUntilMs = 0;
  }

  async stopMine(reason: EndReason = "stopped"): Promise<void> {
    if (this.recordingKinds.length > 0) await this.clock.finalSample();
    await Promise.all(this.recorders.filter((recorder) => recorder.active).map((recorder) => recorder.stop(reason)));
    if (this.phase === "recording") this.finishRecording();
    if (this.ended) {
      this.phase = "finished";
      this.releasePreview();
    }
    this.notify();
  }

  private releasePreview(): void {
    this.stopLevel?.();
    this.stopLevel = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.camStream?.getTracks().forEach((track) => track.stop());
    this.camStream = null;
    this.previewCamera = null;
    this.level = 0;
  }

  /** Back to setup after a take: devices must be opened again. */
  async recordAnother(): Promise<void> {
    this.recorders = [];
    this.highlights = [];
    this.phase = "setup";
    this.startedAtMs = null;
    this.lastPresence = "";
    await this.requestPermissions();
    this.notify();
  }

  private async markNow(kind: "start-beep" | "host-beep", atClientMs?: number): Promise<void> {
    const info = playBeep(atClientMs);
    this.clapUntilMs = Math.max(this.clapUntilMs, atClientMs ?? clientNowMs()) + 8000;
    window.setTimeout(() => this.notify(), Math.max(0, this.clapUntilMs - clientNowMs()) + 50);
    const id = `${kind}-${Math.round(info.atClientMs)}`;
    for (const recorder of this.recorders.filter((r) => r.active)) {
      recorder.recording.meta.markers.push({ id, kind, atClientMs: info.atClientMs, outputLatencyMs: info.outputLatencyMs });
      await recorder.recording.saveMeta();
    }
  }

  private onMarker(marker: MarkerEvent): void {
    if (this.recordingKinds.length === 0) return;
    const atClientMs = marker.atServerMs - this.clock.best().offsetMs;
    void this.markNow("host-beep", atClientMs);
  }

  /** Highlights flagged on this device during the current take, as seconds since the take started. */
  highlights: number[] = [];

  /** Flags this moment in every active track (key M or the button); post-production uses it to suggest clips. */
  async markHighlight(): Promise<void> {
    const active = this.recorders.filter((recorder) => recorder.active);
    if (active.length === 0) return;
    const atClientMs = clientNowMs();
    const id = `highlight-${Math.round(atClientMs)}`;
    this.highlights.push((atClientMs - (this.startedAtMs ?? atClientMs)) / 1000);
    for (const recorder of active) {
      recorder.recording.meta.markers.push({ id, kind: "highlight", atClientMs, outputLatencyMs: null });
      await recorder.recording.saveMeta();
    }
    this.notify();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() !== "m" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    void this.markHighlight();
  };

  async hostBeep(): Promise<void> {
    await unlockAudio();
    await this.api.marker().catch(() => this.notice("error", t("err.server")));
  }

  // ---- recordings on this device ----------------------------------------

  async download(recording: LocalRecording): Promise<void> {
    const blob = await recording.toBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${recording.meta.kind}-${new Date(recording.meta.startClientMs).toISOString().replace(/[:.]/g, "-")}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async deleteLocal(recording: LocalRecording): Promise<void> {
    this.uploader.cancel(recording);
    this.recorders = this.recorders.filter((recorder) => recorder.recording !== recording);
    await recording.remove();
    this.recordings = this.recordings.filter((item) => item !== recording);
    await this.refreshStorage();
  }

  // ---- host --------------------------------------------------------------

  async endSession(force = false): Promise<void> {
    try {
      this.results = await this.api.end(force);
      this.ended = true;
      await this.stopMine("sessionEnded");
      void this.pollResults();
    } catch (error) {
      this.notice("error", t("err.generic", { message: error instanceof Error ? error.message : String(error) }));
    }
    this.notify();
  }

  async pollResults(): Promise<void> {
    if (this.resultsTimer !== null) window.clearTimeout(this.resultsTimer);
    try {
      this.results = await this.api.manifest();
    } catch {
      this.results = null;
    }
    this.notify();
    const pending = this.results?.participants.some((p) => p.tracks.some((track) => track.status === "pending" || track.status === "receiving")) ?? true;
    if (pending && !this.disposed) this.resultsTimer = window.setTimeout(() => void this.pollResults(), 4000);
  }

  // ---- teardown ----------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    document.removeEventListener("keydown", this.onKeyDown);
    this.stopLevel?.();
    this.events?.close();
    this.clock.stopPeriodic();
    this.offDeviceChange?.();
    if (this.storageTimer !== null) window.clearInterval(this.storageTimer);
    if (this.resultsTimer !== null) window.clearTimeout(this.resultsTimer);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.camStream?.getTracks().forEach((track) => track.stop());
    this.releaseLock?.();
  }
}
