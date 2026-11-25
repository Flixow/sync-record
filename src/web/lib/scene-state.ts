import type { Aspect, Background, LayoutSource } from "../../shared/layout.js";
import {
  addOverride,
  applyOverrides,
  clearOverrides,
  commitPlan,
  newPlanHistory,
  redoPlan,
  removeOverrideAt,
  samePlan,
  setParams,
  undoPlan,
  type PlanHistory,
  type Scene,
  type SceneOverride,
  type SceneParams,
  type ScenePlan,
} from "../../shared/scenes.js";
import { Autosave, type SaveStatus } from "./autosave.js";
import type { ScenesBackend, ScenesBody, ScenesFile } from "./project-api.js";

export const sameBackground = (a: Background, b: Background): boolean =>
  a.kind === "color" ? b.kind === "color" && a.color === b.color : b.kind === "blur" && a.sigma === b.sigma;

/**
 * The layout of one project in the browser: the scene plan with its own undo history, the picture shape and the
 * background, the scenes they resolve to and the saving. The server resolves the automatic scenes from the microphone
 * levels, so those arrive with every save; a manual override is shown at once by laying it over the scenes on screen.
 */
export class SceneState {
  private history: PlanHistory;
  private shown: Scene[];
  private shape: Aspect;
  private backdrop: Background;
  private saved: ScenesBody;
  private revision: number;
  /** The pictures the layouts can show, as the server lists them. */
  readonly sources: LayoutSource[];

  /** The scenes a plan resolved to, for the plans the server has seen: undo and redo land on them without a request. */
  private readonly known = new WeakMap<ScenePlan, Scene[]>();
  private readonly listeners = new Set<() => void>();
  private readonly autosave: Autosave;

  constructor(
    private readonly backend: ScenesBackend,
    initial: ScenesFile,
  ) {
    this.history = newPlanHistory(initial.plan);
    this.shown = initial.scenes;
    this.shape = initial.aspect;
    this.backdrop = initial.background;
    this.saved = { plan: initial.plan, aspect: initial.aspect, background: initial.background };
    this.revision = initial.rev;
    this.sources = initial.sources;
    this.known.set(initial.plan, initial.scenes);
    this.autosave = new Autosave(
      {
        isSaved: () => samePlan(this.history.present, this.saved.plan) && this.shape === this.saved.aspect && sameBackground(this.backdrop, this.saved.background),
        store: async () => {
          const sent: ScenesBody = { plan: this.history.present, aspect: this.shape, background: this.backdrop };
          const file = await this.backend.saveScenes(this.revision, sent);
          this.revision = file.rev;
          this.saved = sent;
          this.known.set(sent.plan, file.scenes);
          // what was sent may already be outdated; its scenes then only wait in `known` for an undo
          if (this.history.present === sent.plan) this.shown = file.scenes;
        },
        // the server's layout wins; the local history, built on a stale one, is dropped
        reload: async () => {
          const file = await this.backend.scenes();
          this.history = newPlanHistory(file.plan);
          this.shown = file.scenes;
          this.shape = file.aspect;
          this.backdrop = file.background;
          this.saved = { plan: file.plan, aspect: file.aspect, background: file.background };
          this.revision = file.rev;
          this.known.set(file.plan, file.scenes);
        },
      },
      () => this.emit(),
    );
  }

  get plan(): ScenePlan {
    return this.history.present;
  }

  get aspect(): Aspect {
    return this.shape;
  }

  get background(): Background {
    return this.backdrop;
  }

  /** Scenes on the project timeline (the automatic ones with the overrides on top). */
  get scenes(): Scene[] {
    return this.shown;
  }

  get rev(): number {
    return this.revision;
  }

  get status(): SaveStatus {
    return this.autosave.status;
  }

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

  /** Changes parameters of the automatic plan; the new scenes arrive with the save. */
  setParams(patch: Partial<SceneParams>): void {
    this.move(commitPlan(this.history, setParams(this.history.present, patch)));
  }

  /** Drops the manual changes that touch the range [s, e), in one history step. */
  resetRange(s: number, e: number): void {
    const plan = this.history.present;
    const overrides = plan.overrides.filter((override) => !(override.s < e && override.e > s));
    if (overrides.length === plan.overrides.length) return;
    this.move(commitPlan(this.history, { params: plan.params, overrides }));
  }

  /** Puts a manual change over the scenes for a range of the timeline. */
  addOverride(override: SceneOverride): void {
    const next = commitPlan(this.history, addOverride(this.history.present, override));
    this.move(next, applyOverrides(this.shown, [override]));
  }

  removeOverrideAt(index: number): void {
    this.move(commitPlan(this.history, removeOverrideAt(this.history.present, index)));
  }

  clearOverrides(): void {
    this.move(commitPlan(this.history, clearOverrides(this.history.present)));
  }

  /** The shape of the picture and the background are settings, not plan edits: they are saved but not part of the undo history. */
  setAspect(aspect: Aspect): void {
    if (aspect === this.shape) return;
    this.shape = aspect;
    this.autosave.changed();
  }

  setBackground(background: Background): void {
    if (sameBackground(background, this.backdrop)) return;
    this.backdrop = background;
    this.autosave.changed();
  }

  undo(): void {
    this.move(undoPlan(this.history));
  }

  redo(): void {
    this.move(redoPlan(this.history));
  }

  flush(): Promise<void> {
    return this.autosave.flush();
  }

  /** Last chance while the page is being left: one request that may outlive it. */
  saveOnLeave(): void {
    if (this.autosave.busy || this.autosave.status === "saved") return;
    this.autosave.cancelTimer();
    void this.backend.saveScenes(this.revision, { plan: this.history.present, aspect: this.shape, background: this.backdrop }, true).catch(() => undefined);
  }

  dispose(): void {
    this.autosave.dispose();
    this.listeners.clear();
  }

  private move(history: PlanHistory, optimistic?: Scene[]): void {
    if (history === this.history) return;
    this.history = history;
    const scenes = this.known.get(history.present) ?? optimistic;
    if (scenes) this.shown = scenes;
    this.autosave.changed();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
