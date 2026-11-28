import { readFile } from "node:fs/promises";
import path from "node:path";
import { boostLevels, boostsDb } from "../../shared/mic-balance.js";
import type { ProjectFile } from "../../shared/project.js";

export interface MicrophoneLevels {
  /** Level track of every source with audio, by source id, with its boost applied. */
  levels: Map<string, Int8Array>;
  /** Boost in dB of every source with audio (0 for a source that is loud enough, and for the sound of a screen). */
  boosts: Map<string, number>;
}

/** Reads the level tracks of the project and lifts the quiet microphones to the level of the loudest (`shared/mic-balance`). */
export async function microphoneLevels(project: ProjectFile, dir: string): Promise<MicrophoneLevels> {
  const sources = project.sources.filter((source) => source.audio !== null);
  const raw = await Promise.all(
    sources.map(async (source) => {
      const buffer = await readFile(path.join(dir, source.audio?.levels ?? ""));
      return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }),
  );
  const microphones = sources.flatMap((source, index) => (source.kind === "screen" ? [] : [index]));
  const found = boostsDb(microphones.map((index) => raw[index] as Int8Array));
  const levels = new Map<string, Int8Array>();
  const boosts = new Map<string, number>();
  sources.forEach((source, index) => {
    const boost = found[microphones.indexOf(index)] ?? 0;
    levels.set(source.id, boostLevels(raw[index] as Int8Array, boost));
    boosts.set(source.id, boost);
  });
  return { levels, boosts };
}

/** The ffmpeg filter that lifts a track by `boost` dB (floating point, so a large boost does not wrap). */
export const boostFilter = (boost: number): string => `volume=${boost}dB:precision=float`;
