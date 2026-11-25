import { describe, expect, it } from "vitest";
import { chunkTimeToTrack, detectSpeech, packChunks, speechFrames } from "../../src/shared/vad.js";

const frames = (parts: [number, number][], total: number, quiet = -60): Int8Array => {
  const levels = new Int8Array(total).fill(quiet);
  for (const [from, to] of parts) levels.fill(-25, from, to);
  return levels;
};

describe("voice activity", () => {
  it("finds speech above the noise floor, bridges short gaps and pads the ends", () => {
    // 2 s speech, 300 ms gap (bridged), 1 s speech, then silence; 20 ms frames
    const levels = frames([[50, 150], [165, 215]], 400);
    const segments = detectSpeech(levels);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startMs).toBe(1000 - 150);
    expect(segments[0]?.endMs).toBe(4300 + 150);
  });

  it("ignores blips shorter than the minimum and silence", () => {
    expect(detectSpeech(frames([[10, 14]], 100))).toEqual([]);
    expect(detectSpeech(new Int8Array(500).fill(-100))).toEqual([]);
  });

  it("treats a frame as bleed when another track is clearly louder", () => {
    const mine = new Int8Array(100).fill(-60);
    mine.fill(-40, 20, 60); // quiet copy of the other speaker
    const other = new Int8Array(100).fill(-60);
    other.fill(-22, 20, 60);
    expect(speechFrames(mine).reduce((a, b) => a + b, 0)).toBe(40); // without the test it counts as speech
    expect(detectSpeech(mine, undefined, [other])).toEqual([]);
    mine.fill(-20, 30, 50); // the owner really speaks over the other one
    expect(detectSpeech(mine, undefined, [other]).length).toBeGreaterThan(0);
  });

  it("splits a very long segment at a quiet frame", () => {
    const levels = frames([[0, 3000]], 6000);
    levels[1100] = -80; // a dip near 22 s
    const segments = detectSpeech(levels, { ...{ marginDb: 12, minLevelDb: -50, floorPercentile: 10, bridgeMs: 500, minMs: 250, padMs: 0, maxSegmentMs: 25_000, dominanceDb: null } });
    expect(segments.length).toBe(3);
    expect(segments[0]?.endMs).toBe(1100 * 20);
    for (const segment of segments) expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(25_000);
  });
});

describe("chunk packing", () => {
  it("packs segments up to the limit with silence between them and maps times back", () => {
    const chunks = packChunks([{ startMs: 1000, endMs: 11_000 }, { startMs: 20_000, endMs: 30_000 }, { startMs: 40_000, endMs: 50_000 }], 28_000, 600);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.parts.map((part) => part.atMs)).toEqual([0, 10_600]);
    expect(chunks[1]?.parts).toEqual([{ startMs: 40_000, endMs: 50_000, atMs: 0 }]);
    const first = chunks[0];
    if (!first) throw new Error("chunk missing");
    expect(chunkTimeToTrack(first, 500)).toBe(1500);
    expect(chunkTimeToTrack(first, 10_600 + 2000)).toBe(22_000);
    expect(chunkTimeToTrack(first, 10_100)).toBe(11_000); // in the pad: clamps to the end of the previous part
  });
});
