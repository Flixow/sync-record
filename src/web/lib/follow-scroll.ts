/** Playback stopped for longer than this and started again counts as a new start: the view follows the words again. */
export const RESUME_AFTER_PAUSE_MS = 2000;
/** Where the followed word is put, as a share of the visible height measured from the top (a third of the way down). */
export const FOLLOW_ANCHOR = 1 / 3;
/** A followed word that stays inside this band of the visible height (top share, bottom share) is left where it is. */
export const FOLLOW_BAND = { top: 0.08, bottom: 0.55 } as const;

/** What the scroll container looks like: its scroll position and sizes, plus the strips on top and bottom that other elements cover. */
export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Height of the sticky header drawn over the top of the visible area. */
  topInset: number;
  /** Height of whatever is drawn over the bottom of the visible area. */
  bottomInset: number;
}

/** The part of the container the user can actually see. */
function visibleHeight(box: ScrollBox): number {
  return Math.max(1, box.clientHeight - box.topInset - box.bottomInset);
}

/**
 * The `scrollTop` that puts the middle of a word (`wordTop`, `wordHeight`: its place in the scrolled content, in px) at
 * `anchor` of the visible height, within the limits of the container. `null` when the container is already there.
 */
export function scrollTopFor(box: ScrollBox, wordTop: number, wordHeight: number, anchor: number): number | null {
  const wanted = wordTop + wordHeight / 2 - box.topInset - anchor * visibleHeight(box);
  const limit = Math.max(0, box.scrollHeight - box.clientHeight);
  const target = Math.round(Math.min(limit, Math.max(0, wanted)));
  return Math.abs(target - box.scrollTop) < 1 ? null : target;
}

/**
 * The `scrollTop` that keeps the word being played in view, or `null` when it is comfortably in view already. Inside the
 * band the view stays still, so it moves in steps of a few lines and not at every line break; outside it the word is put
 * a third of the way down.
 */
export function followTarget(box: ScrollBox, wordTop: number, wordHeight: number): number | null {
  const height = visibleHeight(box);
  const top = wordTop - box.scrollTop - box.topInset;
  if (top >= FOLLOW_BAND.top * height && top + wordHeight <= FOLLOW_BAND.bottom * height) return null;
  return scrollTopFor(box, wordTop, wordHeight, FOLLOW_ANCHOR);
}

/**
 * Whether the transcript column scrolls by itself. The user's own scrolling switches it off and playing from a clicked
 * place or from the timeline, the button or a fresh start after a pause (> RESUME_AFTER_PAUSE_MS) switches it on again.
 * Time comes in as an argument, so the rules are testable without a clock.
 */
export class FollowState {
  private following = true;
  /** When playback last stopped; null while it plays. */
  private stoppedAt: number | null;

  constructor(now: number) {
    this.stoppedAt = now;
  }

  /** True while the column should keep the playing word in view. */
  get active(): boolean {
    return this.following;
  }

  /** The user scrolled the column by wheel, touch, keys or its scrollbar. */
  userScrolled(): void {
    this.following = false;
  }

  /** The user asked for it, or moved the playhead somewhere. */
  resume(): void {
    this.following = true;
  }

  /** Playback started. */
  played(now: number): void {
    if (this.stoppedAt !== null && now - this.stoppedAt > RESUME_AFTER_PAUSE_MS) this.following = true;
    this.stoppedAt = null;
  }

  /** Playback stopped. */
  paused(now: number): void {
    this.stoppedAt ??= now;
  }
}
