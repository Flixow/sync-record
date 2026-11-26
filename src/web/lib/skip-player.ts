import { findRemoved, type Edl, type Range } from "../../shared/edl.js";

/** How far ahead of the playhead a removed range is looked for. Seeking takes a moment, so the jump starts a little early. */
export const LOOKAHEAD_MS = 12;
/** A cut preview plays this long before the cut and after it. */
export const PREVIEW_PAD_MS = 1500;

/** A jump lands this far past the end of a removed range, so rounding of the media clock cannot leave the playhead inside it. */
const LANDING_MS = 1;

/** The first removed range that ends after `ms` and starts no later than `ms + aheadMs`, or null. */
export function nextRemoved(edl: Edl, ms: number, aheadMs: number): Range | null {
  const list = edl.removed;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((list[mid] as Range).e > ms) high = mid;
    else low = mid + 1;
  }
  const range = list[low];
  return range && range.s <= ms + aheadMs ? range : null;
}

export interface SkipPlayer {
  /** Moves the playhead to `ms`; a position inside a removed range lands after it. */
  seek(ms: number): void;
  /** Plays PREVIEW_PAD_MS before `range`, jumps over it (and only it) and plays PREVIEW_PAD_MS after it, then pauses. */
  previewCut(range: Range): void;
  dispose(): void;
}

/**
 * Makes an audio element play an edit: the removed ranges of `getEdl()` are jumped over, both while playing (a check
 * on every animation frame, with a small look-ahead, plus the media events as a fallback for a hidden tab) and when
 * the user seeks into one.
 */
export function attachSkipPlayer(audio: HTMLAudioElement, getEdl: () => Edl): SkipPlayer {
  let override: Edl | null = null;
  let stopAtMs = Infinity;
  let frame = 0;

  const endPreview = (): void => {
    override = null;
    stopAtMs = Infinity;
  };

  const skip = (): void => {
    const ms = audio.currentTime * 1000;
    if (ms >= stopAtMs) {
      audio.pause();
      return;
    }
    const range = nextRemoved(override ?? getEdl(), ms, audio.paused ? 0 : LOOKAHEAD_MS);
    if (!range) return;
    // A range that reaches the end of the audio leaves nothing to play: stop there.
    if (!Number.isFinite(audio.duration) || range.e / 1000 >= audio.duration - 0.02) {
      audio.pause();
      return;
    }
    audio.currentTime = (range.e + LANDING_MS) / 1000;
  };

  const tick = (): void => {
    frame = 0;
    skip();
    if (!audio.paused && !audio.ended) frame = requestAnimationFrame(tick);
  };
  const start = (): void => {
    if (frame === 0) frame = requestAnimationFrame(tick);
  };
  const stop = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const paused = (): void => {
    stop();
    endPreview();
  };

  audio.addEventListener("playing", start);
  audio.addEventListener("play", start);
  audio.addEventListener("pause", paused);
  audio.addEventListener("ended", paused);
  audio.addEventListener("timeupdate", skip);
  audio.addEventListener("seeked", skip);
  if (!audio.paused) start();

  return {
    seek(ms) {
      const removed = findRemoved(override ?? getEdl(), ms);
      audio.currentTime = Math.max(0, removed ? (removed.e + LANDING_MS) / 1000 : ms / 1000);
    },
    previewCut(range) {
      override = { removed: [range] };
      stopAtMs = range.e + PREVIEW_PAD_MS;
      audio.currentTime = Math.max(0, range.s - PREVIEW_PAD_MS) / 1000;
      void audio.play().catch(() => endPreview());
    },
    dispose() {
      stop();
      audio.removeEventListener("playing", start);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", paused);
      audio.removeEventListener("ended", paused);
      audio.removeEventListener("timeupdate", skip);
      audio.removeEventListener("seeked", skip);
    },
  };
}
