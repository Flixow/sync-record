import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BACKGROUND, LAYOUT_IDS, type Aspect, type Background, type Fit } from "../../shared/layout.js";
import { DEFAULT_SCENE_PARAMS, newPlan, type ScenePlan, type SceneOverride, type Rhythm } from "../../shared/scenes.js";
import { HttpError } from "../errors.js";
import * as v from "../validate.js";
import { writeJson } from "./projects.js";

export const SCENES_FILE = "scenes.json";
const MAX_OVERRIDES = 5000;

export interface ScenesFile {
  schemaVersion: 1;
  rev: number;
  updatedAtMs: number;
  plan: ScenePlan;
  /** Output picture shape of the layout; the export preset decides the final canvas, the preview uses this. */
  aspect: Aspect;
  background: Background;
}

export const emptyScenes = (): ScenesFile => ({ schemaVersion: 1, rev: 0, updatedAtMs: 0, plan: newPlan(), aspect: "16:9", background: DEFAULT_BACKGROUND });

export async function readScenes(dir: string): Promise<ScenesFile> {
  try {
    return JSON.parse(await readFile(path.join(dir, SCENES_FILE), "utf8")) as ScenesFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyScenes();
    throw error;
  }
}

const bad = (field: string): HttpError => new HttpError(400, "invalid_field", { field });
const oneOf = <T extends string>(value: unknown, list: readonly T[], field: string): T => {
  if (typeof value !== "string" || !(list as readonly string[]).includes(value)) throw bad(field);
  return value as T;
};
const FITS: readonly Fit[] = ["fill", "fit"];
const RHYTHMS: readonly Rhythm[] = ["calm", "balanced", "lively"];
const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "1:1"];

/** Validates the body of a scenes save; every field is checked, nothing is trusted. */
export function parseScenes(body: Record<string, unknown>): { plan: ScenePlan; aspect: Aspect; background: Background } {
  const plan = v.asObject(body.plan);
  const params = v.asObject(plan.params);
  const base = DEFAULT_SCENE_PARAMS;
  const range = (value: unknown, field: string, min: number, max: number): number => {
    const n = v.num(value, field);
    if (n < min || n > max) throw bad(field);
    return n;
  };
  const parsedParams: ScenePlan["params"] = {
    minDwellMs: range(params.minDwellMs ?? base.minDwellMs, "minDwellMs", 500, 60_000),
    hysteresisDb: range(params.hysteresisDb ?? base.hysteresisDb, "hysteresisDb", 0, 30),
    hangoverMs: range(params.hangoverMs ?? base.hangoverMs, "hangoverMs", 0, 10_000),
    rhythm: oneOf(params.rhythm ?? base.rhythm, RHYTHMS, "rhythm"),
    layout: oneOf(params.layout ?? base.layout, LAYOUT_IDS, "layout"),
    fallback: oneOf(params.fallback ?? base.fallback, ["wide", "keep"] as const, "fallback"),
    ...(params.fit === undefined ? {} : { fit: oneOf(params.fit, FITS, "fit") }),
    ...(params.screen === undefined ? {} : { screen: oneOf(params.screen, ["off"] as const, "screen") }),
  };
  const rawOverrides = plan.overrides ?? [];
  if (!Array.isArray(rawOverrides) || rawOverrides.length > MAX_OVERRIDES) throw bad("overrides");
  const overrides: SceneOverride[] = rawOverrides.map((item) => {
    const o = v.asObject(item);
    const s = v.num(o.s, "overrides");
    const e = v.num(o.e, "overrides");
    if (s < 0 || e <= s) throw bad("overrides");
    const sources = o.sources === undefined ? undefined : (Array.isArray(o.sources) && o.sources.length <= 8 ? o.sources.map((id) => v.id(id, "overrides")) : (() => { throw bad("overrides"); })());
    return { s, e, ...(o.layout === undefined ? {} : { layout: oneOf(o.layout, LAYOUT_IDS, "overrides") }), ...(sources === undefined ? {} : { sources }), ...(o.fit === undefined ? {} : { fit: oneOf(o.fit, FITS, "overrides") }) };
  });
  const aspect = oneOf(body.aspect ?? "16:9", ASPECTS, "aspect");
  const bg = body.background === undefined ? DEFAULT_BACKGROUND : v.asObject(body.background);
  let background: Background;
  if ((bg as Record<string, unknown>).kind === "blur") background = { kind: "blur", sigma: range((bg as Record<string, unknown>).sigma, "sigma", 0, 200) };
  else {
    const color = (bg as Record<string, unknown>).color;
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw bad("background");
    background = { kind: "color", color: color.toLowerCase() };
  }
  return { plan: { params: parsedParams, overrides }, aspect, background };
}

const writes = new Map<string, Promise<unknown>>();

export function saveScenes(dir: string, baseRev: number, next: { plan: ScenePlan; aspect: Aspect; background: Background }): Promise<ScenesFile> {
  const previous = writes.get(dir) ?? Promise.resolve();
  const work = previous.then(async () => {
    const current = await readScenes(dir);
    if (current.rev !== baseRev) throw new HttpError(409, "scenes_conflict", { rev: current.rev });
    const file: ScenesFile = { schemaVersion: 1, rev: current.rev + 1, updatedAtMs: Date.now(), ...next };
    await writeJson(path.join(dir, SCENES_FILE), file);
    return file;
  });
  writes.set(dir, work.catch(() => undefined));
  return work;
}
