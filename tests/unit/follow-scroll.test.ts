import { describe, expect, it } from "vitest";
import { FollowState, followTarget, RESUME_AFTER_PAUSE_MS, scrollTopFor, type ScrollBox } from "../../src/web/lib/follow-scroll.js";

/** A 600 px tall column with a 100 px sticky header, holding 5000 px of content. */
const box = (scrollTop: number, overrides: Partial<ScrollBox> = {}): ScrollBox => ({ scrollTop, clientHeight: 600, scrollHeight: 5000, topInset: 100, bottomInset: 0, ...overrides });

describe("followTarget", () => {
  it("leaves the view alone while the word is inside the comfortable band", () => {
    // visible area is 500 px; the band is 8% to 55% of it: 40 px to 275 px below the header
    expect(followTarget(box(1000), 1000 + 100 + 100, 24)).toBeNull();
    expect(followTarget(box(1000), 1000 + 100 + 40, 24)).toBeNull();
  });

  it("moves a word that went below the band to a third of the way down", () => {
    const target = followTarget(box(1000), 1000 + 100 + 400, 24);
    // the word's middle (at 512 px into the content below the header) goes to 500 / 3 px below the header
    expect(target).toBe(Math.round(1000 + 400 + 100 + 12 - 100 - 500 / 3));
  });

  it("moves a word that is above the visible part", () => {
    const target = followTarget(box(1000), 700, 24);
    expect(target).not.toBeNull();
    expect(target as number).toBeLessThan(700);
  });

  it("does not move a word that sits behind the sticky header", () => {
    // the header covers the first 100 px: a word 50 px into the viewport is hidden and must be brought down
    expect(followTarget(box(1000), 1050, 24)).not.toBeNull();
  });

  it("stays inside the content at both ends", () => {
    expect(followTarget(box(300), 120, 24)).toBe(0);
    expect(followTarget(box(3900), 4990, 24)).toBe(4400);
  });

  it("counts a strip covered at the bottom as not visible", () => {
    const covered = box(1000, { bottomInset: 200 });
    // the visible area is 300 px; the band ends at 165 px, so a word 200 px below the header is out of it
    expect(followTarget(covered, 1000 + 100 + 200, 24)).not.toBeNull();
    expect(followTarget(box(1000), 1000 + 100 + 200, 24)).toBeNull();
  });
});

describe("scrollTopFor", () => {
  it("centres a word in the visible part", () => {
    // visible area 500 px starting 100 px below the top: its middle is at 350 px
    expect(scrollTopFor(box(0), 2000, 20, 0.5)).toBe(2000 + 10 - 100 - 250);
  });

  it("is null when the container is already there", () => {
    expect(scrollTopFor(box(1660), 2000, 20, 0.5)).toBeNull();
  });
});

describe("FollowState", () => {
  it("follows from the start", () => {
    expect(new FollowState(0).active).toBe(true);
  });

  it("stops at the user's scrolling and resumes on request", () => {
    const follow = new FollowState(0);
    follow.played(10_000);
    follow.userScrolled();
    expect(follow.active).toBe(false);
    follow.resume();
    expect(follow.active).toBe(true);
  });

  it("resumes when playback starts after a pause longer than the limit", () => {
    const follow = new FollowState(0);
    follow.played(0);
    follow.userScrolled();
    follow.paused(5000);
    follow.played(5000 + RESUME_AFTER_PAUSE_MS + 1);
    expect(follow.active).toBe(true);
  });

  it("stays stopped when playback starts again within the limit", () => {
    const follow = new FollowState(0);
    follow.played(0);
    follow.userScrolled();
    follow.paused(5000);
    follow.played(5000 + RESUME_AFTER_PAUSE_MS);
    expect(follow.active).toBe(false);
  });

  it("measures the pause from its first moment, not from repeated events", () => {
    const follow = new FollowState(0);
    follow.played(0);
    follow.userScrolled();
    follow.paused(5000);
    follow.paused(6900);
    follow.played(7100);
    expect(follow.active).toBe(true);
  });

  it("resumes at the first play after the page sat idle for a while", () => {
    const follow = new FollowState(0);
    follow.userScrolled();
    follow.played(60_000);
    expect(follow.active).toBe(true);
  });
});
