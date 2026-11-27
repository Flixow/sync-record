import { ID_PATTERN, MARKER_KINDS, TRACK_KINDS, type ClockSample, type EndReason, type MarkerRecord, type TrackKind } from "../shared/protocol.js";
import { HttpError } from "./errors.js";

const bad = (field: string): HttpError => new HttpError(400, "invalid_field", { field });

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad("body");
  return value as Record<string, unknown>;
}

export function str(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== "string") throw bad(field);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw bad(field);
  return trimmed;
}

export function displayName(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw bad(field);
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length < 1 || cleaned.length > max) throw bad(field);
  return cleaned;
}

export function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad(field);
  return value;
}

export function nonNegativeInt(value: unknown, field: string): number {
  const n = num(value, field);
  if (!Number.isInteger(n) || n < 0) throw bad(field);
  return n;
}

export function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw bad(field);
  return value;
}

export function kind(value: unknown, field: string): TrackKind {
  if (typeof value !== "string" || !(TRACK_KINDS as readonly string[]).includes(value)) throw bad(field);
  return value as TrackKind;
}

const END_REASONS: readonly EndReason[] = ["stopped", "trackEnded", "sessionEnded", "crash", "forced", "error"];
export function endReason(value: unknown, field: string): EndReason {
  if (typeof value !== "string" || !(END_REASONS as readonly string[]).includes(value)) throw bad(field);
  return value as EndReason;
}

export function clockSamples(value: unknown, field: string): ClockSample[] {
  if (!Array.isArray(value) || value.length > 500) throw bad(field);
  return value.map((item) => {
    const o = asObject(item);
    return { atClientMs: num(o.atClientMs, field), offsetMs: num(o.offsetMs, field), rttMs: num(o.rttMs, field) };
  });
}

export function markers(value: unknown, field: string): MarkerRecord[] {
  if (!Array.isArray(value) || value.length > 200) throw bad(field);
  return value.map((item) => {
    const o = asObject(item);
    const markerKind = o.kind;
    if (typeof markerKind !== "string" || !(MARKER_KINDS as readonly string[]).includes(markerKind)) throw bad(field);
    return {
      id: str(o.id, field, 64),
      kind: markerKind as MarkerRecord["kind"],
      atClientMs: num(o.atClientMs, field),
      outputLatencyMs: o.outputLatencyMs === null ? null : num(o.outputLatencyMs, field),
    };
  });
}

export function settings(value: unknown, field: string): Record<string, number | string | boolean | null> {
  const o = asObject(value);
  const entries = Object.entries(o);
  if (entries.length > 32) throw bad(field);
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, item] of entries) {
    if (key.length > 64) throw bad(field);
    if (item === null || typeof item === "number" || typeof item === "boolean") out[key] = item;
    else if (typeof item === "string" && item.length <= 256) out[key] = item;
    else throw bad(field);
  }
  return out;
}
