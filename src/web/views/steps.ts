import { h } from "../lib/dom.js";
import { t, type MessageKey } from "../i18n/index.js";

/** The steps of the project page, in the order of the work. */
export const STEP_IDS = ["prepare", "episode", "shorts", "cover", "details"] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Where a step stands: finished, being worked on right now, or not started. */
export type StepMark = "done" | "working" | "todo";

const LABEL: Record<StepId, MessageKey> = {
  prepare: "flow.step.prepare",
  episode: "flow.step.episode",
  shorts: "flow.step.shorts",
  cover: "flow.step.cover",
  details: "flow.step.details",
};
const MARK_TEXT: Record<StepMark, MessageKey> = { done: "flow.mark.done", working: "flow.mark.working", todo: "flow.mark.todo" };
/** The details step is a place to look things up, not a piece of work: it has no state. */
const HAS_MARK = (id: StepId): boolean => id !== "details";

export const isStepId = (value: string | null): value is StepId => STEP_IDS.some((id) => id === value);

export interface StepTabs {
  /** The tab list. */
  bar: HTMLElement;
  /** Holds the panels of all steps; only the selected one is shown. */
  panels: HTMLElement;
  /** The panel of one step. Hidden panels stay in the page, so what they hold keeps running. */
  panel(id: StepId): HTMLElement;
  current(): StepId;
  /** Shows a step (the page's own choice: `onSelect` is not called). `focus` also moves the keyboard focus to its tab. */
  select(id: StepId, focus?: boolean): void;
  setMark(id: StepId, mark: StepMark): void;
}

/**
 * An accessible tab bar: a tablist with a number, a label and a state mark per tab, arrow keys, Home and End. The tab of
 * a step is `data-testid=pj-step-<id>` and its panel `pj-panel-<id>`. `onSelect` is called when the user picks a step.
 */
export function stepTabs(initial: StepId, onSelect: (id: StepId) => void): StepTabs {
  let selected = initial;
  const tabs = new Map<StepId, HTMLButtonElement>();
  const marks = new Map<StepId, HTMLElement>();
  const markTexts = new Map<StepId, HTMLElement>();
  const panels = new Map<StepId, HTMLElement>();

  STEP_IDS.forEach((id, index) => {
    const mark = h("span", { class: "ws-mark", "data-mark": "todo", "aria-hidden": "true" });
    const markText = h("span", { class: "sr-only" });
    marks.set(id, mark);
    markTexts.set(id, markText);
    const tab = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `pj-tab-${id}`,
        class: "ws-tab",
        "aria-controls": `pj-panel-${id}`,
        "aria-selected": "false",
        tabindex: "-1",
        "data-testid": `pj-step-${id}`,
        onclick: () => choose(id),
      },
      h("span", { class: "ws-tab-num", "aria-hidden": "true" }, String(index + 1)),
      h("span", { class: "ws-tab-label" }, t(LABEL[id])),
      HAS_MARK(id) ? mark : null,
      HAS_MARK(id) ? markText : null,
    );
    tabs.set(id, tab);
    panels.set(id, h("div", { role: "tabpanel", id: `pj-panel-${id}`, class: "ws-panel stack", "aria-labelledby": `pj-tab-${id}`, hidden: true, "data-testid": `pj-panel-${id}` }));
  });

  const bar = h("div", { class: "ws-tabs", role: "tablist", "aria-label": t("flow.steps.label") }, ...tabs.values());
  const container = h("div", { class: "stack" }, ...panels.values());

  function show(): void {
    for (const [id, tab] of tabs) {
      const on = id === selected;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      (panels.get(id) as HTMLElement).hidden = !on;
    }
  }

  function select(id: StepId, focus = false): void {
    selected = id;
    show();
    if (focus) tabs.get(id)?.focus();
  }

  /** A step picked by the user, with the mouse or the keys. */
  function choose(id: StepId, focus = false): void {
    if (id === selected && !focus) return;
    select(id, focus);
    onSelect(id);
  }

  function setMark(id: StepId, mark: StepMark): void {
    if (!HAS_MARK(id)) return;
    marks.get(id)?.setAttribute("data-mark", mark);
    tabs.get(id)?.setAttribute("data-mark", mark);
    const text = markTexts.get(id);
    if (text) text.textContent = `, ${t(MARK_TEXT[mark])}`;
  }

  bar.addEventListener("keydown", (event) => {
    const at = STEP_IDS.indexOf(selected);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? STEP_IDS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    choose(STEP_IDS[(next + STEP_IDS.length) % STEP_IDS.length] as StepId, true);
  });

  for (const id of STEP_IDS) setMark(id, "todo");
  show();

  return { bar, panels: container, panel: (id) => panels.get(id) as HTMLElement, current: () => selected, select, setMark };
}
