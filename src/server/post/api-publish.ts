import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { chaptersForYoutube, formatChapters, topKeywords, validateChapters, wordsThroughEdl, type Chapter } from "../../shared/chapters.js";
import { adjustRange, DEFAULT_CLIP_LIMIT, suggestClips, type ClipProject } from "../../shared/clips.js";
import { presetById } from "../../shared/presets.js";
import type { ProjectFile } from "../../shared/project.js";
import { SHORTS_DEFAULT_COUNT } from "../../shared/shorts.js";
import { draftTitleAndDescription, type ThumbnailKind } from "../../shared/publish.js";
import { fallbackHooks, mergeHooks } from "../../shared/thumb-hooks.js";
import { sentenceContext } from "../../shared/thumb-moments.js";
import type { TranscriptFile } from "../../shared/transcript.js";
import { HttpError } from "../errors.js";
import * as v from "../validate.js";
import { readEdl } from "./edl-store.js";
import type { Http } from "./api.js";
import type { PostProduction } from "./index.js";
import { agentClips } from "./shorts-agent.js";
import { createLlmClient, DEFAULT_SHORTS_TIMEOUT_MS, llmChapterTitles, llmDraft, llmThumbnailHooks } from "./llm.js";
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

export async function transcriptOf(post: PostProduction, sid: string): Promise<TranscriptFile> {
  try {
    return JSON.parse(await readFile(path.join(post.store.dir(sid), TRANSCRIPT_FILE), "utf8")) as TranscriptFile;
  } catch {
    throw new HttpError(409, "transcript_missing");
  }
}

/** Level tracks of every participant's microphone, by participant id. */
export async function speakerLevels(project: ProjectFile, dir: string): Promise<{ pid: string; levels: Int8Array }[]> {
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

export const languageOf = (transcript: TranscriptFile): "en" | "pl" => (transcript.lang === "pl" ? "pl" : "en");

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

const CHAPTER_MEMO_MAX = 50;
/** Model-titled chapter lists by (project, language, template list): the chapters box reloads often and must not call the model every time. */
const chapterMemo = new Map<string, Chapter[]>();

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
    const highlights = project.highlights.map((h) => ({ tMs: h.atMs }));
    // the language model cuts the clips (one request, transcript text only): it is used whenever the host configured one, unless the request says `llm: false`; the rules answer when it does not
    const llm = createLlmClient(body.llm !== false ? post.config.post.llm : null);
    const agent = llm.enabled
      ? await agentClips(llm, { words: transcript.words, highlights, durationMs: project.durationMs, count: body.count === undefined ? SHORTS_DEFAULT_COUNT : v.nonNegativeInt(body.count, "count"), timeoutMs: post.config.post.llm?.shortsTimeoutMs ?? DEFAULT_SHORTS_TIMEOUT_MS })
      : null;
    // no usable answer from the model: the rules cut the clips, as they always did, and the reason is in `llmFailure`
    const llmUsed = agent !== null && agent.failure === null;
    const suggestions = agent !== null && llmUsed ? agent.clips : suggestClips({ words: transcript.words, levels: await speakerLevels(project, dir), highlights, durationMs: project.durationMs, limit }, { lang: languageOf(transcript) });
    http.json(res, 200, { suggestions, source: llmUsed ? "agent" : "rule", llmUsed, llmAvailable: post.config.post.llm !== null, llmFailure: agent?.failure ?? null });
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
    const baseChapters = chaptersForYoutube(transcript.words, project.durationMs, edl);
    // the listed chapters are the ones the description gets: the model (when the host configured one) titles them here too, once per
    // distinct list; the keyword titles of the rules are the fallback
    const llm = createLlmClient(new URL(req.url ?? "/", "http://x").searchParams.get("llm") === "0" ? null : post.config.post.llm);
    const language = languageOf(transcript);
    const memoKey = `${sid}|${language}|${baseChapters.map((chapter) => `${chapter.startMs}:${chapter.title}`).join("|")}`;
    let titled = chapterMemo.get(memoKey) ?? null;
    if (!titled && llm.enabled) {
      titled = await llmChapterTitles(llm, baseChapters, wordsThroughEdl(transcript.words, edl), language);
      if (titled) {
        if (chapterMemo.size >= CHAPTER_MEMO_MAX) chapterMemo.delete(chapterMemo.keys().next().value as string);
        chapterMemo.set(memoKey, titled);
      }
    }
    const chapters = titled ?? baseChapters;
    http.json(res, 200, { chapters, validation: validateChapters(chapters, duration), text: formatChapters(chapters), llmUsed: titled !== null, llmAvailable: post.config.post.llm !== null });
    return true;
  }
  if (rest[0] === "publish" && rest[1] === "draft" && rest.length === 2 && method === "POST") {
    const project = await post.store.require(sid);
    const body = await http.readJson(req);
    const transcript = await transcriptOf(post, sid);
    const edl = await readEdl(dir);
    const baseChapters = chaptersForYoutube(transcript.words, project.durationMs, edl);
    const language = body.language === "pl" || body.language === "en" ? body.language : languageOf(transcript);
    const names = new Map(project.participants.map((p) => [p.id, p.name]));
    const llm = createLlmClient(body.llm !== false ? post.config.post.llm : null);
    // the model only retitles the chapters (times and count stay), then writes the titles and summary around them
    const retitled = llm.enabled ? await llmChapterTitles(llm, baseChapters, wordsThroughEdl(transcript.words, edl), language) : null;
    const chapters = retitled ?? baseChapters;
    const input = { words: transcript.words, chapters, speakers: transcript.speakers.map((s) => names.get(s.pid) ?? s.name), language, ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim().slice(0, 120) } : {}) } as const;
    const improved = llm.enabled ? await llmDraft(llm, input) : null;
    const llmUsed = improved !== null || retitled !== null;
    http.json(res, 200, { draft: improved ?? draftTitleAndDescription(input), llmUsed, llmAvailable: post.config.post.llm !== null, llmFailure: llmUsed ? null : (llm.lastFailure ?? null), chapters, validation: validateChapters(chapters, project.durationMs - edl.removed.reduce((sum, range) => sum + range.e - range.s, 0)) });
    return true;
  }
  if (rest[0] === "thumbnail" && rest[1] === "previews" && rest.length === 2 && method === "POST") {
    const project = await post.store.require(sid);
    const body = await http.readJson(req);
    const params: Record<string, unknown> = { kind: (body.kind === "short" ? "short" : "video") satisfies ThumbnailKind };
    if (body.around !== undefined) {
      const around = v.num(body.around, "around");
      if (around < 0 || around > project.durationMs) throw new HttpError(400, "invalid_field", { field: "around" });
      params.around = Math.round(around);
    }
    // the job kind is queued here and not through POST /jobs: previews are made by this panel only
    http.json(res, 202, await post.jobs.enqueue(sid, "thumbnail-previews", params));
    return true;
  }
  if (rest[0] === "thumbnail" && rest[1] === "hooks" && rest.length === 2 && method === "POST") {
    const project = await post.store.require(sid);
    const body = await http.readJson(req);
    const atMs = v.num(body.atMs, "atMs");
    if (atMs < 0 || atMs > project.durationMs) throw new HttpError(400, "invalid_field", { field: "atMs" });
    const transcript = await transcriptOf(post, sid);
    const language = body.language === "pl" || body.language === "en" ? body.language : languageOf(transcript);
    const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim().slice(0, 120) : (draftTitleAndDescription({ words: transcript.words, chapters: [], speakers: [], language }).titles[0] ?? "");
    const { sentence, context } = sentenceContext(transcript.words, atMs);
    // text only: the model reads the words spoken at the frame and the title, never a picture
    const llm = createLlmClient(body.llm !== false ? post.config.post.llm : null);
    const written = llm.enabled ? await llmThumbnailHooks(llm, { sentenceAroundFrame: context, title, language }) : null;
    const rules = fallbackHooks({ sentence, title, keywords: topKeywords(transcript.words, 12, language).map((keyword) => keyword.text), language });
    http.json(res, 200, { hooks: mergeHooks([written ?? [], rules], title), sentence, title, llmUsed: written !== null, llmAvailable: post.config.post.llm !== null, llmFailure: llm.enabled && written === null ? (llm.lastFailure ?? null) : null });
    return true;
  }
  return false;
}
