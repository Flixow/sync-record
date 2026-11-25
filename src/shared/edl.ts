// The edit decision list: which parts of the project timeline are removed. Everything else is kept, in order.
// Pure functions over immutable values, so every operation can be undone by keeping the previous value.

export interface Range {
  /** ms on the project timeline; start < end. */
  s: number;
  e: number;
}

export interface Edl {
  /** Removed ranges: sorted, non-overlapping and never touching (adjacent ones are merged). */
  removed: Range[];
}

export const EMPTY_EDL: Edl = { removed: [] };

/** Sorts, clips to [0, limit] (when given), drops empty ranges and merges overlapping or touching ones. */
export function normalize(ranges: Range[], limit?: number): Range[] {
  const clipped = ranges
    .map((range) => ({ s: Math.max(0, Math.round(range.s)), e: limit === undefined ? Math.round(range.e) : Math.min(limit, Math.round(range.e)) }))
    .filter((range) => range.e > range.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Range[] = [];
  for (const range of clipped) {
    const last = out[out.length - 1];
    if (last && range.s <= last.e) last.e = Math.max(last.e, range.e);
    else out.push({ ...range });
  }
  return out;
}

/** Ranges of [from, to] not covered by `taken` (which must be normalized). */
export function complement(taken: Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  let cursor = from;
  for (const range of taken) {
    if (range.e <= cursor) continue;
    if (range.s >= to) break;
    if (range.s > cursor) out.push({ s: cursor, e: Math.min(range.s, to) });
    cursor = Math.max(cursor, range.e);
  }
  if (cursor < to) out.push({ s: cursor, e: to });
  return out;
}

export function removeRange(edl: Edl, range: Range, duration: number): Edl {
  return { removed: normalize([...edl.removed, range], duration) };
}

export function removeRanges(edl: Edl, ranges: Range[], duration: number): Edl {
  return { removed: normalize([...edl.removed, ...ranges], duration) };
}

/** Puts back whatever of `range` was removed. */
export function restoreRange(edl: Edl, range: Range): Edl {
  const out: Range[] = [];
  for (const removed of edl.removed) {
    if (removed.e <= range.s || removed.s >= range.e) {
      out.push(removed);
      continue;
    }
    if (removed.s < range.s) out.push({ s: removed.s, e: range.s });
    if (removed.e > range.e) out.push({ s: range.e, e: removed.e });
  }
  return { removed: normalize(out) };
}

/** Removes everything except the given ranges. */
export function keepOnly(ranges: Range[], duration: number): Edl {
  return { removed: complement(normalize(ranges, duration), 0, duration) };
}

export function keptRanges(edl: Edl, duration: number): Range[] {
  return complement(edl.removed, 0, duration);
}

export function keptDuration(edl: Edl, duration: number): number {
  return keptRanges(edl, duration).reduce((sum, range) => sum + (range.e - range.s), 0);
}

export function isRemoved(edl: Edl, ms: number): boolean {
  return findRemoved(edl, ms) !== null;
}

/** The removed range containing `ms` (start inclusive, end exclusive), or null. */
export function findRemoved(edl: Edl, ms: number): Range | null {
  let low = 0;
  let high = edl.removed.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = edl.removed[mid] as Range;
    if (ms < range.s) high = mid - 1;
    else if (ms >= range.e) low = mid + 1;
    else return range;
  }
  return null;
}

/** Position on the edited timeline of a source time; a removed time maps to where the cut lands. */
export function toOutput(edl: Edl, ms: number): number {
  let removedBefore = 0;
  for (const range of edl.removed) {
    if (range.e <= ms) removedBefore += range.e - range.s;
    else {
      if (range.s < ms) removedBefore += ms - range.s;
      break;
    }
  }
  return ms - removedBefore;
}

/** Source time of a position on the edited timeline. */
export function toSource(edl: Edl, outputMs: number): number {
  let removedBefore = 0;
  for (const range of edl.removed) {
    if (range.s - removedBefore > outputMs) break;
    removedBefore += range.e - range.s;
  }
  return outputMs + removedBefore;
}

/** The range of words [first, last] (inclusive indexes into a time-ordered word list) as the span to remove: from the end of the word before to the start of the word after, so the cut sits in the gaps. */
export function wordSpanRange(words: { s: number; e: number }[], first: number, last: number, duration: number): Range {
  const before = words[first - 1];
  const after = words[last + 1];
  const start = words[first]?.s ?? 0;
  const end = words[last]?.e ?? 0;
  // the cut goes through the middle of the pause on each side, so neither neighbour loses its onset or tail
  const s = before ? Math.min(start, Math.round((before.e + start) / 2)) : start;
  const e = after ? Math.max(end, Math.round((end + after.s) / 2)) : Math.min(duration, end);
  return { s, e };
}

// ---- history -----------------------------------------------------------------------------------------------------------

export interface History {
  past: Edl[];
  present: Edl;
  future: Edl[];
}

export const newHistory = (present: Edl = EMPTY_EDL): History => ({ past: [], present, future: [] });

/** Makes `next` the present value. A no-op change is not recorded. */
export function commit(history: History, next: Edl): History {
  if (sameEdl(history.present, next)) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}

export function sameEdl(a: Edl, b: Edl): boolean {
  return a.removed.length === b.removed.length && a.removed.every((range, index) => range.s === b.removed[index]?.s && range.e === b.removed[index]?.e);
}
