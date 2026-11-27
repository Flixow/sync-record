// Pure helpers for the storage warning. Bitrates mirror the recorder settings.

import type { TrackKind } from "../../shared/protocol.js";
import { formatNumber } from "./number.js";

export const BITRATE_BPS: Record<TrackKind, number> = {
  audio: 128_000,
  camera: 2_500_000,
  screen: 3_000_000,
};

/** The episode length the setup check plans for. Recording itself has no limit. */
export const PLANNED_HOURS = 2;

export type StorageLevel = "ok" | "low" | "critical";

export function bytesPerSecond(kinds: readonly TrackKind[]): number {
  return kinds.reduce((sum, kind) => sum + BITRATE_BPS[kind] / 8, 0);
}

export function plannedBytes(kinds: readonly TrackKind[], hours = PLANNED_HOURS): number {
  return bytesPerSecond(kinds) * hours * 3600;
}

export function minutesLeft(freeBytes: number, kinds: readonly TrackKind[]): number {
  const rate = bytesPerSecond(kinds);
  return rate > 0 ? Math.floor(freeBytes / rate / 60) : Infinity;
}

const CRITICAL_BYTES = 500 * 1024 * 1024;

/**
 * "critical": less than 500 MB or 10 minutes left; "low": less than the planned
 * episode (plus 10 % headroom); otherwise "ok". Never a reason to block recording.
 */
export function storageLevel(freeBytes: number, kinds: readonly TrackKind[]): StorageLevel {
  if (freeBytes < CRITICAL_BYTES || minutesLeft(freeBytes, kinds) < 10) return "critical";
  if (freeBytes < plannedBytes(kinds) * 1.1) return "low";
  return "ok";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
