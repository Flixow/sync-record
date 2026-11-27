import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buildCues, toSrt, toTxt, toVtt, validateSrt, validateVtt, type TranscriptFile } from "../../shared/transcript.js";
import type { PostProduction } from "./index.js";
import { freeBytes } from "./jobs.js";
import { TRANSCRIPT_FILE } from "./transcribe.js";
import { layoutSources, resolveScenes } from "./layout-plan.js";
import { parseScenes, readScenes, saveScenes } from "./scenes-store.js";
import { suggestScenePlan } from "./scene-suggest.js";
import { llmTransport } from "./llm.js";
import { captionStyleById } from "../../shared/captions.js";
import { ensureRnnoiseModel } from "./audio-clean.js";
import { handlePublishRoutes } from "./api-publish.js";
import { listExports, removeExport } from "./exports.js";
import { presetById } from "../../shared/presets.js";
import { parseRanges, readEdl, saveEdl } from "./edl-store.js";
import { detectSilences, DEFAULT_SILENCE } from "../../shared/silence.js";
import { HttpError } from "../errors.js";
import * as v from "../validate.js";

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".bin": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export interface Http {
  json(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
}

/** Job kinds a client may queue, with the validation of their parameters. */
const JOB_KINDS = new Set(["conform", "transcribe", "cut-preview", "render", "thumbnail"]);

/**
 * Serves a file from a project directory with byte ranges (a browser needs them to seek a video).
 * `relative` comes from the URL, so it is resolved and checked against the project root.
 */
export async function serveProjectFile(req: IncomingMessage, res: ServerResponse, root: string, relative: string, download?: string): Promise<void> {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(404, "not_found");
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) throw new HttpError(404, "not_found");
  const type = MEDIA_TYPES[path.extname(target)] ?? "application/octet-stream";
  const headers: Record<string, string | number> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (download) headers["content-disposition"] = `attachment; filename="${download.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = info.size - 1;
  if (range) {
    if (range[1] === "" && range[2] !== "") {
      start = Math.max(0, info.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== "") end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "content-length": info.size });
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(target, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Routes below `/api/sessions/<sid>/project`. The caller has already checked that the token belongs to the host. */
export async function postRoutes(post: PostProduction, http: Http, req: IncomingMessage, res: ServerResponse, sid: string, rest: string[]): Promise<boolean> {
  const method = req.method ?? "GET";
  await post.ready;

  if (rest.length === 0 && method === "POST") {
    http.json(res, 201, await post.store.create(sid));
    return true;
  }
  if (rest.length === 0 && method === "GET") {
    const project = await post.store.require(sid);
    const free = await freeBytes(post.config.post.dir).catch(() => null);
    http.json(res, 200, {
      project,
      jobs: post.jobs.list(sid).slice(0, 30),
      disk: { freeBytes: free, minFreeBytes: post.config.post.minFreeBytes },
      settings: { loudnessLufs: post.config.post.loudnessLufs, truePeakDb: post.config.post.truePeakDb, retention: post.config.post.retention, llm: post.config.post.llm !== null, llmRemote: post.config.post.llm !== null && llmTransport(post.config.post.llm.url ?? "")?.local !== true },
    });
    return true;
  }
  if (rest[0] === "jobs") {
    if (rest.length === 1 && method === "GET") {
      http.json(res, 200, { jobs: post.jobs.list(sid) });
      return true;
    }
    if (rest.length === 1 && method === "POST") {
      await post.store.require(sid);
      const body = await http.readJson(req);
      const kind = v.str(body.kind, "kind", 40);
      if (!JOB_KINDS.has(kind)) throw new HttpError(400, "unknown_job_kind", { kind });
      const params = body.params === undefined ? {} : v.asObject(body.params);
      if (kind === "thumbnail") {
        if (typeof params.atMs !== "number" || !(params.atMs >= 0)) throw new HttpError(400, "invalid_field", { field: "atMs" });
        if (params.kind !== undefined && params.kind !== "video" && params.kind !== "short") throw new HttpError(400, "invalid_field", { field: "kind" });
        if (params.text !== undefined && typeof params.text !== "string") throw new HttpError(400, "invalid_field", { field: "text" });
      }
      if (kind === "render") {
        if (!presetById(String(params.preset))) throw new HttpError(400, "invalid_field", { field: "preset" });
        if (params.captions !== undefined && params.captions !== false) {
          const style = typeof params.captions === "object" && params.captions !== null ? (params.captions as Record<string, unknown>).style : "clean";
          if (typeof style !== "string" || !captionStyleById(style)) throw new HttpError(400, "invalid_field", { field: "captions" });
        }
        if (params.clean !== undefined && params.clean !== null) {
          const c = params.clean as Record<string, unknown>;
          if (typeof c !== "object" || (c.bleedGateDb !== undefined && !(typeof c.bleedGateDb === "number" && c.bleedGateDb >= -90 && c.bleedGateDb < 0))) throw new HttpError(400, "invalid_field", { field: "clean" });
          if (c.denoise === true && !(await stat(path.join(post.config.post.modelsDir, "rnnoise", "bd.rnnn")).then(() => true, () => false))) throw new HttpError(409, "denoise_model_missing");
        }
        if (params.range !== undefined) {
          const r = params.range as Record<string, unknown> | null;
          if (!r || typeof r.s !== "number" || typeof r.e !== "number" || !(r.s >= 0 && r.e > r.s)) throw new HttpError(400, "invalid_field", { field: "range" });
        }
        if (params.lufs !== undefined && !(typeof params.lufs === "number" && params.lufs >= -40 && params.lufs <= -5)) throw new HttpError(400, "invalid_field", { field: "lufs" });
        if (params.truePeakDb !== undefined && !(typeof params.truePeakDb === "number" && params.truePeakDb >= -9 && params.truePeakDb <= 0)) throw new HttpError(400, "invalid_field", { field: "truePeakDb" });
      }
      http.json(res, 202, await post.jobs.enqueue(sid, kind, params));
      return true;
    }
    const id = v.id(rest[1], "jobId");
    if (rest.length === 2 && method === "GET") {
      const job = post.jobs.get(sid, id);
      if (!job) throw new HttpError(404, "job_not_found");
      http.json(res, 200, job);
      return true;
    }
    if (rest.length === 3 && rest[2] === "cancel" && method === "POST") {
      http.json(res, 200, await post.jobs.cancel(sid, id));
      return true;
    }
  }
  if (rest[0] === "transcript" && rest.length <= 2 && (method === "GET" || method === "HEAD")) {
    await post.store.require(sid);
    const file = path.join(post.store.dir(sid), TRANSCRIPT_FILE);
    if (rest.length === 1) {
      await serveProjectFile(req, res, post.store.dir(sid), TRANSCRIPT_FILE);
      return true;
    }
    const format = rest[1];
    if (format !== "srt" && format !== "vtt" && format !== "txt") throw new HttpError(404, "not_found");
    const transcript = await readFile(file, "utf8").then((text) => JSON.parse(text) as TranscriptFile, () => null);
    if (!transcript) throw new HttpError(404, "transcript_not_found");
    const url = new URL(req.url ?? "/", "http://localhost");
    const speakers = url.searchParams.get("speakers") !== "0";
    const names = new Map(transcript.speakers.map((speaker) => [speaker.pid, speaker.name]));
    const nameOf = (pid: string): string => names.get(pid) ?? pid;
    let body: string;
    if (format === "txt") {
      body = toTxt(transcript.words, nameOf);
    } else {
      const cues = buildCues(transcript.words, nameOf);
      body = format === "srt" ? toSrt(cues, speakers) : toVtt(cues, speakers);
      const problems = format === "srt" ? validateSrt(body) : validateVtt(body);
      if (problems.length > 0) throw new HttpError(500, "invalid_export", { problems: problems.slice(0, 3) });
    }
    res.writeHead(200, {
      "content-type": MEDIA_TYPES[`.${format}`] ?? "text/plain",
      "content-disposition": `attachment; filename="transcript.${format}"`,
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  if (rest[0] === "edl" && rest.length === 1) {
    const project = await post.store.require(sid);
    if (method === "GET") {
      http.json(res, 200, await readEdl(post.store.dir(sid)));
      return true;
    }
    if (method === "PUT") {
      const body = await http.readJson(req);
      const baseRev = v.nonNegativeInt(body.baseRev, "baseRev");
      http.json(res, 200, await saveEdl(post.store.dir(sid), baseRev, parseRanges(body.removed, project.durationMs)));
      return true;
    }
  }
  if (await handlePublishRoutes(post, sid, rest, method, req, res, http)) return true;
  if (rest[0] === "scenes" && rest[1] === "suggest" && rest.length === 2 && method === "POST") {
    const body = await http.readJson(req);
    http.json(res, 200, await suggestScenePlan(post, sid, body.llm !== false));
    return true;
  }
  if (rest[0] === "scenes" && rest.length === 1) {
    const project = await post.store.require(sid);
    const dir = post.store.dir(sid);
    if (method === "PUT") {
      const body = await http.readJson(req);
      await saveScenes(dir, v.nonNegativeInt(body.baseRev, "baseRev"), parseScenes(body));
    }
    if (method === "GET" || method === "PUT") {
      const file = await readScenes(dir);
      const scenes = await resolveScenes(project, dir, file.plan).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, "not_prepared");
        throw error;
      });
      http.json(res, 200, { ...file, scenes, sources: layoutSources(project) });
      return true;
    }
  }
  if (rest[0] === "silences" && rest.length === 1 && method === "GET") {
    const project = await post.store.require(sid);
    const url = new URL(req.url ?? "/", "http://localhost");
    const number = (name: string, fallback: number, min: number, max: number): number => {
      const raw = url.searchParams.get(name);
      const value = raw === null ? fallback : Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) throw new HttpError(400, "invalid_field", { field: name });
      return value;
    };
    const options = {
      ...DEFAULT_SILENCE,
      minSilenceMs: number("minSilenceMs", DEFAULT_SILENCE.minSilenceMs, 200, 60_000),
      keepMs: number("keepMs", DEFAULT_SILENCE.keepMs, 0, 5000),
      edgeMs: number("edgeMs", DEFAULT_SILENCE.edgeMs, 0, 1000),
    };
    const levels: Int8Array[] = [];
    for (const source of project.sources) {
      if (!source.audio) continue;
      const buffer = await readFile(path.join(post.store.dir(sid), source.audio.levels));
      levels.push(new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    }
    if (levels.length === 0) throw new HttpError(409, "not_prepared");
    http.json(res, 200, { options, silences: detectSilences(levels, project.durationMs, options) });
    return true;
  }
  if (rest[0] === "audio" && rest[1] === "denoise-model" && rest.length === 2 && method === "POST") {
    await post.store.require(sid);
    // the only network call of post-production besides the speech model: the host asks for it explicitly
    await ensureRnnoiseModel(post.config.post.modelsDir);
    http.json(res, 200, { ok: true });
    return true;
  }
  if (rest[0] === "exports") {
    await post.store.require(sid);
    if (rest.length === 1 && method === "GET") {
      http.json(res, 200, { exports: await listExports(post.store.dir(sid)) });
      return true;
    }
    if (rest.length === 2 && method === "DELETE") {
      if (!(await removeExport(post.store.dir(sid), v.id(rest[1], "exportId")))) throw new HttpError(404, "export_not_found");
      http.json(res, 200, { exports: await listExports(post.store.dir(sid)) });
      return true;
    }
  }
  if (rest[0] === "cache" && rest.length === 1 && method === "DELETE") {
    const body = await http.readJson(req);
    const scope = body.scope === "all" ? "all" : "proxies";
    const running = post.jobs.list(sid).some((job) => job.status === "running" || job.status === "queued");
    if (running) throw new HttpError(409, "jobs_active");
    await post.store.dropIntermediates(sid, scope);
    http.json(res, 200, await post.store.require(sid));
    return true;
  }
  if (rest[0] === "media" && rest.length > 1 && (method === "GET" || method === "HEAD")) {
    await post.store.require(sid);
    let relative: string;
    try {
      relative = decodeURIComponent(rest.slice(1).join("/"));
    } catch {
      throw new HttpError(400, "bad_path");
    }
    await serveProjectFile(req, res, post.store.dir(sid), relative);
    return true;
  }
  return false;
}
