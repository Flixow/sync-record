import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Range } from "../../src/shared/edl.js";
import { removeRange } from "../../src/shared/edl.js";
import { ApiError } from "../../src/web/lib/api.js";
import { EditState, RETRY_DELAY_MS, SAVE_DELAY_MS } from "../../src/web/lib/edit-state.js";
import type { EdlBackend, EdlFile } from "../../src/web/lib/project-api.js";
import { nextRemoved } from "../../src/web/lib/skip-player.js";
import { combinePeaks, peakColumns } from "../../src/web/views/timeline.js";

const file = (rev: number, removed: Range[] = []): EdlFile => ({ schemaVersion: 1, rev, updatedAtMs: 0, removed });

/** A server in memory: it checks the base revision like the real one. */
function fakeBackend(initial: EdlFile) {
  let stored = initial;
  const calls: { baseRev: number; removed: Range[] }[] = [];
  const failures: unknown[] = [];
  const backend: EdlBackend = {
    edl: async () => stored,
    saveEdl: async (baseRev, removed) => {
      calls.push({ baseRev, removed });
      const failure = failures.shift();
      if (failure) throw failure;
      if (baseRev !== stored.rev) throw new ApiError(409, "edl_conflict", { rev: stored.rev });
      stored = file(stored.rev + 1, removed);
      return stored;
    },
  };
  return { backend, calls, failures, set: (next: EdlFile) => (stored = next) };
}

describe("edit state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves a burst of changes once, after the delay, against the revision it started from", async () => {
    const server = fakeBackend(file(3));
    const edit = new EditState(server.backend, 60_000, file(3));
    edit.apply(removeRange(edit.edl, { s: 1000, e: 2000 }, 60_000));
    edit.apply(removeRange(edit.edl, { s: 5000, e: 6000 }, 60_000));
    expect(edit.status).toBe("dirty");
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toEqual([{ baseRev: 3, removed: [{ s: 1000, e: 2000 }, { s: 5000, e: 6000 }] }]);
    expect(edit.status).toBe("saved");
    expect(edit.rev).toBe(4);
  });

  it("still saves after a flush that had nothing to save", async () => {
    const server = fakeBackend(file(0));
    const edit = new EditState(server.backend, 60_000, file(0));
    await edit.flush();
    edit.apply(removeRange(edit.edl, { s: 0, e: 1000 }, 60_000));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    expect(edit.status).toBe("saved");
  });

  it("undo and redo are changes of their own; undoing back to the saved edit needs no request", async () => {
    const server = fakeBackend(file(0));
    const edit = new EditState(server.backend, 60_000, file(0));
    edit.apply(removeRange(edit.edl, { s: 1000, e: 2000 }, 60_000));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    edit.undo();
    expect(edit.edl.removed).toEqual([]);
    expect(edit.canRedo).toBe(true);
    edit.redo();
    expect(edit.status).toBe("saved"); // back at what the server has
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(1);
    edit.undo();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual({ baseRev: 1, removed: [] });
  });

  it("takes the server's edit and drops the local history when the revision is stale", async () => {
    const server = fakeBackend(file(0));
    const edit = new EditState(server.backend, 60_000, file(0));
    server.set(file(5, [{ s: 100, e: 900 }]));
    const seen: boolean[] = [];
    edit.subscribe(() => seen.push(edit.conflict));
    edit.apply(removeRange(edit.edl, { s: 1000, e: 2000 }, 60_000));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(edit.edl.removed).toEqual([{ s: 100, e: 900 }]);
    expect(edit.rev).toBe(5);
    expect(edit.conflict).toBe(true);
    expect(edit.canUndo).toBe(false);
    expect(edit.status).toBe("saved");
    expect(seen).toContain(true);
    edit.apply(removeRange(edit.edl, { s: 3000, e: 4000 }, 60_000));
    expect(edit.conflict).toBe(false);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(server.calls.at(-1)?.baseRev).toBe(5);
  });

  it("tries a failed save again", async () => {
    const server = fakeBackend(file(0));
    server.failures.push(new TypeError("network down"));
    const edit = new EditState(server.backend, 60_000, file(0));
    edit.apply(removeRange(edit.edl, { s: 1000, e: 2000 }, 60_000));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(edit.status).toBe("error");
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 10);
    expect(edit.status).toBe("saved");
    expect(server.calls).toHaveLength(2);
  });

  it("keeps a change made while a save is on its way and sends it next", async () => {
    const server = fakeBackend(file(0));
    const release: (() => void)[] = [];
    const slow: EdlBackend = {
      edl: server.backend.edl,
      saveEdl: async (baseRev, removed) => {
        await new Promise<void>((resolve) => release.push(resolve));
        return server.backend.saveEdl(baseRev, removed);
      },
    };
    const edit = new EditState(slow, 60_000, file(0));
    edit.apply(removeRange(edit.edl, { s: 1000, e: 2000 }, 60_000));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(edit.status).toBe("saving");
    edit.apply(removeRange(edit.edl, { s: 5000, e: 6000 }, 60_000));
    release.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    release.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(server.calls.map((call) => call.baseRev)).toEqual([0, 1]);
    expect(edit.status).toBe("saved");
    expect(edit.rev).toBe(2);
  });
});

describe("playback skipping and the timeline data", () => {
  const edl = { removed: [{ s: 1000, e: 2000 }, { s: 5000, e: 5500 }] };

  it("finds the removed range the playhead is in or about to enter", () => {
    expect(nextRemoved(edl, 500, 12)).toBeNull();
    expect(nextRemoved(edl, 990, 12)).toEqual({ s: 1000, e: 2000 });
    expect(nextRemoved(edl, 1500, 0)).toEqual({ s: 1000, e: 2000 });
    expect(nextRemoved(edl, 2000, 12)).toBeNull(); // the end of a range is not inside it
    expect(nextRemoved(edl, 4995, 12)).toEqual({ s: 5000, e: 5500 });
    expect(nextRemoved(edl, 6000, 12)).toBeNull();
    expect(nextRemoved({ removed: [] }, 0, 12)).toBeNull();
  });

  it("takes the largest peak per column, one pass over the array", () => {
    const peaks = Uint8Array.from([1, 9, 2, 3, 7, 4, 5, 6]); // 80 ms at 10 ms per peak
    expect(Array.from(peakColumns(peaks, 80, 4))).toEqual([9, 3, 7, 6]);
    expect(Array.from(peakColumns(peaks, 80, 8))).toEqual([1, 9, 2, 3, 7, 4, 5, 6]);
    // a recording longer than the peaks: the columns past the end stay empty
    expect(Array.from(peakColumns(peaks, 160, 4))).toEqual([9, 7, 0, 0]);
    expect(Array.from(peakColumns(new Uint8Array(0), 80, 3))).toEqual([0, 0, 0]);
  });

  it("combines tracks by the loudest value at every instant", () => {
    expect(Array.from(combinePeaks([Uint8Array.from([1, 5, 2]), Uint8Array.from([4, 3, 9, 7])]))).toEqual([4, 5, 9, 7]);
    expect(combinePeaks([]).length).toBe(0);
  });
});
