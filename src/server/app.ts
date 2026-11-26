import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { MAX_PARTICIPANTS, type DeclareTrackRequest, type FinalizeRequest, type StatusRequest } from "../shared/protocol.js";
import { Collector } from "./collector.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { postRoutes } from "./post/api.js";
import type { AsrEngine } from "./post/asr.js";
import { PostProduction } from "./post/index.js";
import type { Storage } from "./storage/index.js";
import { createTelemetry, type Telemetry } from "./telemetry.js";
import { verifyToken, type TokenClaims } from "./tokens.js";
import * as v from "./validate.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface App {
  server: Server;
  collector: Collector;
  post: PostProduction;
  telemetry: Telemetry;
}

export function createApp(config: Config, storage: Storage, asr?: AsrEngine): App {
  const telemetry = createTelemetry(config.telemetry, config.tokenSecret, config.version);
  const collector = new Collector(config, storage, telemetry);
  const post = new PostProduction(config, storage, asr, telemetry);
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => fail(res, error));
  });

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(payload);
  }

  function fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) telemetry.capture({ name: "error", source: "http", code: error.code, status: error.status });
      json(res, error.status, { error: error.code, ...error.extra });
      return;
    }
    console.error("unhandled request error", error);
    telemetry.capture({ name: "error", source: "http", code: "internal_error", status: 500 });
    json(res, 500, { error: "internal_error" });
  }

  async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > limit) throw new HttpError(413, "body_too_large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req, 1024 * 1024);
    if (raw.length === 0) return {};
    try {
      return v.asObject(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_json");
    }
  }

  function claims(req: IncomingMessage, url: URL, role: TokenClaims["role"], sid: string): TokenClaims {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    const verified = token ? verifyToken(config.tokenSecret, token) : null;
    if (!verified) throw new HttpError(401, "unauthorized");
    if (verified.sid !== sid || verified.role !== role) throw new HttpError(403, "forbidden");
    return verified;
  }

  function participant(req: IncomingMessage, url: URL, sid: string): TokenClaims & { pid: string } {
    const verified = claims(req, url, "participant", sid);
    if (!verified.pid) throw new HttpError(403, "forbidden");
    return verified as TokenClaims & { pid: string };
  }

  function host(req: IncomingMessage, url: URL, sid: string): TokenClaims & { pid: string } {
    const verified = participant(req, url, sid);
    if (!verified.host) throw new HttpError(403, "host_only");
    return verified;
  }

  const userAgent = (req: IncomingMessage): string | null => {
    const value = req.headers["user-agent"];
    return typeof value === "string" ? value : null;
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"

    if (method === "GET" && parts[0] === "health" && parts.length === 1) {
      json(res, 200, { ok: true, version: config.version });
      return;
    }
    if (method === "GET" && parts[0] === "config" && parts.length === 1) {
      json(res, 200, { createKeyRequired: config.createKey !== null, maxParticipants: MAX_PARTICIPANTS, version: config.version });
      return;
    }
    if (method === "POST" && parts[0] === "sessions" && parts.length === 1) {
      const body = await readJson(req);
      const name = v.str(body.name, "name", 60);
      const createKey = body.createKey === undefined ? undefined : v.str(body.createKey, "createKey", 200);
      json(res, 201, await collector.createSession(name, createKey, userAgent(req)));
      return;
    }
    if (parts[0] !== "sessions" || parts.length < 2) throw new HttpError(404, "not_found");
    const sid = v.id(parts[1], "sessionId");
    const rest = parts.slice(2);

    if (method === "POST" && rest.length === 1 && rest[0] === "join") {
      claims(req, url, "invite", sid);
      const body = await readJson(req);
      json(res, 201, await collector.join(sid, v.str(body.name, "name", 60), userAgent(req)));
      return;
    }

    const who = participant(req, url, sid);

    if (method === "GET" && rest.length === 0) {
      json(res, 200, await collector.view(sid, who.pid));
      return;
    }
    if (method === "GET" && rest.length === 1 && rest[0] === "events") {
      await collector.subscribe(sid, who.pid, res);
      return;
    }
    if (method === "POST" && rest.length === 1 && rest[0] === "clock") {
      json(res, 200, collector.clock());
      return;
    }
    if (method === "POST" && rest.length === 1 && rest[0] === "status") {
      const body = await readJson(req);
      const state = body.state;
      if (state !== "idle" && state !== "ready" && state !== "recording" && state !== "stopped") throw new HttpError(400, "invalid_field", { field: "state" });
      if (!Array.isArray(body.kinds)) throw new HttpError(400, "invalid_field", { field: "kinds" });
      const request: StatusRequest = {
        state,
        kinds: body.kinds.map((item) => v.kind(item, "kinds")),
        ...(body.consentVersion === undefined ? {} : { consentVersion: v.str(body.consentVersion, "consentVersion", 40) }),
      };
      await collector.setStatus(sid, who.pid, request);
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && rest.length === 1 && rest[0] === "markers") {
      host(req, url, sid);
      json(res, 201, await collector.createMarker(sid));
      return;
    }
    if (method === "POST" && rest.length === 1 && rest[0] === "end") {
      host(req, url, sid);
      const body = await readJson(req);
      json(res, 200, await collector.endSession(sid, body.force === true));
      return;
    }
    if (method === "GET" && rest.length === 1 && rest[0] === "manifest") {
      host(req, url, sid);
      json(res, 200, await collector.manifest(sid));
      return;
    }

    if (rest[0] === "project") {
      host(req, url, sid);
      if (await postRoutes(post, { json, readJson }, req, res, sid, rest.slice(1))) return;
      throw new HttpError(404, "not_found");
    }

    if (rest[0] === "tracks") {
      if (method === "POST" && rest.length === 1) {
        const body = await readJson(req);
        const request: DeclareTrackRequest = {
          trackId: v.id(body.trackId, "trackId"),
          kind: v.kind(body.kind, "kind"),
          mime: v.str(body.mime, "mime", 120),
          settings: v.settings(body.settings, "settings"),
          startClientMs: v.num(body.startClientMs, "startClientMs"),
          startCallClientMs: v.num(body.startCallClientMs, "startCallClientMs"),
          offsetMs: v.num(body.offsetMs, "offsetMs"),
          rttMs: v.num(body.rttMs, "rttMs"),
          clockSamples: v.clockSamples(body.clockSamples, "clockSamples"),
        };
        json(res, 200, await collector.declareTrack(sid, who.pid, request));
        return;
      }
      const tid = v.id(rest[1], "trackId");
      if (method === "GET" && rest.length === 2) {
        json(res, 200, await collector.trackState(sid, who.pid, tid));
        return;
      }
      if (method === "PUT" && rest.length === 3 && rest[2] === "data") {
        const offset = v.nonNegativeInt(Number(url.searchParams.get("offset")), "offset");
        const body = await readBody(req, config.maxUploadBytes);
        const digest = req.headers["x-sha256"];
        json(res, 200, await collector.receive(sid, who.pid, tid, offset, body, typeof digest === "string" ? digest : undefined));
        return;
      }
      if (method === "POST" && rest.length === 3 && rest[2] === "finalize") {
        const body = await readJson(req);
        const request: FinalizeRequest = {
          totalBytes: v.nonNegativeInt(body.totalBytes, "totalBytes"),
          chunkCount: v.nonNegativeInt(body.chunkCount, "chunkCount"),
          endClientMs: body.endClientMs === null ? null : v.num(body.endClientMs, "endClientMs"),
          endReason: v.endReason(body.endReason, "endReason"),
          clockSamples: v.clockSamples(body.clockSamples, "clockSamples"),
          markers: v.markers(body.markers, "markers"),
        };
        json(res, 200, await collector.finalizeTrack(sid, who.pid, tid, request));
        return;
      }
    }
    throw new HttpError(404, "not_found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "bad_path");
    }
    const root = config.webDir;
    let target = path.resolve(root, `.${relative}`);
    if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(404, "not_found");
    let info = await stat(target).catch(() => null);
    if (!info || info.isDirectory()) {
      // Client side routes (/join/<id>) all serve the single page app.
      relative = "/index.html";
      target = path.join(root, "index.html");
      info = await stat(target).catch(() => null);
      if (!info) throw new HttpError(404, "web_client_not_built");
    }
    const extension = path.extname(target);
    res.writeHead(200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": relative.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", CSP);
    res.setHeader("permissions-policy", "microphone=(self), camera=(self), display-capture=(self)");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await api(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  }

  return { server, collector, post, telemetry };
}
