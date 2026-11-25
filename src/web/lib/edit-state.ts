import { commit, newHistory, redo, sameEdl, undo, type Edl, type History } from "../../shared/edl.js";
import { Autosave, type SaveStatus } from "./autosave.js";
import type { EdlBackend, EdlFile } from "./project-api.js";

export { RETRY_DELAY_MS, SAVE_DELAY_MS, type SaveStatus } from "./autosave.js";

/**
 * The edit of one project in the browser: the undo history, the revision it was last saved at and the saving itself.
 * Components read `edl` and listen with `subscribe`; they change it with `apply`, `undo` and `redo`.
 */
export class EditState {
  private history: History;
  private saved: Edl;
  private revision: number;
  private readonly listeners = new Set<() => void>();
  private readonly autosave: Autosave;

  constructor(
    private readonly backend: EdlBackend,
    /** Length of the project timeline in ms; cuts are clipped to it. */
    readonly durationMs: number,
    initial: EdlFile,
  ) {
    this.history = newHistory({ removed: initial.removed });
    this.saved = this.history.present;
    this.revision = initial.rev;
    this.autosave = new Autosave(
      {
        isSaved: () => sameEdl(this.history.present, this.saved),
        store: async () => {
          const sent = this.history.present;
          const file = await this.backend.saveEdl(this.revision, sent.removed);
          this.revision = file.rev;
          this.saved = sent;
        },
        // the server's edit wins; the local history, built on a stale one, is dropped
        reload: async () => {
          const file = await this.backend.edl();
          this.history = newHistory({ removed: file.removed });
          this.saved = this.history.present;
          this.revision = file.rev;
        },
      },
      () => this.emit(),
    );
  }

  get edl(): Edl {
    return this.history.present;
  }

  /** Revision of the saved file this state was last in step with. */
  get rev(): number {
    return this.revision;
  }

  get status(): SaveStatus {
    return this.autosave.status;
  }

  /** True after the server's edit replaced the local one (someone saved another version meanwhile); cleared by the next change. */
  get conflict(): boolean {
    return this.autosave.conflict;
  }

  get canUndo(): boolean {
    return this.history.past.length > 0;
  }

  get canRedo(): boolean {
    return this.history.future.length > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Makes `next` the edit; an unchanged value is not recorded. */
  apply(next: Edl): void {
    this.move(commit(this.history, next));
  }

  undo(): void {
    this.move(undo(this.history));
  }

  redo(): void {
    this.move(redo(this.history));
  }

  /** Saves now when there is something unsaved; resolves when nothing is left to save (or the save failed). */
  flush(): Promise<void> {
    return this.autosave.flush();
  }

  /** Last chance while the page is being left: one request that may outlive it. */
  saveOnLeave(): void {
    if (this.autosave.busy || sameEdl(this.history.present, this.saved)) return;
    this.autosave.cancelTimer();
    void this.backend.saveEdl(this.revision, this.history.present.removed, true).catch(() => undefined);
  }

  /** Saves what is pending and stops the timers; the listeners stay registered by their owners. */
  dispose(): void {
    this.autosave.dispose();
    this.listeners.clear();
  }

  private move(history: History): void {
    if (history === this.history) return;
    this.history = history;
    this.autosave.changed();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
