import { describe, expect, it } from "vitest";
import { detectSilences, DEFAULT_SILENCE } from "../../src/shared/silence.js";

const FRAME = 20;
function track(totalMs: number, speech: [number, number][], quiet = -70, loud = -22): Int8Array {
  const levels = new Int8Array(totalMs / FRAME).fill(quiet);
  for (const [s, e] of speech) levels.fill(loud, s / FRAME, e / FRAME);
  return levels;
}

describe("silence detection", () => {
  it("finds silences of at least 700 ms between two speakers and leaves a short gap", () => {
    const a = track(20_000, [[1000, 4000], [9000, 12_000]]);
    const b = track(20_000, [[5000, 6000], [15_000, 16_000]]);
    const found = detectSilences([a, b], 20_000);
    // gaps: 0-1000 (leading), 4000-5000, 6000-9000, 12000-15000, 16000-20000 (trailing)
    expect(found.map((silence) => [silence.startMs, silence.endMs])).toEqual([[0, 1000], [4000, 5000], [6000, 9000], [12_000, 15_000], [16_000, 20_000]]);
    const middle = found[2];
    expect(middle?.cut).toEqual({ s: 6150, e: 8850 }); // 300 ms stay
    expect(found[0]?.cut).toEqual({ s: 0, e: 850 }); // leading silence: nothing to keep at the start
    expect(found[4]?.cut).toEqual({ s: 16_150, e: 20_000 });
  });

  it("ignores pauses shorter than the minimum and never cuts into speech", () => {
    const a = track(10_000, [[1000, 3000], [3500, 6000], [6600, 9000]]);
    expect(detectSilences([a], 10_000).map((silence) => silence.startMs)).toEqual([0, 9000]);
    for (const silence of detectSilences([a], 10_000)) {
      for (const [s, e] of [[1000, 3000], [3500, 6000], [6600, 9000]] as const) expect(silence.cut.e <= s || silence.cut.s >= e).toBe(true);
    }
  });

  it("does not count another microphone's bleed as speech", () => {
    const a = track(10_000, [[1000, 3000]]);
    const b = track(10_000, [], -70);
    b.fill(-46, 1000 / FRAME, 3000 / FRAME); // quiet copy of A, above the floor of B
    // B's own speech later, loud
    b.fill(-22, 6000 / FRAME, 7000 / FRAME);
    const found = detectSilences([a, b], 10_000, DEFAULT_SILENCE);
    expect(found.some((silence) => silence.startMs <= 3000 && silence.endMs >= 6000)).toBe(true);
  });
});
