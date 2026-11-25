import { ApiError } from "./api.js";

/** A change is saved this long after the last one, so a burst of edits makes one request. */
export const SAVE_DELAY_MS = 400;
/** A failed save is tried again after this long. */
export const RETRY_DELAY_MS = 3000;

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

/** What the saving machine needs of the value it keeps in step with the server. */
export interface SaveTarget {
  /** True when the server holds what is shown. */
  isSaved(): boolean;
  /** Stores what is shown against the revision this copy is based on; resolves once the server has it. */
  store(): Promise<void>;
  /** After a conflict: replaces what is shown, the history included, with the server's version. */
  reload(): Promise<void>;
}

/** The server answers a save made from a stale revision with 409 and a `*_conflict` code. */
const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409 && error.code.endsWith("_conflict");

/**
 * Debounced, revision-checked saving of one value: the same machine for the cut list and the scene plan. The owner calls
 * `changed()` after every local change; this class stores it after a short quiet period, once at a time, again when more
 * changed meanwhile, and stops at a conflict (the server's version wins) or a failure (retried later).
 */
export class Autosave {
  status: SaveStatus = "saved";
  /** True after the server's version replaced the local one; cleared by the next change. */
  conflict = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly target: SaveTarget,
    /** Called whenever `status` or `conflict` changes. */
    private readonly emit: () => void,
  ) {}

  /** True while a request is in flight. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** The value changed locally: schedule a save, or settle at "saved" when it is back at what the server has. */
  changed(): void {
    this.conflict = false;
    this.status = this.target.isSaved() ? "saved" : "dirty";
    clearTimeout(this.timer);
    if (this.status === "dirty") this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
    this.emit();
  }

  /** Saves now when there is something unsaved; resolves when nothing is left to save (or the save failed). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    return this.save();
  }

  /** Stops the retry timer without saving (the page is being left and the owner sends its own last request). */
  cancelTimer(): void {
    clearTimeout(this.timer);
  }

  /** Saves what is pending and stops the timers. */
  dispose(): void {
    clearTimeout(this.timer);
    if (!this.disposed && !this.target.isSaved()) void this.save();
    this.disposed = true;
  }

  private save(): Promise<void> {
    if (this.running) return this.running;
    // `finally` runs after `running` is assigned, also when there is nothing to save and `drain` ends at once
    const run = this.drain().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  /** Saves until what is stored is what is shown; stops at a conflict or a failure. */
  private async drain(): Promise<void> {
    while (!this.target.isSaved()) {
      this.status = "saving";
      this.emit();
      try {
        await this.target.store();
      } catch (error) {
        if (isConflict(error)) await this.recover();
        else this.fail();
        return;
      }
    }
    this.status = "saved";
    this.emit();
  }

  private async recover(): Promise<void> {
    try {
      await this.target.reload();
      this.conflict = true;
      this.status = "saved";
      this.emit();
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.status = "error";
    this.emit();
    if (!this.disposed) this.timer = setTimeout(() => void this.save(), RETRY_DELAY_MS);
  }
}
