// Drift of a recorded track: how many seconds of media the device produced per second of real time.

import type { ClockSample } from "./protocol.js";

/** Round trip the client reports when a handshake could not run. */
const UNKNOWN_RTT_MS = 1e9;

export interface DriftInput {
  startClientMs: number;
  endClientMs: number | null;
  mediaDurationSec: number;
  samples: ClockSample[];
}

export interface DriftOptions {
  /** Shortest recording whose drift is corrected; below this the measurement is dominated by start and stop jitter. */
  minSpanSec: number;
  /** Largest believable drift; beyond it the measurement is treated as a fault, not as drift. */
  maxPpm: number;
}

export const DEFAULT_DRIFT_OPTIONS: DriftOptions = { minSpanSec: 300, maxPpm: 1000 };

export interface DriftEstimate {
  /** Media seconds per timeline second. */
  rate: number;
  ppm: number;
  applied: boolean;
  note: string | null;
}

/**
 * Slope of the server clock against the client clock (ms per ms), from the handshake samples.
 * Only low round-trip samples are used: the lowest-latency ones carry the least asymmetry.
 */
export function clockSlope(samples: ClockSample[]): number {
  const usable = samples.filter((sample) => sample.rttMs >= 0 && sample.rttMs < UNKNOWN_RTT_MS);
  if (usable.length < 3) return 0;
  const minRtt = Math.min(...usable.map((sample) => sample.rttMs));
  const good = usable.filter((sample) => sample.rttMs <= 2 * minRtt + 5);
  if (good.length < 3) return 0;
  const first = Math.min(...good.map((sample) => sample.atClientMs));
  const last = Math.max(...good.map((sample) => sample.atClientMs));
  if (last - first < 120_000) return 0;
  const n = good.length;
  const meanX = good.reduce((sum, sample) => sum + (sample.atClientMs - first), 0) / n;
  const meanY = good.reduce((sum, sample) => sum + sample.offsetMs, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const sample of good) {
    const dx = sample.atClientMs - first - meanX;
    covariance += dx * (sample.offsetMs - meanY);
    variance += dx * dx;
  }
  return variance === 0 ? 0 : covariance / variance;
}

export function estimateDrift(input: DriftInput, options: DriftOptions = DEFAULT_DRIFT_OPTIONS): DriftEstimate {
  const none = (note: string): DriftEstimate => ({ rate: 1, ppm: 0, applied: false, note });
  if (input.endClientMs === null) return none("no end time (the track did not end cleanly), drift not corrected");
  const clientSpanMs = input.endClientMs - input.startClientMs;
  if (!(clientSpanMs > 0) || !(input.mediaDurationSec > 0)) return none("no usable duration, drift not corrected");
  const serverSpanSec = (clientSpanMs * (1 + clockSlope(input.samples))) / 1000;
  const rate = input.mediaDurationSec / serverSpanSec;
  const ppm = (rate - 1) * 1e6;
  if (serverSpanSec < options.minSpanSec) return { rate: 1, ppm, applied: false, note: `shorter than ${options.minSpanSec} s, drift not corrected` };
  if (Math.abs(ppm) > options.maxPpm) return { rate: 1, ppm, applied: false, note: `measured ${ppm.toFixed(0)} ppm exceeds ${options.maxPpm} ppm, treated as a fault and not corrected` };
  return { rate, ppm, applied: true, note: null };
}
