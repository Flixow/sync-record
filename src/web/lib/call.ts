import type { CallTokenResponse } from "../../shared/protocol.js";
import { t } from "../i18n/index.js";
import { ApiError } from "./api.js";
import type { CallMember } from "./call-model.js";

import type * as LiveKit from "livekit-client";

/** The three things this participant may send into the call. They map to the three recorded kinds of track. */
export type CallSource = "microphone" | "camera" | "screen";
const SOURCES: readonly CallSource[] = ["microphone", "camera", "screen"];

export type CallState = "off" | "connecting" | "connected" | "reconnecting";

export interface CallDeps {
  /** A fresh call token from the collector. */
  token: () => Promise<CallTokenResponse>;
  /**
   * The live track the recording path holds for a source. The call only ever publishes a *clone* of it, so that muting,
   * switching off or leaving the call cannot touch what the recorders write (a clone has its own `enabled` flag and its own lifetime).
   * `null` means "send nothing for this source" (a screen share that ended, a camera that is switched off); `undefined` means the
   * recording path has no track right now (between takes) and the call keeps sending what it sends.
   */
  track: (source: CallSource) => MediaStreamTrack | null | undefined;
  /** True when the participant has not confirmed headphones: the call is joined muted, to keep their speakers out of the call. */
  joinMuted: () => boolean;
}

interface Published {
  /** Id of the recorded track the clone was made from. */
  sourceId: string;
  clone: MediaStreamTrack;
  publication: LiveKit.LocalTrackPublication;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "call_disabled") return t("call.err.disabled");
    if (error.code === "session_ended") return t("call.err.ended");
    return t("call.err.generic", { message: error.code });
  }
  return t("call.err.generic", { message: error instanceof Error ? error.message : String(error) });
}

/**
 * The conversation of one participant: a LiveKit room per session, joined with a token from the collector. It is deliberately
 * separate from the recording: nothing here starts, stops, delays or changes a recorder, and every failure ends in an error
 * message on the call card and nowhere else. The LiveKit client is loaded only when someone joins.
 */
export class Call {
  state: CallState = "off";
  members: CallMember[] = [];
  micMuted = false;
  cameraMuted = false;
  error: string | null = null;
  /** The browser blocked sound until the user presses something: the card then offers "Turn on sound". */
  audioBlocked = false;

  private lk: typeof LiveKit | null = null;
  private room: LiveKit.Room | null = null;
  private published = new Map<CallSource, Published>();
  /** Source tracks whose publishing failed: not retried until the recording path hands over another track. */
  private failed = new Map<CallSource, string>();
  private audioHost: HTMLElement | null = null;
  private queue: Promise<void> = Promise.resolve();
  private leaving = false;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: CallDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get connected(): boolean {
    return this.state === "connected" || this.state === "reconnecting";
  }

  /** True while a camera picture is being sent (or is held back by "camera off"). */
  get hasCamera(): boolean {
    return this.published.has("camera");
  }

  async join(): Promise<void> {
    if (this.state !== "off") return;
    this.error = null;
    this.leaving = false;
    this.state = "connecting";
    this.emit();
    try {
      const [lk, credentials] = await Promise.all([import("livekit-client"), this.deps.token()]);
      const room = new lk.Room({ adaptiveStream: true, dynacast: true });
      this.lk = lk;
      this.room = room;
      this.micMuted = this.deps.joinMuted();
      this.cameraMuted = false;
      this.failed.clear();
      this.bind(room, lk);
      await room.connect(credentials.url, credentials.token);
      this.state = "connected";
      this.audioBlocked = !room.canPlaybackAudio;
      await room.startAudio().catch(() => undefined);
      this.refresh();
      await this.sync();
    } catch (error) {
      this.error = errorText(error);
      await this.teardown();
    }
  }

  async leave(): Promise<void> {
    this.leaving = true;
    await this.teardown();
  }

  /** Called by the room whenever the recording path may have changed its tracks (device switch, take started, screen share on or off). */
  sync(): Promise<void> {
    if (!this.connected || this.room === null) return this.queue;
    this.queue = this.queue.then(() => this.reconcile()).catch(() => undefined);
    return this.queue;
  }

  async toggleMic(): Promise<void> {
    this.micMuted = !this.micMuted;
    await this.applyMute("microphone", this.micMuted);
    this.refresh();
  }

  async toggleCamera(): Promise<void> {
    this.cameraMuted = !this.cameraMuted;
    await this.applyMute("camera", this.cameraMuted);
    this.refresh();
  }

  async enableAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => undefined);
    this.audioBlocked = this.room ? !this.room.canPlaybackAudio : false;
    this.emit();
  }

  private async applyMute(source: CallSource, muted: boolean): Promise<void> {
    const publication = this.published.get(source)?.publication;
    if (!publication) return;
    try {
      await (muted ? publication.mute() : publication.unmute());
    } catch (error) {
      this.error = errorText(error);
    }
  }

  // ---- what we send ----------------------------------------------------------

  private livekitSource(source: CallSource): LiveKit.Track.Source {
    const { Track } = this.lk as typeof LiveKit;
    return source === "microphone" ? Track.Source.Microphone : source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
  }

  /** Makes the published clones match the tracks of the recording path: publish new ones, drop ended or replaced ones. */
  private async reconcile(): Promise<void> {
    const room = this.room;
    if (!room || !this.connected) return;
    let changed = false;
    for (const source of SOURCES) {
      const wanted = this.deps.track(source);
      if (wanted === undefined) continue;
      const have = this.published.get(source);
      if ((wanted?.id ?? null) === (have?.sourceId ?? null)) continue;
      if (wanted && this.failed.get(source) === wanted.id) continue;
      changed = true;
      if (have) {
        this.published.delete(source);
        await room.localParticipant.unpublishTrack(have.clone, true).catch(() => undefined);
        have.clone.stop();
      }
      if (!wanted) continue;
      const clone = wanted.clone();
      if (source === "screen") clone.contentHint = "detail";
      try {
        const publication = await room.localParticipant.publishTrack(clone, { source: this.livekitSource(source), name: source });
        this.published.set(source, { sourceId: wanted.id, clone, publication });
        this.failed.delete(source);
        const muted = source === "microphone" ? this.micMuted : source === "camera" ? this.cameraMuted : false;
        if (muted) await publication.mute();
      } catch (error) {
        clone.stop();
        this.failed.set(source, wanted.id);
        this.error = errorText(error);
      }
    }
    if (changed) this.refresh();
  }

  // ---- what we receive -------------------------------------------------------

  private bind(room: LiveKit.Room, lk: typeof LiveKit): void {
    const { RoomEvent, Track } = lk;
    const refresh = (): void => this.refresh();
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) this.attachAudio(track);
        this.refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) for (const element of track.detach()) element.remove();
        this.refresh();
      })
      .on(RoomEvent.Reconnecting, () => {
        this.state = "reconnecting";
        this.emit();
      })
      .on(RoomEvent.Reconnected, () => {
        this.state = "connected";
        this.emit();
        void this.sync();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.audioBlocked = !room.canPlaybackAudio;
        this.emit();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.leaving || this.room !== room) return;
        this.error = reason === lk.DisconnectReason.DUPLICATE_IDENTITY ? t("call.err.duplicate") : t("call.err.dropped");
        void this.teardown();
      });
  }

  private attachAudio(track: LiveKit.RemoteTrack): void {
    if (!this.audioHost) {
      this.audioHost = document.createElement("div");
      this.audioHost.hidden = true;
      document.body.append(this.audioHost);
    }
    this.audioHost.append(track.attach());
  }

  private refresh(): void {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const { Track } = lk;
    const everyone: LiveKit.Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    this.members = everyone.map((participant) => {
      const microphone = participant.getTrackPublication(Track.Source.Microphone);
      const camera = participant.getTrackPublication(Track.Source.Camera);
      const screen = participant.getTrackPublication(Track.Source.ScreenShare);
      return {
        identity: participant.identity,
        name: participant.name || participant.identity,
        local: participant.isLocal,
        micOn: microphone !== undefined && !microphone.isMuted,
        speaking: participant.isSpeaking,
        camera: camera && !camera.isMuted && camera.track ? camera.track : null,
        screen: screen?.track ?? null,
      };
    });
    this.emit();
  }

  private async teardown(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.state = "off";
    this.members = [];
    for (const { clone } of this.published.values()) clone.stop();
    this.published.clear();
    this.failed.clear();
    this.audioBlocked = false;
    this.audioHost?.remove();
    this.audioHost = null;
    this.emit();
    await room?.disconnect().catch(() => undefined);
  }
}
