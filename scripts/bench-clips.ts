// Gate measurements of clip suggestions (S6) and of chapters and publishing helpers (S7) on the product transcripts. Prints JSON.
//   tsx scripts/bench-clips.ts [--dir <work dir>] [--en <post dir>] [--pl <post dir>] [--en-bleed <post dir>] [--pl-bleed <post dir>]
// A post dir holds project.json, transcript.json and levels/ of one project. S6 (a): the share of suggestions whose start and
// end fall on sentence boundaries, judged from the words alone (not through splitSentences), over four transcripts; (b) the top
// five suggestions of the clean transcripts as markdown for a human to judge; (d) the same run with the language model off.
// S7: chapters validate with and without an EDL, the chapters and titles, the thumbnail spec, the description drafts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLlmClient } from "../src/server/post/llm.js";
import { agentClips } from "../src/server/post/shorts-agent.js";
import { chaptersForYoutube, formatChapters, segmentTopics, validateChapters, type Chapter } from "../src/shared/chapters.js";
import { clipText, clipToEdl, normalizeWords, REASON_TEXT, suggestClips, type ClipSuggestion } from "../src/shared/clips.js";
import { keptDuration, normalize, type Edl } from "../src/shared/edl.js";
import type { ProjectFile } from "../src/shared/project.js";
import { draftTitleAndDescription, overlayTextLayout, thumbnailCandidates, thumbnailSpec } from "../src/shared/publish.js";
import { insideRect, safeArea } from "../src/shared/safe-area.js";
import type { TranscriptFile, TranscriptWord } from "../src/shared/transcript.js";
import { random, script, type Line } from "../tests/support/talk.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const tmp = process.env.TMPDIR ?? os.tmpdir();
const dir = path.resolve(arg("dir", path.join(tmp, "bench-clips")));
mkdirSync(dir, { recursive: true });
const post = (variant: string, lang: string): string => path.join(tmp, `bench-asr3-${lang}`, "post", `bench-${variant}-${lang}-0001`);
const projects = {
  "en-clean": arg("en", post("clean", "en")),
  "pl-clean": arg("pl", post("clean", "pl")),
  "en-bleed": arg("en-bleed", post("bleed", "en")),
  "pl-bleed": arg("pl-bleed", post("bleed", "pl")),
};
const round = (value: number, digits = 1): number => Number(value.toFixed(digits));

interface Loaded {
  transcript: TranscriptFile;
  project: ProjectFile;
  levels: { pid: string; levels: Int8Array }[];
  nameOf: (pid: string) => string;
}

function load(projectDir: string): Loaded {
  const transcript = JSON.parse(readFileSync(path.join(projectDir, "transcript.json"), "utf8")) as TranscriptFile;
  const project = JSON.parse(readFileSync(path.join(projectDir, "project.json"), "utf8")) as ProjectFile;
  const levels = project.sources
    .filter((source) => source.audio)
    .map((source) => {
      const buffer = readFileSync(path.join(projectDir, source.audio?.levels ?? ""));
      return { pid: source.participantId, levels: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
    });
  const names = new Map(transcript.speakers.map((speaker) => [speaker.pid, speaker.name]));
  return { transcript, project, levels, nameOf: (pid) => names.get(pid) ?? pid };
}

// ---- boundary check, independent of splitSentences ----------------------------------------------------------------------

const TERMINAL = /[.?!…]["')\]»”’]*$/u;
const PAUSE_MS = 1200;

/** The word starting at `ms` is the first of its speaker after a sentence end or a pause longer than 1.2 s. */
function startsOnBoundary(words: TranscriptWord[], ms: number): boolean {
  const index = words.findIndex((word) => word.s === ms);
  if (index < 0) return false;
  const word = words[index] as TranscriptWord;
  const previous = words
    .slice(0, index)
    .reverse()
    .find((other) => other.pid === word.pid);
  return previous === undefined || TERMINAL.test(previous.t) || word.s - previous.e > PAUSE_MS;
}

/** The word ending at `ms` ends with terminal punctuation, or the speaker pauses for more than 1.2 s (or stops) after it. */
function endsOnBoundary(words: TranscriptWord[], ms: number): boolean {
  const index = words.findLastIndex((word) => word.e === ms);
  if (index < 0) return false;
  const word = words[index] as TranscriptWord;
  const next = words.slice(index + 1).find((other) => other.pid === word.pid);
  return TERMINAL.test(word.t) || next === undefined || next.s - word.e > PAUSE_MS;
}

/** A word of anybody that straddles the edge: the cut would go through it. */
const straddles = (words: TranscriptWord[], ms: number): boolean => words.some((word) => word.s < ms && word.e > ms);

const result: Record<string, unknown> = { node: process.version };

// ---- S6 (a) ----------------------------------------------------------------------------------------------------------------

const loaded = Object.fromEntries(Object.entries(projects).map(([name, projectDir]) => [name, load(projectDir)])) as Record<keyof typeof projects, Loaded>;
const boundary: Record<string, unknown> = {};
let onBoundary = 0;
let edges = 0;
let suggestionsTotal = 0;
for (const limit of [10, 30]) {
  for (const [name, data] of Object.entries(loaded)) {
    const words = normalizeWords(data.transcript.words);
    const started = performance.now();
    const clips = suggestClips({ words: data.transcript.words, levels: data.levels, highlights: data.project.highlights.map((highlight) => ({ tMs: highlight.atMs })), durationMs: data.project.durationMs, limit });
    const wall = performance.now() - started;
    const starts = clips.filter((clip) => startsOnBoundary(words, clip.s)).length;
    const ends = clips.filter((clip) => endsOnBoundary(words, clip.e)).length;
    const both = clips.filter((clip) => startsOnBoundary(words, clip.s) && endsOnBoundary(words, clip.e)).length;
    if (limit === 10) {
      onBoundary += both;
      suggestionsTotal += clips.length;
    }
    edges += clips.filter((clip) => straddles(words, clip.s) || straddles(words, clip.e)).length;
    boundary[`${name}-limit${limit}`] = {
      words: data.transcript.words.length,
      suggestions: clips.length,
      startOnBoundary: starts,
      endOnBoundary: ends,
      bothOnBoundary: both,
      share: clips.length === 0 ? null : round(both / clips.length, 3),
      lengthSecMinMax: clips.length === 0 ? null : [round(Math.min(...clips.map((clip) => clip.e - clip.s)) / 1000), round(Math.max(...clips.map((clip) => clip.e - clip.s)) / 1000)],
      noReason: clips.filter((clip) => clip.reasons.length === 0).length,
      wallMs: round(wall),
    };
  }
}
result.s6a = { gate: ">= 0.95 of suggestions on sentence boundaries at both ends", shareLimit10: round(onBoundary / suggestionsTotal, 3), suggestionsLimit10: suggestionsTotal, clipsCuttingThroughAWord: edges, perTranscript: boundary };

// ---- S6 (b): the top five for a human ---------------------------------------------------------------------------------------

const mmss = (ms: number): string => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${(((ms % 60_000) / 1000).toFixed(1)).padStart(4, "0")}`;
function top5(name: "en-clean" | "pl-clean", file: string): void {
  const data = loaded[name];
  const clips = suggestClips({ words: data.transcript.words, levels: data.levels, durationMs: data.project.durationMs, limit: 5 });
  const parts = [`# Top 5 clip suggestions: ${name}`, "", `Source: ${projects[name]}/transcript.json, ${data.transcript.words.length} words, ${round(data.project.durationMs / 1000)} s, transcript language ${data.transcript.lang}. Heuristic only (no model), levels used.`, ""];
  clips.forEach((clip, index) => {
    parts.push(`## ${index + 1}. ${mmss(clip.s)} – ${mmss(clip.e)} (${round((clip.e - clip.s) / 1000)} s), score ${clip.score}`, "");
    parts.push(`Title: ${clip.title}`, `Speakers: ${clip.speakers.map(data.nameOf).join(", ")}`, `Reasons: ${clip.reasons.map((reason) => `${reason}: ${REASON_TEXT[reason]?.en ?? ""}`).join(" ")}`, "");
    parts.push(...clipText(data.transcript.words, clip, data.nameOf).split("\n").map((line) => `> ${line}`), "", "Human verdict: pending", "");
  });
  writeFileSync(file, parts.join("\n"));
}
top5("en-clean", path.join(tmp, "s6-top5-en.md"));
top5("pl-clean", path.join(tmp, "s6-top5-pl.md"));
result.s6b = { files: [path.join(tmp, "s6-top5-en.md"), path.join(tmp, "s6-top5-pl.md")], note: "human verdict pending" };

// ---- S6 (d) and extras: no model, marker, energy, speed ----------------------------------------------------------------------

const off = createLlmClient({ url: null, model: "none", timeoutMs: 30_000 });
const base = loaded["en-clean"];
const heuristic = suggestClips({ words: base.transcript.words, levels: base.levels, durationMs: base.project.durationMs, limit: 10 });
const markerAt = 333_000;
const marked = suggestClips({ words: base.transcript.words, levels: base.levels, highlights: [{ tMs: markerAt }], durationMs: base.project.durationMs, limit: 10 });
const plain = suggestClips({ words: base.transcript.words, durationMs: base.project.durationMs, limit: 10 });
const big = script(Array.from({ length: 2800 }, (_, index): Line => ({ pid: index % 2 === 0 ? "a" : "b", text: "We moved the cache next to the database and the latency dropped a lot.", gap: 2500 })));
const bigStarted = performance.now();
const bigClips = suggestClips({ words: big.words, durationMs: big.endMs });
result.s6d = {
  agentOffMakesNoRequest: (await agentClips(off, { words: base.transcript.words, durationMs: base.project.durationMs })).failure === "disabled",
  llmEnabled: off.enabled,
  markerWindowFirstWithMarkerReason: marked[0]?.reasons[0] === "marker" && (marked[0]?.s ?? Infinity) <= markerAt && (marked[0]?.e ?? 0) >= markerAt,
  withLevelsVsWithout: { sameFirst: plain[0]?.id === heuristic[0]?.id, withLevelsTop3: heuristic.slice(0, 3).map((clip: ClipSuggestion) => [clip.s, clip.e, clip.score]), withoutTop3: plain.slice(0, 3).map((clip: ClipSuggestion) => [clip.s, clip.e, clip.score]) },
  threeHourSyntheticMs: round(performance.now() - bigStarted),
  threeHourSyntheticWords: big.words.length,
  threeHourSyntheticClips: bigClips.length,
};

// ---- S7 ---------------------------------------------------------------------------------------------------------------------

const edls = (duration: number): Record<string, Edl> => ({
  none: { removed: [] },
  trimmed: { removed: normalize([{ s: 0, e: 5000 }, { s: 60_000, e: 75_000 }, { s: 200_000, e: 230_000 }, { s: 400_000, e: 420_000 }], duration) },
  "one clip": clipToEdl({ s: 120_000, e: 175_000 }, duration),
});
const s7: Record<string, unknown> = {};
for (const name of ["en-clean", "pl-clean", "en-bleed", "pl-bleed"] as const) {
  const data = loaded[name];
  const duration = data.project.durationMs;
  const perEdl: Record<string, unknown> = {};
  for (const [edlName, edl] of Object.entries(edls(duration))) {
    const output = keptDuration(edl, duration);
    const chapters = chaptersForYoutube(data.transcript.words, duration, edl);
    const topics = segmentTopics(edl.removed.length === 0 ? data.transcript.words : [], output);
    perEdl[edlName] = { outputSec: round(output / 1000), validation: validateChapters(chapters, output), topicsFoundBeforePadding: edl.removed.length === 0 ? topics.length : undefined, chapters: formatChapters(chapters).split("\n") };
  }
  s7[name] = perEdl;
}
result.s7Chapters = s7;

// synthetic talk with real lexical structure: how close are the found boundaries to the true ones
const pools = [
  ["satellite", "phone", "antenna", "signal", "orbit", "coverage", "network", "receiver"],
  ["pasta", "sauce", "oven", "garlic", "butter", "kitchen", "recipe", "pepper"],
  ["football", "goal", "referee", "stadium", "keeper", "penalty", "season", "defender"],
  ["garden", "tomato", "soil", "compost", "seeds", "greenhouse", "harvest", "pruning"],
];
const next = random(5);
const topicLines: Line[] = [];
const truth: number[] = [];
let at = 1000;
for (const nouns of pools) {
  truth.push(at);
  for (let i = 0; i < 60; i++) {
    const pick = (): string => nouns[Math.floor(next() * nouns.length)] as string;
    const text = [`The ${pick()} and the ${pick()} of that ${pick()} keeps the ${pick()}.`, `With the ${pick()} the ${pick()} holds all of the ${pick()} and the ${pick()}.`][Math.floor(next() * 2)] as string;
    const line: Line = { pid: i % 2 === 0 ? "a" : "b", text, gap: 700 };
    topicLines.push(line);
    at += 700 + text.split(" ").length * 320;
  }
}
const talk = script(topicLines);
const found = segmentTopics(talk.words, talk.endMs);
const syntheticChapters = chaptersForYoutube(talk.words, talk.endMs);
result.s7SyntheticTopics = {
  trueBoundariesSec: truth.slice(1).map((ms) => round(ms / 1000)),
  foundBoundariesSec: found.slice(1).map((topic) => round(topic.s / 1000)),
  titles: syntheticChapters.map((chapter: Chapter) => `${formatChapters([chapter])}`),
  validation: validateChapters(syntheticChapters, talk.endMs),
};

const draftFor = (name: "en-clean" | "pl-clean", language: "en" | "pl", title?: string): unknown => {
  const data = loaded[name];
  const chapters = chaptersForYoutube(data.transcript.words, data.project.durationMs);
  const draft = draftTitleAndDescription({ words: data.transcript.words, chapters, speakers: data.transcript.speakers.filter((speaker) => speaker.name !== "Silent").map((speaker) => speaker.name), language, ...(title ? { name: title } : {}) });
  return { ...draft, description: draft.description.split("\n") };
};
const video = thumbnailSpec("video");
const short = thumbnailSpec("short");
const layout = overlayTextLayout("DLACZEGO PIERWSZA WERSJA ZAWIODŁA W PRODUKCJI", short, "top");
result.s7Publish = {
  thumbnailSpec: { video, short, maxMiB: video.maxBytes / 1024 / 1024 },
  overlayShort: { ...layout, insideSafeArea: insideRect(layout.box, safeArea(short)) },
  overlayVideo: (() => {
    const l = overlayTextLayout("WHY THE FIRST VERSION FAILED", video, "left");
    return { ...l, insideSafeArea: insideRect(l.box, safeArea(video)) };
  })(),
  thumbnailCandidatesEn: thumbnailCandidates({ durationMs: base.project.durationMs, highlights: [{ tMs: 120_000 }], words: base.transcript.words, levels: base.levels }),
  draftEn: draftFor("en-clean", "en", "Weekly talk"),
  draftPl: draftFor("pl-clean", "pl"),
};

console.log(JSON.stringify(result, null, 2));
