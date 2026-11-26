import { describe, expect, it } from "vitest";
import { commit, EMPTY_EDL, findRemoved, keepOnly, keptDuration, keptRanges, newHistory, normalize, redo, removeRange, restoreRange, sameEdl, toOutput, toSource, undo, wordSpanRange, type Edl, type Range } from "../../src/shared/edl.js";

const DURATION = 60_000;

/** Small deterministic generator so a failing sequence can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomRange(next: () => number): Range {
  const s = Math.floor(next() * DURATION);
  return { s, e: s + 1 + Math.floor(next() * 8000) };
}

const total = (ranges: Range[]): number => ranges.reduce((sum, range) => sum + (range.e - range.s), 0);

describe("edit decision list: properties", () => {
  it("keeps the kept duration equal to the sum of the kept ranges, whatever was removed", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      let edl: Edl = EMPTY_EDL;
      for (let step = 0; step < 25; step++) {
        const range = randomRange(next);
        edl = next() < 0.7 ? removeRange(edl, range, DURATION) : restoreRange(edl, range);
        const kept = keptRanges(edl, DURATION);
        expect(keptDuration(edl, DURATION), `seed ${seed} step ${step}`).toBe(total(kept));
        expect(total(kept) + total(edl.removed)).toBe(DURATION);
        // normalized: sorted, separated by a kept gap, inside the timeline
        edl.removed.forEach((range, index) => {
          expect(range.e).toBeGreaterThan(range.s);
          expect(range.s).toBeGreaterThanOrEqual(0);
          expect(range.e).toBeLessThanOrEqual(DURATION);
          if (index > 0) expect(range.s).toBeGreaterThan((edl.removed[index - 1] as Range).e);
        });
      }
    }
  });

  it("undoes and redoes every operation exactly", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed * 7);
      let history = newHistory();
      const states: Edl[] = [history.present];
      for (let step = 0; step < 20; step++) {
        const range = randomRange(next);
        const choice = next();
        const edl = choice < 0.5 ? removeRange(history.present, range, DURATION) : choice < 0.8 ? restoreRange(history.present, range) : keepOnly([range, randomRange(next)], DURATION);
        const after = commit(history, edl);
        if (after !== history) states.push(edl);
        history = after;
      }
      for (let index = states.length - 2; index >= 0; index--) {
        history = undo(history);
        expect(sameEdl(history.present, states[index] as Edl), `seed ${seed} undo to ${index}`).toBe(true);
      }
      for (let index = 1; index < states.length; index++) {
        history = redo(history);
        expect(sameEdl(history.present, states[index] as Edl), `seed ${seed} redo to ${index}`).toBe(true);
      }
    }
  });

  it("removing a range and restoring it leaves the list as it was when the range lay inside kept time", () => {
    const base = removeRange(removeRange(EMPTY_EDL, { s: 1000, e: 2000 }, DURATION), { s: 9000, e: 9500 }, DURATION);
    const range = { s: 4000, e: 6000 };
    expect(sameEdl(restoreRange(removeRange(base, range, DURATION), range), base)).toBe(true);
  });

  it("maps source time to edited time and back", () => {
    const edl = removeRange(removeRange(EMPTY_EDL, { s: 1000, e: 3000 }, DURATION), { s: 10_000, e: 10_500 }, DURATION);
    expect(toOutput(edl, 500)).toBe(500);
    expect(toOutput(edl, 3000)).toBe(1000);
    expect(toOutput(edl, 2000)).toBe(1000); // inside a cut: where the cut lands
    expect(toOutput(edl, 20_000)).toBe(20_000 - 2000 - 500);
    for (let output = 0; output < keptDuration(edl, DURATION); output += 997) {
      expect(toOutput(edl, toSource(edl, output))).toBe(output);
      expect(findRemoved(edl, toSource(edl, output))).toBeNull();
    }
  });

  it("keeps only the chosen ranges", () => {
    const edl = keepOnly([{ s: 5000, e: 8000 }, { s: 7000, e: 9000 }, { s: 20_000, e: 21_000 }], DURATION);
    expect(keptRanges(edl, DURATION)).toEqual([{ s: 5000, e: 9000 }, { s: 20_000, e: 21_000 }]);
    expect(keptDuration(edl, DURATION)).toBe(5000);
  });

  it("merges touching ranges and clips to the timeline", () => {
    expect(normalize([{ s: 100, e: 200 }, { s: 200, e: 300 }, { s: -50, e: 10 }, { s: 70_000, e: 80_000 }], DURATION)).toEqual([{ s: 0, e: 10 }, { s: 100, e: 300 }]);
  });
});

describe("removing a span of words", () => {
  const words = [{ s: 1000, e: 1400 }, { s: 1600, e: 2000 }, { s: 2100, e: 2500 }, { s: 3500, e: 3900 }];
  it("cuts through the middle of the pauses around the span", () => {
    expect(wordSpanRange(words, 1, 2, DURATION)).toEqual({ s: 1500, e: 3000 });
  });
  it("uses the word edges at the ends of the transcript", () => {
    expect(wordSpanRange(words, 0, 0, DURATION)).toEqual({ s: 1000, e: 1500 });
    expect(wordSpanRange(words, 3, 3, DURATION)).toEqual({ s: 3000, e: 3900 });
  });
});
