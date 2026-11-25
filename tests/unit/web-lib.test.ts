import { describe, expect, it } from "vitest";
import { bestSample, computeSample } from "../../src/web/lib/clock.js";
import { analyseBleed, guessHeadphones, BLEED_THRESHOLD_DB } from "../../src/web/lib/headphones.js";
import { bytesPerSecond, formatBytes, formatDuration, minutesLeft, plannedBytes, storageLevel } from "../../src/web/lib/storage-math.js";

describe("clock handshake", () => {
  it("computes the NTP offset and round trip", () => {
    // client sends at 1000, server receives at 1510 and answers at 1512, client gets it at 1022.
    const sample = computeSample(1000, { serverRecvMs: 1510, serverSendMs: 1512 }, 1022);
    expect(sample.offsetMs).toBe(500); // server clock is 500 ms ahead
    expect(sample.rttMs).toBe(20);
  });

  it("trusts the sample with the smallest round trip", () => {
    const samples = [
      { atClientMs: 1, offsetMs: 90, rttMs: 80 },
      { atClientMs: 2, offsetMs: 101, rttMs: 6 },
      { atClientMs: 3, offsetMs: 120, rttMs: 40 },
    ];
    expect(bestSample(samples)?.offsetMs).toBe(101);
    expect(bestSample([])).toBeNull();
  });
});

describe("headphone guess", () => {
  it("is unknown while device labels are hidden", () => {
    expect(guessHeadphones([{ kind: "audioinput", label: "" }, { kind: "audiooutput", label: "" }]).guess).toBe("unknown");
  });

  it("recognises common headphone names, in English and Polish", () => {
    expect(guessHeadphones([{ kind: "audiooutput", label: "Default - AirPods Pro" }]).guess).toBe("likely");
    expect(guessHeadphones([{ kind: "audioinput", label: "Jabra Evolve 40 Headset" }]).guess).toBe("likely");
    expect(guessHeadphones([{ kind: "audiooutput", label: "Słuchawki (Realtek Audio)" }]).guess).toBe("likely");
  });

  it("only calls built-in speakers 'unlikely', never certain", () => {
    expect(guessHeadphones([{ kind: "audiooutput", label: "MacBook Pro Speakers" }, { kind: "audioinput", label: "MacBook Pro Microphone" }]).guess).toBe("unlikely");
    expect(guessHeadphones([{ kind: "audiooutput", label: "USB Audio Device" }]).guess).toBe("undetermined");
  });

  it("ignores cameras", () => {
    expect(guessHeadphones([{ kind: "videoinput", label: "Headset camera" }]).guess).toBe("unknown");
  });
});

describe("speaker bleed measurement", () => {
  it("flags a tone that rises clearly above the room noise", () => {
    expect(analyseBleed(-90, -60).verdict).toBe("bleed");
    expect(analyseBleed(-90, -90 + BLEED_THRESHOLD_DB).verdict).toBe("bleed");
  });

  it("keeps the numbers finite when the microphone is silent", () => {
    expect(analyseBleed(-Infinity, -40)).toEqual({ verdict: "bleed", riseDb: 80 });
    expect(analyseBleed(-Infinity, -Infinity)).toEqual({ verdict: "quiet", riseDb: 0 });
  });

  it("stays quiet when the tone is not picked up", () => {
    expect(analyseBleed(-90, -85)).toEqual({ verdict: "quiet", riseDb: 5 });
  });
});

describe("storage warning maths", () => {
  const all = ["audio", "camera", "screen"] as const;

  it("adds up the bitrate of the selected tracks", () => {
    expect(bytesPerSecond(["audio"])).toBe(16_000);
    expect(plannedBytes(["audio"], 2)).toBe(16_000 * 7200);
    expect(plannedBytes(all)).toBeGreaterThan(plannedBytes(["audio", "camera"]));
  });

  it("grades free space against the planned episode and never blocks", () => {
    const need = plannedBytes(all);
    expect(storageLevel(need * 2, all)).toBe("ok");
    expect(storageLevel(need * 0.9, all)).toBe("low");
    expect(storageLevel(100 * 1024 * 1024, all)).toBe("critical");
    expect(minutesLeft(bytesPerSecond(all) * 60 * 30, all)).toBe(30);
  });

  it("formats sizes and durations", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
