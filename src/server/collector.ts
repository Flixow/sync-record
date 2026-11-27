import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  CLAIM_MINUTES,
  MAX_PARTICIPANTS,
  type ClaimLinkResponse,
  type ClaimResponse,
  type ClockResponse,
  type DeclareTrackRequest,
  type FinalizeRequest,
  type Manifest,
  type MarkerEvent,
  type PresenceState,
  type RosterEntry,
  type ServerEvent,
  type SessionView,
  type StatusRequest,
  type TrackKind,
  type TrackStateResponse,
} from "../shared/protocol.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { buildManifest } from "./manifest.js";
import type { ParticipantRecord, SessionRecord, TrackRecord } from "./model.js";
import { remuxTrack } from "./remux.js";
import type { Storage } from "./storage/index.js";
import { issueToken, type TokenClaims } from "./tokens.js";
import { freeBytes } from "./post/jobs.js";

const MARKER_LEAD_MS = 3000;
export const CLAIM_TTL_MS = CLAIM_MINUTES * 60_000;
const PART_NAME = /^\d{12}$/;
const MAX_TRACKS_PER_PARTICIPANT = 300;
const MAX_STREAMS_PER_PARTICIPANT = 3;
const TIMING_WINDOW_MS = 24 * 3_600_000;
const INGEST_MIN_FREE_BYTES = 256 * 1024 * 1024;

interface Presence {
  state: PresenceState;
  kinds: TrackKind[];
}

interface TrackRuntime {
  received: number;
  /** Serialises uploads of one track so offsets are checked against a stable byte count. */
  queue: Promise<unknown>;
}

interface SessionRuntime {
  record: SessionRecord;
  presence: Map<string, Presence>;
  streams: Map<string, Set<ServerResponse>>;
  tracks: Map<string, TrackRuntime>;
  persistChain: Promise<void>;
}

const nowMs = (): number => performance.timeOrigin + performance.now();

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return slug || "guest";
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const partKey = (sid: string, pid: string, tid: string, offset: number): string =>
  `session/${sid}/raw/${pid}/${tid}/${String(offset).padStart(12, "0")}`;
const partPrefix = (sid: string, pid: string, tid: string): string => `session/${sid}/raw/${pid}/${tid}/`;

export class Collector {
  private readonly sessions = new Map<string, SessionRuntime>();
  private remuxChain: Promise<void> = Promise.resolve();
  private readonly remuxing = new Set<string>();
  private readonly heartbeat: NodeJS.Timeout;
  /** Called when a track could not be remuxed (the telemetry hook; carries nothing). */
  onRemuxFailed: (() => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
  ) {
    this.heartbeat = setInterval(() => {
      for (const runtime of this.sessions.values()) {
        for (const set of runtime.streams.values()) for (const res of set) res.write(": ping\n\n");
      }
    }, 20_000);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const runtime of this.sessions.values()) {
      for (const set of runtime.streams.values()) for (const res of set) res.end();
    }
  }

  /** Resolves once queued remux work has finished (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    await this.remuxChain;
  }

  // ---- sessions ----------------------------------------------------------

  async createSession(name: string, createKey: string | undefined, userAgent: string | null) {
    if (this.config.createKey !== null && !(createKey !== undefined && sameSecret(createKey, this.config.createKey))) {
      throw new HttpError(403, "create_key_invalid");
    }
    const id = randomBytes(10).toString("hex");
    const record: SessionRecord = { id, createdAtMs: nowMs(), endedAtMs: null, participants: [], tracks: [] };
    const runtime = this.adopt(record);
    const host = this.addParticipant(runtime, name, true, userAgent);
    await this.persist(runtime);
    return {
      sessionId: id,
      participantId: host.id,
      participantToken: this.participantToken(id, host),
      inviteToken: this.inviteToken(id),
    };
  }

  async join(sid: string, name: string, userAgent: string | null) {
    const runtime = await this.load(sid);
    if (runtime.record.endedAtMs !== null) throw new HttpError(409, "session_ended");
    if (runtime.record.participants.length >= MAX_PARTICIPANTS) throw new HttpError(409, "session_full");
    const participant = this.addParticipant(runtime, name, false, userAgent);
    await this.persist(runtime);
    this.broadcastRoster(runtime);
    return { sessionId: sid, participantId: participant.id, participantToken: this.participantToken(sid, participant) };
  }

  async view(sid: string, pid: string): Promise<SessionView> {
    const runtime = await this.load(sid);
    const caller = this.participant(runtime, pid);
    return {
      renewedToken: this.participantToken(sid, caller),
      ...(caller.host ? { renewedInviteToken: this.inviteToken(sid) } : {}),
      sessionId: sid,
      ended: runtime.record.endedAtMs !== null,
      maxParticipants: MAX_PARTICIPANTS,
      roster: this.roster(runtime),
      callEnabled: this.config.call !== null,
    };
  }

  /** Who the caller is in the call: only a participant of a session that has not ended may get a call token. */
  async callParticipant(sid: string, pid: string): Promise<{ name: string; host: boolean }> {
    const runtime = await this.load(sid);
    const caller = this.participant(runtime, pid);
    if (runtime.record.endedAtMs !== null) throw new HttpError(409, "session_ended");
    return { name: caller.name, host: caller.host };
  }

  async claimToken(sid: string, pid: string): Promise<ClaimLinkResponse> {
    const runtime = await this.load(sid);
    if (!this.participant(runtime, pid).host) throw new HttpError(403, "host_only");
    const expiresAtMs = Date.now() + CLAIM_TTL_MS;
    const claimToken = issueToken(this.config.tokenSecret, { sid, role: "claim", pid, jti: randomUUID(), exp: expiresAtMs });
    return { claimToken, expiresAtMs };
  }

  async redeemClaim(sid: string, claim: TokenClaims): Promise<ClaimResponse> {
    const runtime = await this.load(sid);
    const host = claim.pid ? runtime.record.participants.find((participant) => participant.id === claim.pid) : undefined;
    if (!host?.host || !claim.jti) throw new HttpError(403, "forbidden");
    const now = Date.now();
    const used = (runtime.record.usedClaims ?? []).filter((entry) => entry.exp >= now);
    if (used.some((entry) => entry.jti === claim.jti)) throw new HttpError(403, "claim_used");
    used.push({ jti: claim.jti, exp: claim.exp });
    runtime.record.usedClaims = used;
    await this.persist(runtime);
    return { sessionId: sid, participantId: host.id, participantToken: this.participantToken(sid, host), name: host.name };
  }

  clock(): ClockResponse {
    const serverRecvMs = nowMs();
    return { serverRecvMs, serverSendMs: nowMs() };
  }

  /** Returns the state the participant reported before this call (undefined for the first report). */
  async setStatus(sid: string, pid: string, request: StatusRequest): Promise<PresenceState | undefined> {
    const runtime = await this.load(sid);
    const participant = this.participant(runtime, pid);
    const before = runtime.presence.get(pid)?.state;
    runtime.presence.set(pid, { state: request.state, kinds: request.kinds });
    if (request.consentVersion !== undefined && participant.consent === null) {
      participant.consent = { version: request.consentVersion, atMs: nowMs() };
      await this.persist(runtime);
    }
    this.broadcastRoster(runtime);
    return before;
  }

  async createMarker(sid: string): Promise<MarkerEvent> {
    const runtime = await this.load(sid);
    const marker: MarkerEvent = { id: randomUUID(), atServerMs: nowMs() + MARKER_LEAD_MS };
    this.broadcast(runtime, { type: "marker", marker });
    return marker;
  }

  /**
   * Ends the session: no new participants or tracks, every connected client is told
   * to stop, and each finalized track is remuxed. `force` finalizes tracks whose owner
   * never reported the end, using the bytes received so far.
   */
  async endSession(sid: string, force: boolean): Promise<Manifest> {
    const runtime = await this.load(sid);
    const { record } = runtime;
    const firstEnd = record.endedAtMs === null;
    if (firstEnd) record.endedAtMs = nowMs();
    if (force) {
      for (const track of record.tracks) {
        if (track.finalized) continue;
        const received = (await this.trackRuntime(sid, track)).received;
        this.markFinalized(track, {
          totalBytes: received,
          chunkCount: 0,
          endClientMs: null,
          endReason: "forced",
          clockSamples: [],
          markers: [],
        });
      }
    }
    for (const track of record.tracks) {
      if (track.output?.status === "failed") track.output = null; // a repeated end retries failed remuxes
    }
    await this.persist(runtime);
    if (firstEnd) this.broadcast(runtime, { type: "ended" });
    this.scheduleRemux(runtime);
    const manifest = await this.manifest(sid);
    await this.storage.put(`session/${sid}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));
    return manifest;
  }

  async manifest(sid: string): Promise<Manifest> {
    const runtime = await this.load(sid);
    const received = new Map<string, number>();
    for (const track of runtime.record.tracks) received.set(track.id, (await this.trackRuntime(sid, track)).received);
    return buildManifest(runtime.record, this.config.version, (tid) => received.get(tid) ?? 0);
  }

  // ---- tracks ------------------------------------------------------------

  async declareTrack(sid: string, pid: string, request: DeclareTrackRequest): Promise<TrackStateResponse> {
    const runtime = await this.load(sid);
    this.participant(runtime, pid);
    const existing = runtime.record.tracks.find((track) => track.id === request.trackId);
    if (existing) {
      if (existing.pid !== pid) throw new HttpError(403, "forbidden");
      return this.trackState(sid, pid, existing.id);
    }
    if (runtime.record.endedAtMs !== null) throw new HttpError(409, "session_ended");
    if (runtime.record.tracks.filter((track) => track.pid === pid).length >= MAX_TRACKS_PER_PARTICIPANT) throw new HttpError(409, "too_many_tracks");
    this.assertPlausibleTiming(runtime.record, request);
    await this.assertDiskRoom();
    const segment = runtime.record.tracks.filter((track) => track.pid === pid && track.kind === request.kind).length + 1;
    runtime.record.tracks.push({
      id: request.trackId,
      pid,
      kind: request.kind,
      segment,
      mime: request.mime,
      settings: request.settings,
      startCallClientMs: request.startCallClientMs,
      startClientMs: request.startClientMs,
      offsetMs: request.offsetMs,
      rttMs: request.rttMs,
      clockSamples: request.clockSamples,
      declaredAtMs: nowMs(),
      finalized: null,
      output: null,
    });
    await this.persist(runtime);
    return this.trackState(sid, pid, request.trackId);
  }

  async trackState(sid: string, pid: string, tid: string): Promise<TrackStateResponse> {
    const runtime = await this.load(sid);
    const track = this.ownedTrack(runtime, pid, tid);
    return { trackId: tid, received: (await this.trackRuntime(sid, track)).received, finalized: track.finalized !== null };
  }

  /**
   * Appends bytes at `offset`. Chunks of one MediaRecorder stream are not standalone
   * (only the first has the WebM header), so a byte is only ever accepted at the
   * current end of the track: a gap is refused with the offset the client must resume
   * from, and an overlap with data already stored is trimmed, which makes retries safe.
   */
  async receive(sid: string, pid: string, tid: string, offset: number, body: Buffer, sha256: string | undefined) {
    const runtime = await this.load(sid);
    const track = this.ownedTrack(runtime, pid, tid);
    if (sha256 === undefined || createHash("sha256").update(body).digest("hex") !== sha256.toLowerCase()) {
      throw new HttpError(422, "digest_mismatch");
    }
    const state = await this.trackRuntime(sid, track);
    const job = state.queue.then(async () => {
      if (offset > state.received) throw new HttpError(409, "offset_gap", { received: state.received });
      const end = offset + body.length;
      if (end <= state.received) return { received: state.received };
      if (track.finalized) throw new HttpError(409, "track_finalized", { received: state.received });
      const fresh = body.subarray(state.received - offset);
      await this.assertDiskRoom();
      await this.storage.put(partKey(sid, pid, tid, state.received), fresh);
      state.received += fresh.length;
      return { received: state.received };
    });
    state.queue = job.catch(() => undefined);
    return job;
  }

  async finalizeTrack(sid: string, pid: string, tid: string, request: FinalizeRequest): Promise<TrackStateResponse> {
    const runtime = await this.load(sid);
    const track = this.ownedTrack(runtime, pid, tid);
    const state = await this.trackRuntime(sid, track);
    await state.queue;
    if (!track.finalized) {
      if (state.received !== request.totalBytes) throw new HttpError(409, "incomplete", { received: state.received });
      this.markFinalized(track, request);
      await this.persist(runtime);
    }
    this.scheduleRemux(runtime);
    return { trackId: tid, received: state.received, finalized: true };
  }

  // ---- live events -------------------------------------------------------

  async subscribe(sid: string, pid: string, res: ServerResponse): Promise<void> {
    const runtime = await this.load(sid);
    this.participant(runtime, pid);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const set = runtime.streams.get(pid) ?? new Set<ServerResponse>();
    runtime.streams.set(pid, set);
    if (set.size >= MAX_STREAMS_PER_PARTICIPANT) {
      const oldest = set.values().next().value;
      if (oldest) oldest.end();
    }
    set.add(res);
    this.send(res, { type: "roster", roster: this.roster(runtime) });
    if (runtime.record.endedAtMs !== null) this.send(res, { type: "ended" });
    this.broadcastRoster(runtime);
    res.on("close", () => {
      set.delete(res);
      this.broadcastRoster(runtime);
    });
  }

  private assertPlausibleTiming(record: SessionRecord, request: DeclareTrackRequest): void {
    const invalid = (field: string): HttpError => new HttpError(400, "invalid_field", { field });
    const startServerMs = request.startClientMs + request.offsetMs;
    if (startServerMs < record.createdAtMs - TIMING_WINDOW_MS || startServerMs > nowMs() + TIMING_WINDOW_MS) throw invalid("startClientMs");
    if (request.clockSamples.some((sample) => Math.abs(sample.offsetMs - request.offsetMs) > TIMING_WINDOW_MS)) throw invalid("clockSamples");
  }

  private async assertDiskRoom(): Promise<void> {
    if (this.config.storageDriver !== "local") return;
    const free = await freeBytes(this.config.localDir).catch(() => null);
    const required = INGEST_MIN_FREE_BYTES;
    if (free !== null && free < required) throw new HttpError(507, "disk_low", { freeBytes: free, requiredBytes: required });
  }

  // ---- internals ---------------------------------------------------------

  private adopt(record: SessionRecord): SessionRuntime {
    const runtime: SessionRuntime = {
      record,
      presence: new Map(),
      streams: new Map(),
      tracks: new Map(),
      persistChain: Promise.resolve(),
    };
    this.sessions.set(record.id, runtime);
    return runtime;
  }

  private async load(sid: string): Promise<SessionRuntime> {
    const cached = this.sessions.get(sid);
    if (cached) return cached;
    const raw = await this.storage.get(`session/${sid}/session.json`);
    if (!raw) throw new HttpError(404, "session_not_found");
    const runtime = this.sessions.get(sid) ?? this.adopt(JSON.parse(raw.toString("utf8")) as SessionRecord);
    this.scheduleRemux(runtime); // finishes work an earlier collector process did not complete
    return runtime;
  }

  private persist(runtime: SessionRuntime): Promise<void> {
    const write = async (): Promise<void> => {
      await this.storage.put(`session/${runtime.record.id}/session.json`, Buffer.from(JSON.stringify(runtime.record)));
    };
    runtime.persistChain = runtime.persistChain.then(write, write);
    return runtime.persistChain;
  }

  private addParticipant(runtime: SessionRuntime, name: string, host: boolean, userAgent: string | null): ParticipantRecord {
    const participant: ParticipantRecord = {
      id: `p${runtime.record.participants.length + 1}-${slugify(name)}`,
      name,
      host,
      joinedAtMs: nowMs(),
      userAgent: userAgent ? userAgent.slice(0, 300) : null,
      consent: null,
    };
    runtime.record.participants.push(participant);
    return participant;
  }

  private participant(runtime: SessionRuntime, pid: string): ParticipantRecord {
    const found = runtime.record.participants.find((participant) => participant.id === pid);
    if (!found) throw new HttpError(403, "forbidden");
    return found;
  }

  private ownedTrack(runtime: SessionRuntime, pid: string, tid: string): TrackRecord {
    const track = runtime.record.tracks.find((candidate) => candidate.id === tid);
    if (!track) throw new HttpError(404, "track_not_found");
    if (track.pid !== pid) throw new HttpError(403, "forbidden");
    return track;
  }

  private inviteToken(sid: string): string {
    return issueToken(this.config.tokenSecret, { sid, role: "invite", exp: Date.now() + this.config.tokenTtlMs });
  }

  private participantToken(sid: string, participant: ParticipantRecord): string {
    return issueToken(this.config.tokenSecret, {
      sid,
      role: "participant",
      pid: participant.id,
      host: participant.host,
      exp: Date.now() + this.config.tokenTtlMs,
    });
  }

  private async trackRuntime(sid: string, track: TrackRecord): Promise<TrackRuntime> {
    const runtime = this.sessions.get(sid);
    if (!runtime) throw new HttpError(404, "session_not_found");
    const cached = runtime.tracks.get(track.id);
    if (cached) return cached;
    // Rebuild the byte count from the stored parts: each part is named by its offset,
    // so a restart of the collector loses nothing.
    const listed = await this.storage.list(partPrefix(sid, track.pid, track.id));
    let received = 0;
    for (const object of listed) {
      const name = object.key.slice(object.key.lastIndexOf("/") + 1);
      if (!PART_NAME.test(name) || Number(name) !== received) break;
      received += object.size;
    }
    const state = runtime.tracks.get(track.id) ?? { received, queue: Promise.resolve() };
    runtime.tracks.set(track.id, state);
    return state;
  }

  private markFinalized(track: TrackRecord, request: FinalizeRequest): void {
    track.finalized = {
      totalBytes: request.totalBytes,
      chunkCount: request.chunkCount,
      endClientMs: request.endClientMs,
      endReason: request.endReason,
      clockSamples: request.clockSamples,
      markers: request.markers,
      atMs: nowMs(),
    };
  }

  private roster(runtime: SessionRuntime): RosterEntry[] {
    return runtime.record.participants.map((participant) => {
      const presence = runtime.presence.get(participant.id);
      return {
        participantId: participant.id,
        name: participant.name,
        host: participant.host,
        online: (runtime.streams.get(participant.id)?.size ?? 0) > 0,
        state: presence?.state ?? "idle",
        kinds: presence?.kinds ?? [],
      };
    });
  }

  private broadcastRoster(runtime: SessionRuntime): void {
    this.broadcast(runtime, { type: "roster", roster: this.roster(runtime) });
  }

  private broadcast(runtime: SessionRuntime, event: ServerEvent): void {
    for (const set of runtime.streams.values()) for (const res of set) this.send(res, event);
  }

  private send(res: ServerResponse, event: ServerEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Remuxes every finalized track once the session has ended; runs one ffmpeg at a time. */
  private scheduleRemux(runtime: SessionRuntime): void {
    const { record } = runtime;
    if (record.endedAtMs === null) return;
    for (const track of record.tracks) {
      if (!track.finalized || track.output || this.remuxing.has(track.id)) continue;
      this.remuxing.add(track.id);
      this.remuxChain = this.remuxChain.then(() => this.remuxOne(runtime, track)).catch(() => undefined);
    }
  }

  private async remuxOne(runtime: SessionRuntime, track: TrackRecord): Promise<void> {
    const sid = runtime.record.id;
    const file = track.segment === 1 ? `${track.kind}.webm` : `${track.kind}-${track.segment}.webm`;
    try {
      const listed = await this.storage.list(partPrefix(sid, track.pid, track.id));
      const keys: string[] = [];
      let expected = 0;
      for (const object of listed) {
        const name = object.key.slice(object.key.lastIndexOf("/") + 1);
        if (!PART_NAME.test(name) || Number(name) !== expected) break;
        keys.push(object.key);
        expected += object.size;
      }
      const result = await remuxTrack(this.storage, keys, `session/${sid}/${track.pid}/${file}`, {
        ffmpegPath: this.config.ffmpegPath,
        ffprobePath: this.config.ffprobePath,
      });
      track.output = { status: "ok", file, bytes: result.bytes, durationSec: result.durationSec };
    } catch (error) {
      this.onRemuxFailed?.();
      track.output = { status: "failed", file, bytes: 0, durationSec: null, error: error instanceof Error ? error.message.slice(0, 300) : "remux failed" };
    } finally {
      this.remuxing.delete(track.id);
    }
    await this.persist(runtime);
    const manifest = await this.manifest(sid);
    await this.storage.put(`session/${sid}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));
  }
}

