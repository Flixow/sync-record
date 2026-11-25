import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { chaptersForYoutube, formatChapters, validateChapters } from "../../shared/chapters.js";
import { adjustRange, DEFAULT_CLIP_LIMIT, suggestClips, type ClipProject } from "../../shared/clips.js";
import { presetById } from "../../shared/presets.js";
import type { ProjectFile } from "../../shared/project.js";
import { draftTitleAndDescription, thumbnailCandidates, thumbnailSpec, type ThumbnailKind } from "../../shared/publish.js";
import type { TranscriptFile } from "../../shared/transcript.js";
import { HttpError } from "../errors.js";
import * as v from "../validate.js";
import { readEdl } from "./edl-store.js";
import type { Http } from "./api.js";
import type { PostProduction } from "./index.js";
import { createLlmClient, llmDraft, rerankWithLlm } from "./llm.js";
import { writeJson } from "./projects.js";
import { TRANSCRIPT_FILE } from "./transcribe.js";

const CLIPS_FILE = "clips.json";
const MAX_CLIPS = 500;

export interface ClipsFile {
  schemaVersion: 1;
  rev: number;
  updatedAtMs: number;
  clips: ClipProject[];
}

async function readClips(dir: string): Promise<ClipsFile> {
  try {
    return JSON.parse(await readFile(path.join(dir, CLIPS_FILE), "utf8")) as ClipsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, rev: 0, updatedAtMs: 0, clips: [] };
    throw error;
  }
}

const writes = new Map<string, Promise<unknown>>();

function saveClips(dir: string, baseRev: number, clips: ClipProject[]): Promise<ClipsFile> {
  const work = (writes.get(dir) ?? Promise.resolve()).then(async () => {
    const current = await readClips(dir);
    if (current.rev !== baseRev) throw new HttpError(409, "clips_conflict", { rev: current.rev });
    const file: ClipsFile = { schemaVersion: 1, rev: current.rev + 1, updatedAtMs: Date.now(), clips };
    await writeJson(path.join(dir, CLIPS_FILE), file);
    return file;
  });
  writes.set(dir, work.catch(() => undefined));
  return work;
}

async function transcriptOf(post: PostProduction, sid: string): Promise<TranscriptFile> {
  try {
    return JSON.parse(await readFile(path.join(post.store.dir(sid), TRANSCRIPT_FILE), "utf8")) as TranscriptFile;
  } catch {
    throw new HttpError(409, "transcript_missing");
  }
}

/** Level tracks of every participant's microphone, by participant id. */
async function speakerLevels(project: ProjectFile, dir: string): Promise<{ pid: string; levels: Int8Array }[]> {
  const out: { pid: string; levels: Int8Array }[] = [];
  for (const participant of project.participants) {
    const own = project.sources.filter((source) => source.participantId === participant.id && source.audio);
    const mic = own.find((source) => source.kind === "audio") ?? own[0];
    if (!mic?.audio) continue;
    const buffer = await readFile(path.join(dir, mic.audio.levels)).catch(() => null);
    if (buffer) out.push({ pid: participant.id, levels: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) });
  }
  return out;
}

const languageOf = (transcript: TranscriptFile): "en" | "pl" => (transcript.lang === "pl" ? "pl" : "en");

function parseClips(value: unknown, sid: string, durationMs: number): ClipProject[] {
  if (!Array.isArray(value) || value.length > MAX_CLIPS) throw new HttpError(400, "invalid_field", { field: "clips" });
  const seen = new Set<string>();
  return value.map((item) => {
    const o = v.asObject(item);
    const id = v.id(o.id, "clips");
    if (seen.has(id)) throw new HttpError(400, "invalid_field", { field: "clips" });
    seen.add(id);
    const s = Math.round(v.num(o.s, "clips"));
    const e = Math.round(v.num(o.e, "clips"));
    if (s < 0 || e <= s || e > durationMs) throw new HttpError(400, "invalid_field", { field: "clips" });
    const preset = v.str(o.preset, "clips", 64);
    if (!presetById(preset)) throw new HttpError(400, "invalid_field", { field: "clips" });
    return { id, parentSid: sid, s, e, preset, name: v.str(o.name, "clips", 120) };
  });
}

/** Clips, chapters, titles and thumbnail candidates; every one of them works without the optional language model. */
export async function handlePublishRoutes(post: PostProduction, sid: string, rest: string[], method: string, req: IncomingMessage, res: ServerResponse, http: Http): Promise<boolean> {
  const dir = post.store.dir(sid);
  if (rest[0] === "clips" && rest.length === 1) {
    const project = await post.store.require(sid);
    if (method === "GET") {
      http.json(res, 200, await readClips(dir));
      return true;
    }
    if (method === "PUT") {
      const body = await http.readJson(req);
      http.json(res, 200, await saveClips(dir, v.nonNegativeInt(body.baseRev, "baseRev"), parseClips(body.clips, sid, project.durationMs)));
      return true;
    }
  }
  if (rest[0] === "clips" && rest[1] === "suggest" && rest.length === 2 && method === "POST") {
    const project = await post.store.require(sid);
    const body = await http.readJson(req);
    const transcript = await transcriptOf(post, sid);
    const limit = body.limit === undefined ? DEFAULT_CLIP_LIMIT : Math.min(50, v.nonNegativeInt(body.limit, "limit"));
    const levels = await speakerLevels(project, dir);
    let suggestions = suggestClips({ words: transcript.words, levels, highlights: project.highlights.map((h) => ({ tMs: h.atMs })), durationMs: project.durationMs, limit }, { lang: languageOf(transcript) });
    // the language model only re-orders: it is off unless the host configured one and the request asks for it
    const llm = createLlmClient(body.llm === true ? post.config.post.llm : null);
    const reranked = llm.enabled ? await rerankWithLlm(suggestions, transcript.words, llm) : suggestions;
    const llmUsed = llm.enabled && reranked !== suggestions;
    suggestions = reranked;
    http.json(res, 200, { suggestions, llmUsed, llmAvailable: post.config.post.llm !== null });
    return true;
  }
  if (rest[0] === "clips" && rest[1] === "adjust" && rest.length === 2 && method === "POST") {
    await post.store.require(sid);
    const body = await http.readJson(req);
    const transcript = await transcriptOf(post, sid);
    const change = { ...(body.sMs === undefined ? {} : { sMs: v.num(body.sMs, "sMs") }), ...(body.eMs === undefined ? {} : { eMs: v.num(body.eMs, "eMs") }) };
    http.json(res, 200, adjustRange({ s: v.num(body.s, "s"), e: v.num(body.e, "e") }, transcript.words, change));
    return true;
  }
  if (rest[0] === "chapters" && rest.length === 1 && method === "GET") {
    const project = await post.store.require(sid);
    const transcript = await transcriptOf(post, sid);
    const edl = await readEdl(dir);
    const duration = project.durationMs - edl.removed.reduce((sum, range) => sum + range.e - range.s, 0);
    const chapters = chaptersForYoutube(transcript.words, project.durationMs, edl);
    http.json(res, 200, { chapters, validation: validateChapters(chapters, duration), text: formatChapters(chapters) });
    return true;
  }
  if (rest[0] === "publish" && rest[1] === "draft" && rest.length === 2 && method === "POST") {
    const project = await post.store.require(sid);
    const body = await http.readJson(req);
    const transcript = await transcriptOf(post, sid);
    const edl = await readEdl(dir);
    const chapters = chaptersForYoutube(transcript.words, project.durationMs, edl);
    const language = body.language === "pl" || body.language === "en" ? body.language : languageOf(transcript);
    const names = new Map(project.participants.map((p) => [p.id, p.name]));
    const input = { words: transcript.words, chapters, speakers: transcript.speakers.map((s) => names.get(s.pid) ?? s.name), language, ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim().slice(0, 120) } : {}) } as const;
    const llm = createLlmClient(body.llm === true ? post.config.post.llm : null);
    const improved = llm.enabled ? await llmDraft(llm, input) : null;
    http.json(res, 200, { draft: improved ?? draftTitleAndDescription(input), llmUsed: improved !== null, llmAvailable: post.config.post.llm !== null, chapters, validation: validateChapters(chapters, project.durationMs - edl.removed.reduce((sum, range) => sum + range.e - range.s, 0)) });
    return true;
  }
  if (rest[0] === "thumbnails" && rest.length === 1 && method === "GET") {
    const project = await post.store.require(sid);
    const transcript = await transcriptOf(post, sid);
    const kind: ThumbnailKind = new URL(req.url ?? "/", "http://localhost").searchParams.get("kind") === "short" ? "short" : "video";
    const levels = await speakerLevels(project, dir);
    http.json(res, 200, { spec: thumbnailSpec(kind), candidates: thumbnailCandidates({ durationMs: project.durationMs, highlights: project.highlights.map((h) => ({ tMs: h.atMs })), words: transcript.words, levels }) });
    return true;
  }
  return false;
}
