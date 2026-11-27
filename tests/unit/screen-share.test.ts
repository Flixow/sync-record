import { describe, expect, it } from "vitest";
import { displayCaptureOptions, screenControls, segmentNumber, takeContinues, type RecorderState } from "../../src/web/lib/screen-share.js";

const audio: RecorderState = { kind: "audio", active: true };
const camera: RecorderState = { kind: "camera", active: true };
const screen = (active: boolean): RecorderState => ({ kind: "screen", active });

describe("screen share controls during a take", () => {
  it("offers Share only while recording with no screen running, and Stop only while one runs", () => {
    expect(screenControls(false, [], false)).toEqual({ share: false, stop: false });
    expect(screenControls(true, [audio, camera], false)).toEqual({ share: true, stop: false });
    expect(screenControls(true, [audio, camera, screen(true)], false)).toEqual({ share: false, stop: true });
    // after Stop the same take can share again, as often as needed
    expect(screenControls(true, [audio, camera, screen(false)], false)).toEqual({ share: true, stop: false });
    expect(screenControls(true, [audio, screen(false), screen(false)], false)).toEqual({ share: true, stop: false });
    // a finished take offers neither, even if a recorder is still winding down
    expect(screenControls(false, [audio, screen(true)], false)).toEqual({ share: false, stop: false });
  });

  it("does not offer a second Share while the picker is open", () => {
    expect(screenControls(true, [audio], true)).toEqual({ share: false, stop: false });
  });

  it("keeps the take going when the screen stops and ends it only when nothing records any more", () => {
    expect(takeContinues([audio, camera, screen(false)])).toBe(true);
    expect(takeContinues([{ ...audio, active: false }, { ...camera, active: false }, screen(true)])).toBe(true);
    expect(takeContinues([{ ...audio, active: false }, screen(false)])).toBe(false);
    expect(takeContinues([])).toBe(false);
  });

  it("numbers the shares of a take among the screens only", () => {
    const first = screen(false);
    const second = screen(false);
    const list = [audio, camera, first, second];
    expect(segmentNumber(list, first)).toBe(1);
    expect(segmentNumber(list, second)).toBe(2);
    expect(segmentNumber(list, camera)).toBe(1);
  });

  it("asks the browser to leave out the in-bar window switch, so a new window is a new segment", () => {
    expect(displayCaptureOptions()).toMatchObject({ audio: false, surfaceSwitching: "exclude" });
  });
});
