import type { ClockResponse, ClockSample } from "../../shared/protocol.js";

/** The client clock used for every timestamp: ms since the epoch, with sub-ms precision. */
export const clientNowMs = (): number => performance.timeOrigin + performance.now();

/** NTP style offset of one exchange: serverTime - clientTime. */
export function computeSample(t0: number, response: ClockResponse, t3: number): ClockSample {
  const offsetMs = (response.serverRecvMs - t0 + (response.serverSendMs - t3)) / 2;
  const rttMs = t3 - t0 - (response.serverSendMs - response.serverRecvMs);
  return { atClientMs: t3, offsetMs, rttMs };
}

/** The sample with the smallest round trip is the most trustworthy one. */
export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (best === null || sample.rttMs < best.rttMs) best = sample;
  }
  return best;
}

export class ClockSync {
  readonly samples: ClockSample[] = [];
  private timer: number | null = null;

  constructor(private readonly fetchClock: () => Promise<ClockResponse>) {}

  async sampleOnce(): Promise<ClockSample> {
    const t0 = clientNowMs();
    const response = await this.fetchClock();
    const sample = computeSample(t0, response, clientNowMs());
    this.samples.push(sample);
    return sample;
  }

  /** Takes several samples in a row; the best of them is the handshake result. */
  async handshake(count = 8): Promise<ClockSample> {
    for (let i = 0; i < count; i += 1) await this.sampleOnce();
    return this.best();
  }

  /** Best sample of the most recent 20, so the estimate follows slow drift. */
  best(): ClockSample {
    const best = bestSample(this.samples.slice(-20));
    if (!best) throw new Error("clock handshake has not run");
    return best;
  }

  hasSamples(): boolean {
    return this.samples.length > 0;
  }

  startPeriodic(everyMs = 60_000): void {
    this.stopPeriodic();
    this.timer = window.setInterval(() => {
      void this.sampleOnce().catch(() => undefined);
    }, everyMs);
  }

  stopPeriodic(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Samples taken since `sinceMs` (client clock). */
  since(sinceMs: number): ClockSample[] {
    return this.samples.filter((sample) => sample.atClientMs >= sinceMs);
  }
}
