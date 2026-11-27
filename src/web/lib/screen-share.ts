// Screen sharing while a take is running. A share is one screen recorder (one segment: screen.webm, screen-2.webm, ...);
// stopping it never ends the take, the microphone and camera keep recording. Pure rules, so the room and the tests agree.

import type { TrackKind } from "../../shared/protocol.js";

/** What the rules need to know about a recorder. */
export interface RecorderState {
  kind: TrackKind;
  active: boolean;
}

export interface ScreenControls {
  /** "Share screen" may be pressed: a take is running and no screen is being recorded. */
  share: boolean;
  /** "Stop sharing" may be pressed: a screen is being recorded. */
  stop: boolean;
}

/** `busy` is true while the picker is open or a share is starting. */
export function screenControls(recording: boolean, recorders: readonly RecorderState[], busy: boolean): ScreenControls {
  const sharing = recorders.some((recorder) => recorder.kind === "screen" && recorder.active);
  return { share: recording && !busy && !sharing, stop: recording && sharing };
}

/** The take is over only when no recorder of any kind is left running; a stopped screen alone does not end it. */
export const takeContinues = (recorders: readonly RecorderState[]): boolean => recorders.some((recorder) => recorder.active);

/**
 * Options of the screen picker. "exclude" removes the browser's "share this tab instead" switch from the sharing bar, so
 * a change of window is a Stop and a new Share: a new, visible segment (the recording of one share cannot change what it
 * shows without leaving a trace). Browsers that do not know the option ignore it.
 */
export function displayCaptureOptions(): DisplayMediaStreamOptions {
  return { video: { frameRate: { ideal: 30 } }, audio: false, surfaceSwitching: "exclude" } as DisplayMediaStreamOptions;
}

/** Position (1-based) of a recorder among the recorders of its kind in this take: "Screen 2" is the second share. */
export function segmentNumber<T extends { kind: TrackKind }>(recorders: readonly T[], recorder: T): number {
  return recorders.filter((item) => item.kind === recorder.kind).indexOf(recorder) + 1;
}
