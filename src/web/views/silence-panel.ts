import { removeRanges, type Edl, type Range } from "../../shared/edl.js";
import type { Silence } from "../../shared/silence.js";
import { ApiError } from "../lib/api.js";
import { h, setChildren } from "../lib/dom.js";
import type { EditState } from "../lib/edit-state.js";
import type { ProjectApi } from "../lib/project-api.js";
import { formatClock, formatSeconds } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { banner } from "./layout.js";

const DEFAULT_MIN_SILENCE_MS = 700;
const DEFAULT_KEEP_MS = 300;

/** True when every millisecond of `range` is already removed (removed ranges are merged, so one of them must contain it). */
export function covered(removed: Range[], range: Range): boolean {
  return removed.some((item) => item.s <= range.s && item.e >= range.e);
}

/** Finds the pauses between speakers and lets the user review and cut them. */
export function silencePanel(api: ProjectApi, edit: EditState, previewCut: (cut: Range) => void): { el: HTMLElement; dispose: () => void } {
  const minInput = h("input", { type: "number", class: "input-number", min: 200, max: 60_000, step: 50, value: DEFAULT_MIN_SILENCE_MS, "data-testid": "pj-ed-si-min" });
  const keepInput = h("input", { type: "number", class: "input-number", min: 0, max: 5000, step: 50, value: DEFAULT_KEEP_MS, "data-testid": "pj-ed-si-keep" });
  const findButton = h("button", { type: "button", class: "btn", "data-testid": "pj-ed-si-find" }, t("pj.ed.si.find"));
  const message = h("div");
  const list = h("div", { "data-testid": "pj-ed-si-list" });
  const total = h("span", { class: "hint", "data-testid": "pj-ed-si-total" });
  const applyButton = h("button", { type: "button", class: "btn btn-primary btn-small", "data-testid": "pj-ed-si-apply" }, t("pj.ed.si.apply"));
  const allButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-si-all" }, t("pj.ed.si.all"));
  const noneButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-si-none" }, t("pj.ed.si.none"));
  const actions = h("div", { class: "row", hidden: true }, allButton, noneButton, applyButton, total);

  let silences: Silence[] = [];
  /** Silences the user unchecked; everything else that is not removed yet counts as selected. */
  const unchecked = new Set<number>();
  let disposed = false;
  /** The edit the list was last drawn for; save-status notifications of the edit state do not redraw it. */
  let shown: Edl | null = null;

  const selected = (): Silence[] => {
    const removed = edit.edl.removed;
    return silences.filter((silence, index) => !unchecked.has(index) && !covered(removed, silence.cut));
  };

  function summarize(): void {
    const chosen = selected();
    const saved = chosen.reduce((sum, silence) => sum + (silence.cut.e - silence.cut.s), 0);
    total.textContent = t("pj.ed.si.total", { count: chosen.length, time: formatSeconds(saved) });
    total.setAttribute("data-ms", String(saved));
    applyButton.disabled = chosen.length === 0;
  }

  function render(): void {
    const removed = edit.edl.removed;
    shown = edit.edl;
    actions.hidden = silences.length === 0;
    if (silences.length === 0) {
      setChildren(list);
      return;
    }
    const rows = silences.map((silence, index) => {
      const gone = covered(removed, silence.cut);
      const check = h("input", { type: "checkbox", "aria-label": t("pj.ed.si.select"), "data-testid": "pj-ed-si-check", checked: !gone && !unchecked.has(index), disabled: gone });
      check.addEventListener("change", () => {
        if (check.checked) unchecked.delete(index);
        else unchecked.add(index);
        summarize();
      });
      return h(
        "tr",
        { class: gone ? "removed" : undefined, "data-testid": "pj-ed-si-row", "data-state": gone ? "removed" : "open" },
        h("td", {}, check),
        h("td", { class: "num" }, formatClock(silence.startMs)),
        h("td", { class: "num" }, formatSeconds(silence.endMs - silence.startMs)),
        h("td", { class: "num" }, gone ? t("pj.ed.si.removed") : formatSeconds(silence.cut.e - silence.cut.s)),
        h("td", {}, h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-si-preview", onclick: () => previewCut(silence.cut) }, t("pj.ed.si.preview"))),
      );
    });
    setChildren(
      list,
      h(
        "table",
        { class: "data-table silences" },
        h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, t("pj.ed.si.start")), h("th", {}, t("pj.ed.si.length")), h("th", {}, t("pj.ed.si.cut")), h("th", {}, ""))),
        h("tbody", {}, ...rows),
      ),
    );
    summarize();
  }

  const number = (input: HTMLInputElement, fallback: number, min: number, max: number): number => {
    const value = Number(input.value);
    const clamped = input.value.trim() === "" || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.round(value)));
    input.value = String(clamped);
    return clamped;
  };

  async function find(): Promise<void> {
    findButton.disabled = true;
    setChildren(message);
    try {
      const report = await api.silences({ minSilenceMs: number(minInput, DEFAULT_MIN_SILENCE_MS, 200, 60_000), keepMs: number(keepInput, DEFAULT_KEEP_MS, 0, 5000) });
      if (disposed) return;
      silences = report.silences;
      unchecked.clear();
      if (silences.length === 0) setChildren(message, h("p", { class: "hint", "data-testid": "pj-ed-si-empty" }, t("pj.ed.si.empty")));
    } catch (error) {
      if (disposed) return;
      silences = [];
      const code = error instanceof ApiError ? error.code : "";
      setChildren(message, banner("error", code === "not_prepared" ? t("pj.ed.si.notPrepared") : t("err.generic", { message: code || (error instanceof Error ? error.message : "?") }), "pj-ed-si-error"));
    } finally {
      findButton.disabled = false;
    }
    render();
  }

  findButton.addEventListener("click", () => void find());
  allButton.addEventListener("click", () => {
    unchecked.clear();
    render();
  });
  noneButton.addEventListener("click", () => {
    silences.forEach((_, index) => unchecked.add(index));
    render();
  });
  applyButton.addEventListener("click", () => {
    const chosen = selected();
    if (chosen.length === 0) return;
    edit.apply(removeRanges(edit.edl, chosen.map((silence) => silence.cut), edit.durationMs));
  });
  const unsubscribe = edit.subscribe(() => {
    if (edit.edl !== shown) render();
  });

  const el = h(
    "div",
    { class: "stack", "data-testid": "pj-ed-silence" },
    h("h4", {}, t("pj.ed.si.title")),
    h("p", { class: "hint" }, t("pj.ed.si.hint")),
    h("div", { class: "row" }, h("label", { class: "field" }, t("pj.ed.si.min"), minInput), h("label", { class: "field" }, t("pj.ed.si.keep"), keepInput), findButton),
    message,
    list,
    actions,
  );
  return {
    el,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
