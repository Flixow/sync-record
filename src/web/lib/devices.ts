import { analyseBleed, type BleedVerdict } from "./headphones.js";
import { playTestTone, TEST_TONE_HZ } from "./audio.js";

export interface DeviceLists {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: all.filter((device) => device.kind === "audioinput"),
    cameras: all.filter((device) => device.kind === "videoinput"),
    outputs: all.filter((device) => device.kind === "audiooutput"),
  };
}

const exact = (deviceId: string | undefined): { deviceId?: { exact: string } } =>
  deviceId ? { deviceId: { exact: deviceId } } : {};

/** Raw microphone: processing is off on purpose, the recording is the master audio for post-production. */
export function openMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { ...exact(deviceId), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
}

export function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { ...exact(deviceId), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
}

/** Needs a user gesture: call it first inside the click handler that starts recording. */
export function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
}

export function onDeviceChange(listener: () => void): () => void {
  navigator.mediaDevices.addEventListener("devicechange", listener);
  return () => navigator.mediaDevices.removeEventListener("devicechange", listener);
}

export function streamSettings(stream: MediaStream): Record<string, number | string | boolean | null> {
  const track = stream.getTracks()[0];
  const settings = track?.getSettings() ?? {};
  const out: Record<string, number | string | boolean | null> = { label: track?.label ?? null };
  for (const key of ["sampleRate", "channelCount", "width", "height", "frameRate", "echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    const value = settings[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toneLevelDb(analyser: AnalyserNode, sampleRate: number): number {
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  const bin = Math.round(TEST_TONE_HZ / (sampleRate / analyser.fftSize));
  let peak = -Infinity;
  for (let i = bin - 2; i <= bin + 2; i += 1) peak = Math.max(peak, data[i] ?? -Infinity);
  return peak;
}

/**
 * Plays a quiet tone through the speakers and listens on the microphone. If the
 * tone shows up, sound from the speakers reaches the mic. A quiet result is
 * not proof of headphones (low volume stays quiet too).
 */
export async function measureBleed(mic: MediaStream): Promise<{ verdict: BleedVerdict; riseDb: number }> {
  const ctx = new AudioContext();
  try {
    const source = ctx.createMediaStreamSource(mic);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const sample = async (durationMs: number, reduce: "mean" | "max"): Promise<number> => {
      const values: number[] = [];
      const end = performance.now() + durationMs;
      while (performance.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        values.push(toneLevelDb(analyser, ctx.sampleRate));
      }
      return reduce === "max" ? Math.max(...values) : values.reduce((a, b) => a + b, 0) / values.length;
    };

    const baseline = await sample(600, "mean");
    const tone = playTestTone(1500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const during = await sample(900, "max");
    await tone;
    return analyseBleed(baseline, during);
  } finally {
    await ctx.close();
  }
}

/** Live input level 0..1 for the meter; returns a stop function. */
export function watchLevel(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
    onLevel(Math.min(1, peak / 100));
  }, 80);
  return () => {
    window.clearInterval(timer);
    void ctx.close();
  };
}
