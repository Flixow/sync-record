import { readFileSync } from "node:fs";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const ASR_TIERS: readonly { model: string; minBytes: number }[] = [
  { model: "deepdml/faster-whisper-large-v3-turbo-ct2", minBytes: 3 * GIB },
  { model: "small", minBytes: 2 * GIB },
  { model: "base", minBytes: 600 * MIB },
];

type ReadText = (file: string) => string | null;

const readText: ReadText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Cgroup limits at or above this are "unlimited" (cgroup v1 reports a huge page-aligned number instead of "max"). */
const UNLIMITED = 2 ** 60;

export function memoryCapacityBytes(read: ReadText = readText): number | null {
  const limits: number[] = [];
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const value = Number(read(file)?.trim());
    if (Number.isFinite(value) && value > 0 && value < UNLIMITED) limits.push(value);
  }
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(read("/proc/meminfo") ?? "")?.[1];
  if (total) limits.push(Number(total) * 1024);
  return limits.length > 0 ? Math.min(...limits) : null;
}

export function modelsFittingIn(capacity: number | null): string[] {
  return ASR_TIERS.filter((tier) => capacity === null || capacity >= tier.minBytes).map((tier) => tier.model);
}

export const smallestTierBytes = (): number => ASR_TIERS[ASR_TIERS.length - 1]?.minBytes ?? 0;
