import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { estimateDrift } from "../../shared/drift.js";
import { ID_PATTERN, type Manifest, type ManifestTrack } from "../../shared/protocol.js";
import { DEFAULT_FPS, EMPTY_TRANSCRIPT, PROJECT_SCHEMA_VERSION, type ProjectFile, type ProjectHighlight, type ProjectSource } from "../../shared/project.js";
import type { Config } from "../config.js";
import { HttpError } from "../errors.js";
import type { Storage } from "../storage/index.js";

const run = promisify(execFile);

interface Probe {
  durationSec: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export async function probeMedia(ffprobePath: string, file: string): Promise<Probe> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const durationSec = Number(parsed.format?.duration);
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    hasVideo: video !== undefined,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

/** Atomic JSON write (temp file, then rename). */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}

/** Highlights flagged by participants, placed on the project timeline. The same press is stored on each of the participant's tracks, so it is listed once. */
function highlightsOf(manifest: Manifest, origin: number): ProjectHighlight[] {
  const seen = new Set<string>();
  const list: ProjectHighlight[] = [];
  for (const participant of manifest.participants) {
    for (const track of participant.tracks) {
      for (const marker of track.markers) {
        const key = `${participant.participantId}:${marker.id}`;
        if (marker.kind !== "highlight" || seen.has(key)) continue;
        seen.add(key);
        list.push({ id: key, atMs: Math.max(0, Math.round(marker.atServerMsEstimated - origin)), participantId: participant.participantId, participantName: participant.displayName });
      }
    }
  }
  return list.sort((a, b) => a.atMs - b.atMs);
}

/** Projects live in the post directory: `<dir>/<sessionId>/project.json` plus conformed media, proxies and exports. */
export class ProjectStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
  ) {}

  dir(sid: string): string {
    if (!ID_PATTERN.test(sid)) throw new HttpError(400, "invalid_field", { field: "sessionId" });
    return path.join(this.config.post.dir, sid);
  }

  async get(sid: string): Promise<ProjectFile | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(sid), "project.json"), "utf8")) as ProjectFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async require(sid: string): Promise<ProjectFile> {
    const project = await this.get(sid);
    if (!project) throw new HttpError(404, "project_not_found");
    return project;
  }

  /** Serialises read-modify-write cycles of one project. */
  async update(sid: string, change: (project: ProjectFile) => void | Promise<void>): Promise<ProjectFile> {
    const previous = this.locks.get(sid) ?? Promise.resolve();
    const next = previous.then(async () => {
      const project = await this.require(sid);
      await change(project);
      project.updatedAtMs = Date.now();
      await writeJson(path.join(this.dir(sid), "project.json"), project);
      return project;
    });
    this.locks.set(sid, next.catch(() => undefined));
    return next;
  }

  /** Builds the project of an ended session from its manifest. Returns the existing project when there is one. */
  async create(sid: string): Promise<ProjectFile> {
    const existing = await this.get(sid);
    if (existing) return existing;
    const raw = await this.storage.get(`session/${sid}/manifest.json`);
    if (!raw) throw new HttpError(409, "session_not_ended");
    const manifest = JSON.parse(raw.toString("utf8")) as Manifest;
    if (manifest.endedAtServerMs === null) throw new HttpError(409, "session_not_ended");
    const tracks = manifest.participants.flatMap((participant) => participant.tracks.map((track) => ({ participant, track })));
    if (tracks.some(({ track }) => track.status === "receiving" || track.status === "pending")) throw new HttpError(409, "tracks_pending");
    const usable = tracks.filter(({ track }) => track.status === "ok" && track.file !== null);
    if (usable.length === 0) throw new HttpError(409, "no_tracks");
    return this.fromManifest(manifest, usable);
  }

  private async fromManifest(manifest: Manifest, usable: { participant: Manifest["participants"][number]; track: ManifestTrack }[]): Promise<ProjectFile> {
    const sid = manifest.sessionId;
    const drafts: { source: ProjectSource; startServerMs: number }[] = [];
    for (const { participant, track } of usable) {
      const sourceKey = `session/${sid}/${participant.participantId}/${track.file}`;
      const local = await this.localSource(sid, sourceKey, track.trackId);
      const probe = await probeMedia(this.config.ffprobePath, local);
      if (probe.durationSec <= 0) continue;
      const drift = estimateDrift({
        startClientMs: track.startClientMs,
        endClientMs: track.endClientMs,
        mediaDurationSec: probe.durationSec,
        samples: track.clock.samples,
      });
      drafts.push({
        startServerMs: track.startServerMsEstimated,
        source: {
          id: track.trackId,
          participantId: participant.participantId,
          participantName: participant.displayName,
          kind: track.kind,
          segment: track.segment,
          sourceKey,
          offsetMs: 0,
          mediaDurationSec: probe.durationSec,
          rate: drift.rate,
          driftPpm: drift.ppm,
          driftApplied: drift.applied,
          driftNote: drift.note,
          timelineDurationMs: (probe.durationSec / drift.rate) * 1000,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
          width: probe.width,
          height: probe.height,
          audio: null,
          video: null,
        },
      });
    }
    if (drafts.length === 0) throw new HttpError(409, "no_tracks");
    const origin = Math.min(...drafts.map((draft) => draft.startServerMs));
    for (const draft of drafts) draft.source.offsetMs = Math.round((draft.startServerMs - origin) * 1000) / 1000;
    const now = Date.now();
    const project: ProjectFile = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: sid,
      createdAtMs: now,
      updatedAtMs: now,
      fps: DEFAULT_FPS,
      originServerMs: origin,
      durationMs: Math.max(...drafts.map((draft) => draft.source.offsetMs + draft.source.timelineDurationMs)),
      participants: manifest.participants.map((participant) => ({ id: participant.participantId, name: participant.displayName, host: participant.host })),
      sources: drafts.map((draft) => draft.source),
      conform: { status: "none", atMs: null, error: null, wallMs: null },
      mixProxy: null,
      highlights: highlightsOf(manifest, origin),
      transcript: { ...EMPTY_TRANSCRIPT },
    };
    await writeJson(path.join(this.dir(sid), "project.json"), project);
    return project;
  }

  /** Absolute path of an original track. A remote storage driver downloads it into the project first. */
  async localSource(sid: string, sourceKey: string, id: string): Promise<string> {
    if (this.storage.localPath) return this.storage.localPath(sourceKey);
    const target = path.join(this.dir(sid), "src", `${id}.webm`);
    if (await stat(target).then(() => true, () => false)) return target;
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.part`;
    await pipeline(await this.storage.readStream(sourceKey), createWriteStream(temp));
    await rename(temp, target);
    return target;
  }

  /** Deletes proxies, conformed audio and peaks (everything the conform job can rebuild). Exports and the project file stay. */
  async dropIntermediates(sid: string, only: "proxies" | "all"): Promise<void> {
    const base = this.dir(sid);
    for (const name of only === "proxies" ? ["proxies"] : ["proxies", "conformed", "peaks", "levels", "src"]) {
      await rm(path.join(base, name), { recursive: true, force: true });
    }
    await this.update(sid, (project) => {
      for (const source of project.sources) {
        if (source.video) source.video = null;
        if (only === "all" && source.audio) source.audio = null;
      }
      project.mixProxy = null;
      project.conform = { status: "none", atMs: null, error: null, wallMs: null };
    });
  }
}
