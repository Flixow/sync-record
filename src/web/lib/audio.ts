import { clientNowMs } from "./clock.js";

export interface BeepInfo {
  /** Client clock instant at which the tone was scheduled to start, in ms. */
  atClientMs: number;
  outputLatencyMs: number | null;
}

let context: AudioContext | null = null;

function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

/** Call from a click handler so the browser lets audio play later (host beeps, tests). */
export async function unlockAudio(): Promise<void> {
  const ctx = audioContext();
  if (ctx.state !== "running") await ctx.resume();
}

/**
 * Plays a short two-tone beep through the speakers at the given client clock
 * instant (or now). With headphones it is not heard by the microphone, which is
 * why the UI also asks for a clap.
 */
export function playBeep(atClientMs?: number): BeepInfo {
  const ctx = audioContext();
  const delaySec = Math.max(0, ((atClientMs ?? clientNowMs()) - clientNowMs()) / 1000);
  const startAt = ctx.currentTime + delaySec;
  for (const [offset, frequency] of [[0, 1000], [0.18, 1500]] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, startAt + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt + offset);
    osc.stop(startAt + offset + 0.16);
  }
  const latency = typeof ctx.outputLatency === "number" ? ctx.outputLatency * 1000 : null;
  return { atClientMs: atClientMs ?? clientNowMs(), outputLatencyMs: latency };
}

/** Plays a quiet 1 kHz tone for the bleed test and returns when it ends. */
export async function playTestTone(durationMs: number): Promise<void> {
  const ctx = audioContext();
  await unlockAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 1000;
  gain.gain.value = 0.25;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  osc.stop();
}

export const TEST_TONE_HZ = 1000;
