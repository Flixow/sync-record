/** `m:ss.t` (or `h:mm:ss.t`) for a position or length in ms; the tenth of a second matters when cutting. */
export function formatClock(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const head = hours > 0 ? `${hours}:${pad(minutes)}` : pad(minutes);
  return `${head}:${pad(seconds)}.${tenths % 10}`;
}

/** Length in seconds with one decimal, e.g. "1.4 s". */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}
