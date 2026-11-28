import { LAYOUT_IDS, type Aspect, type Background, type Fit, type LayoutId } from "../../shared/layout.js";
import type { ProjectFile } from "../../shared/project.js";
import { REASON_TEXT } from "../../shared/clips.js";
import type { Span } from "../../shared/scene-plan.js";
import type { Rhythm, Scene } from "../../shared/scenes.js";
import { h, setChildren } from "../lib/dom.js";
import { historyKey } from "../lib/keys.js";
import { ApiError } from "../lib/api.js";
import type { ProjectApi, ProjectState } from "../lib/project-api.js";
import type { SceneState } from "../lib/scene-state.js";
import { formatClock } from "../lib/time.js";
import { getLang, t, type MessageKey } from "../i18n/index.js";
import { banner } from "./layout.js";
import { layoutPreview } from "./layout-preview.js";
import { sceneSources } from "./scene-sources.js";
import type { Stage } from "./stage.js";

const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "1:1"];
const ASPECT_LABEL: Record<Aspect, MessageKey> = { "16:9": "pj.lay.aspect.wide", "9:16": "pj.lay.aspect.vertical", "1:1": "pj.lay.aspect.square" };
const RHYTHMS: readonly Rhythm[] = ["calm", "balanced", "lively"];
const FALLBACKS = ["keep", "wide"] as const;
const FITS: readonly ("auto" | Fit)[] = ["auto", "fill", "fit"];
const DEFAULT_BLUR_SIGMA = 40;
const DEFAULT_COLOR = "#0d0f12";
const MIN_DWELL_MS = 500;
const MAX_DWELL_MS = 60_000;

export interface LayoutPanel {
  el: HTMLElement;
  dispose(): void;
}

/** Index of the scene that holds `ms` (the last one starting at or before it). */
function sceneIndexAt(scenes: Scene[], ms: number): number {
  let low = 0;
  let high = scenes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((scenes[mid] as Scene).s <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

const option = (value: string, label: string, selected: boolean): HTMLOptionElement => h("option", { value, selected }, label);

/**
 * The layout of the program: buttons for the layout, the shape of the picture, the background and the rhythm of the
 * automatic scenes, a list of the scenes with a manual override per scene, and the live preview that goes into the
 * player above. The scene plan has its own undo history and its own save, like the cut list.
 */
export function layoutPanel(api: ProjectApi, stg: Stage, project: ProjectFile, state: SceneState, settings: ProjectState["settings"]): LayoutPanel {
  // ---- the preview, above the player ---------------------------------------------------------------------------------
  const sources = sceneSources(api, project, state.sources);
  const preview = layoutPreview(stg, sources, { scenes: state.scenes, aspect: state.aspect, background: state.background });
  const previewLabel = h("p", { class: "hint", "data-testid": "pj-lay-preview-label" }, t("pj.lay.preview"));
  stg.previewSlot.replaceChildren(previewLabel, preview.el);
  const stopFollowing = stg.onTick((ms) => {
    preview.tick(ms);
    markNow(ms);
  });
  const hookOn = new URLSearchParams(location.search).get("hooks") === "1";
  const hook = { seekMs: (ms: number) => preview.seekMs(ms), canvasSelector: "[data-testid=pj-lay-canvas]" };
  if (hookOn) window.__syncPreview = hook;

  // ---- controls ---------------------------------------------------------------------------------------------------------
  const pressed = (button: HTMLElement, on: boolean): void => button.setAttribute("aria-pressed", String(on));
  const layoutButtons = new Map<LayoutId, HTMLButtonElement>(
    LAYOUT_IDS.map((id) => [id, h("button", { type: "button", class: "btn btn-small toggle", "data-testid": `pj-lay-layout-${id}`, onclick: () => state.setParams({ layout: id }) }, t(`pj.lay.layout.${id}`))]),
  );
  const aspectButtons = new Map<Aspect, HTMLButtonElement>(
    ASPECTS.map((aspect) => [aspect, h("button", { type: "button", class: "btn btn-small toggle", "data-testid": `pj-lay-aspect-${aspect}`, onclick: () => state.setAspect(aspect) }, t(ASPECT_LABEL[aspect]))]),
  );
  const fitSelect = h(
    "select",
    { "data-testid": "pj-lay-fit", "aria-label": t("pj.lay.fit"), onchange: () => state.setParams({ fit: fitSelect.value === "auto" ? undefined : (fitSelect.value as Fit) }) },
    ...FITS.map((fit) => option(fit, t(`pj.lay.fit.${fit}`), false)),
  );

  let lastColor = state.background.kind === "color" ? state.background.color : DEFAULT_COLOR;
  let lastSigma = state.background.kind === "blur" ? state.background.sigma : DEFAULT_BLUR_SIGMA;
  const kindSelect = h(
    "select",
    {
      "data-testid": "pj-lay-bg-kind",
      "aria-label": t("pj.lay.bg"),
      onchange: () => state.setBackground(kindSelect.value === "blur" ? { kind: "blur", sigma: lastSigma } : { kind: "color", color: lastColor }),
    },
    option("color", t("pj.lay.bg.color"), false),
    option("blur", t("pj.lay.bg.blur"), false),
  );
  const colorInput = h("input", {
    type: "color",
    "data-testid": "pj-lay-bg-color",
    "aria-label": t("pj.lay.bg.color"),
    oninput: () => {
      lastColor = colorInput.value;
      state.setBackground({ kind: "color", color: lastColor });
    },
  });
  const sigmaInput = h("input", {
    type: "range",
    min: 0,
    max: 200,
    step: 1,
    "data-testid": "pj-lay-bg-sigma",
    "aria-label": t("pj.lay.bg.sigma"),
    oninput: () => {
      lastSigma = Number(sigmaInput.value);
      state.setBackground({ kind: "blur", sigma: lastSigma });
    },
  });
  const rhythmSelect = h(
    "select",
    { "data-testid": "pj-lay-rhythm", "aria-label": t("pj.lay.rhythm"), onchange: () => state.setParams({ rhythm: rhythmSelect.value as Rhythm }) },
    ...RHYTHMS.map((rhythm) => option(rhythm, t(`pj.lay.rhythm.${rhythm}`), false)),
  );
  const dwellInput = h("input", {
    type: "number",
    class: "input-number",
    min: MIN_DWELL_MS / 1000,
    max: MAX_DWELL_MS / 1000,
    step: 0.5,
    "data-testid": "pj-lay-dwell",
    "aria-label": t("pj.lay.dwell"),
    onchange: () => {
      const seconds = Number(dwellInput.value);
      if (Number.isFinite(seconds)) state.setParams({ minDwellMs: Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, Math.round(seconds * 10) * 100)) });
      else dwellInput.value = String(state.plan.params.minDwellMs / 1000);
    },
  });
  const fallbackSelect = h(
    "select",
    { "data-testid": "pj-lay-fallback", "aria-label": t("pj.lay.fallback"), onchange: () => state.setParams({ fallback: fallbackSelect.value === "wide" ? "wide" : "keep" }) },
    ...FALLBACKS.map((fallback) => option(fallback, t(`pj.lay.fallback.${fallback}`), false)),
  );
  const screenOff = h("input", { type: "checkbox", "data-testid": "pj-lay-screen-off", onchange: () => state.setParams({ screen: screenOff.checked ? "off" : undefined }) });
  const hasScreen = state.sources.some((source) => source.kind === "screen");
  const undoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-lay-undo", onclick: () => state.undo() }, t("pj.lay.undo"));
  const redoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-lay-redo", onclick: () => state.redo() }, t("pj.lay.redo"));
  const clearButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-lay-clear", onclick: () => state.clearOverrides() }, t("pj.lay.clear"));
  const saveStatus = h("span", { class: "pill", "data-testid": "pj-lay-save" });
  const conflictHost = h("div");
  const summary = h("p", { class: "hint", "data-testid": "pj-lay-summary" });

  const field = (label: string, ...controls: HTMLElement[]): HTMLElement => h("div", { class: "field" }, h("span", {}, label), h("div", { class: "row" }, ...controls));

  // ---- the scene list ---------------------------------------------------------------------------------------------------
  const tbody = h("tbody", { "data-testid": "pj-lay-scenes" });
  let rows: HTMLElement[] = [];
  let nowRow: HTMLElement | null = null;

  function refocus(testId: string | null, start: string | undefined): void {
    if (!testId) return;
    const target = tbody.querySelector<HTMLElement>(`[data-testid="${testId}"][data-scene="${start}"]`);
    target?.focus();
  }

  function renderScenes(): void {
    const { scenes, plan } = state;
    const focused = document.activeElement instanceof HTMLElement && tbody.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.dataset.testid ?? null;
    const focusStart = focused?.dataset.scene;
    const manual = (scene: Scene): boolean => plan.overrides.some((override) => override.s < scene.e && override.e > scene.s);
    rows = scenes.map((scene) => {
      const own = manual(scene);
      const start = String(scene.s);
      const layoutSelect = h(
        "select",
        { class: "select-small", "data-testid": "pj-lay-scene-layout", "data-scene": start, "aria-label": t("pj.lay.col.layout"), onchange: () => state.addOverride({ s: scene.s, e: scene.e, layout: layoutSelect.value as LayoutId }) },
        ...LAYOUT_IDS.map((id) => option(id, t(`pj.lay.layout.${id}`), id === scene.layout)),
      );
      const featured = scene.sources[0] ?? "";
      const sourceSelect = h(
        "select",
        {
          class: "select-small",
          "data-testid": "pj-lay-scene-source",
          "data-scene": start,
          "aria-label": t("pj.lay.col.source"),
          onchange: () => state.addOverride({ s: scene.s, e: scene.e, sources: [sourceSelect.value, ...scene.sources.filter((id) => id !== sourceSelect.value)] }),
        },
        ...sources.map((source) => option(source.id, source.name, source.id === featured)),
      );
      return h(
        "tr",
        { "data-testid": "pj-lay-scene", "data-start": start, "data-end": String(scene.e), "data-layout": scene.layout, "data-state": own ? "manual" : "auto" },
        h("td", { class: "num" }, h("button", { type: "button", class: "link-button", title: t("pj.lay.seek"), "data-testid": "pj-lay-scene-go", onclick: () => stg.seek(scene.s) }, formatClock(scene.s))),
        h("td", { class: "num" }, formatClock(scene.e - scene.s)),
        h("td", {}, layoutSelect),
        h("td", {}, sourceSelect),
        h(
          "td",
          {},
          own
            ? h("span", { class: "row" }, t("pj.lay.manual"), h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-lay-scene-reset", onclick: () => state.resetRange(scene.s, scene.e) }, t("pj.lay.reset")))
            : h("span", { class: "hint" }, t("pj.lay.auto")),
        ),
      );
    });
    setChildren(tbody, ...rows);
    nowRow = null;
    markNow(stg.audio.currentTime * 1000);
    refocus(focusId, focusStart);
    const manualCount = scenes.filter(manual).length;
    summary.textContent = scenes.length === 0 ? t("pj.lay.empty") : t("pj.lay.scenes.count", { count: scenes.length, manual: manualCount });
    stg.tl.setSceneBounds(scenes.slice(1).map((scene) => scene.s));
  }

  function markNow(ms: number): void {
    const next = rows[sceneIndexAt(state.scenes, ms)] ?? null;
    if (next === nowRow) return;
    nowRow?.removeAttribute("aria-current");
    nowRow?.classList.remove("now");
    nowRow = next;
    nowRow?.setAttribute("aria-current", "true");
    nowRow?.classList.add("now");
  }

  // ---- keeping the controls and the preview in step with the state --------------------------------------------------------
  let shownScenes: Scene[] | null = null;
  let shownPlan: object | null = null;
  let shownLook: { scenes: Scene[]; aspect: Aspect; background: Background } | null = null;
  /** The shape a clip preview shows the program in, instead of the saved one; never written into the layout. */
  let aspectOverride: Aspect | null = null;

  function pushLook(): void {
    const aspect = aspectOverride ?? state.aspect;
    if (shownLook?.scenes === state.scenes && shownLook.aspect === aspect && shownLook.background === state.background) return;
    shownLook = { scenes: state.scenes, aspect, background: state.background };
    preview.update(shownLook);
  }

  function sync(): void {
    const { params } = state.plan;
    for (const [id, button] of layoutButtons) pressed(button, params.layout === id);
    for (const [aspect, button] of aspectButtons) pressed(button, state.aspect === aspect);
    fitSelect.value = params.fit ?? "auto";
    kindSelect.value = state.background.kind;
    if (state.background.kind === "color") colorInput.value = state.background.color;
    else sigmaInput.value = String(state.background.sigma);
    colorInput.hidden = state.background.kind !== "color";
    sigmaInput.hidden = state.background.kind !== "blur";
    rhythmSelect.value = params.rhythm;
    if (document.activeElement !== dwellInput) dwellInput.value = String(params.minDwellMs / 1000);
    fallbackSelect.value = params.fallback;
    screenOff.checked = params.screen === "off";
    undoButton.disabled = !state.canUndo;
    redoButton.disabled = !state.canRedo;
    clearButton.disabled = state.plan.overrides.length === 0;
    saveStatus.setAttribute("data-status", state.status);
    saveStatus.textContent = t(`pj.ed.save.${state.status}`);
    saveStatus.className = `pill pill-${state.status === "saved" ? "ok" : state.status === "error" ? "failed" : "pending"}`;
    setChildren(conflictHost, state.conflict ? banner("warn", t("pj.lay.conflict"), "pj-lay-conflict") : null);

    if (state.scenes !== shownScenes || state.plan !== shownPlan) {
      shownScenes = state.scenes;
      shownPlan = state.plan;
      renderScenes();
    }
    pushLook();
  }
  const unsubscribe = state.subscribe(sync);
  const stopClipWatch = stg.onClip((clip) => {
    aspectOverride = clip?.aspect ?? null;
    previewLabel.textContent = clip ? t("prev.lay.clip", { aspect: clip.aspect }) : t("pj.lay.preview");
    pushLook();
  });

  // Ctrl/Cmd+Z in this panel undoes the layout, not the cuts: the panel takes the keys before the page-wide handler.
  const onKey = (event: KeyboardEvent): void => {
    const action = historyKey(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "undo") state.undo();
    else state.redo();
  };
  const onLeave = (): void => state.saveOnLeave();
  window.addEventListener("pagehide", onLeave);

  // ---- a suggested plan -------------------------------------------------------------------------------------------------
  let gone = false;
  const sugLlm = h("input", { type: "checkbox", "data-testid": "pj-lay-suggest-llm" });
  sugLlm.checked = settings.llm;
  const sugButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-lay-suggest", onclick: () => void suggest() }, t("pj.lay.sug"));
  const sugHost = h("div", { class: "stack", "data-testid": "pj-lay-suggest-result" });

  const spanList = (title: MessageKey, spans: Span[], fromModel: boolean): HTMLElement | null =>
    spans.length === 0
      ? null
      : h(
          "div",
          {},
          h("h5", {}, t(title)),
          h(
            "ul",
            { class: "clip-reasons" },
            ...spans.map((span) =>
              h(
                "li",
                { "data-reason": fromModel ? "model" : span.reason },
                h("button", { type: "button", class: "link-button", title: t("pj.lay.seek"), onclick: () => stg.seek(span.s) }, `${formatClock(span.s)}–${formatClock(span.e)}`),
                ` ${fromModel ? span.reason : (REASON_TEXT[span.reason]?.[getLang()] ?? (span.reason === "silence" ? t("pj.lay.sug.reason.silence") : span.reason))}`,
              ),
            ),
          ),
        );

  async function suggest(): Promise<void> {
    sugButton.disabled = true;
    const wantModel = sugLlm.checked;
    try {
      const result = await api.suggestScenePlan(wantModel);
      if (gone) return;
      const fromModel = result.source === "llm";
      // the layouts go onto the editor's own plan in one undoable step; the lists are advisory
      state.addOverrides(result.overrides);
      const status = fromModel
        ? banner("info", result.overrides.length > 0 ? t("pj.lay.sug.applied", { count: result.overrides.length }) : t("pj.lay.sug.same"), "pj-lay-suggest-note")
        : banner(wantModel ? "warn" : "info", wantModel ? t(result.llmAvailable ? "pj.lay.sug.failed" : "pj.lay.sug.unavailable") : t("pj.lay.sug.rules"), "pj-lay-suggest-note");
      status.setAttribute("data-state", fromModel ? "used" : wantModel ? (result.llmAvailable ? "failed" : "unavailable") : "rules");
      const lists = [spanList("pj.lay.sug.highlights", result.highlights, fromModel), spanList("pj.lay.sug.cuts", result.cuts, fromModel)];
      setChildren(sugHost, status, ...(lists.every((list) => list === null) ? [h("p", { class: "hint" }, t("pj.lay.sug.none"))] : lists));
    } catch (error) {
      if (!gone) setChildren(sugHost, banner("error", error instanceof ApiError && error.code === "transcript_missing" ? t("pj.cl.needTranscript") : t("err.generic", { message: error instanceof Error ? error.message : "?" }), "pj-lay-suggest-error"));
    } finally {
      if (!gone) sugButton.disabled = false;
    }
  }

  const needsProxies = sources.some((source) => source.video === null && source.card === undefined);
  const el = h(
    "div",
    { class: "stack", tabindex: -1, "data-testid": "pj-layout" },
    h("p", { class: "hint" }, t("pj.lay.lead")),
    needsProxies ? banner("warn", t("pj.lay.noProxies"), "pj-lay-noproxies") : null,
    h(
      "div",
      { class: "lay-controls" },
      field(t("pj.lay.layout"), ...layoutButtons.values()),
      field(t("pj.lay.aspect"), ...aspectButtons.values()),
      field(t("pj.lay.fit"), fitSelect),
      field(t("pj.lay.bg"), kindSelect, colorInput, sigmaInput),
      field(t("pj.lay.rhythm"), rhythmSelect),
      field(t("pj.lay.dwell"), dwellInput),
      field(t("pj.lay.fallback"), fallbackSelect),
      hasScreen ? h("label", { class: "check", "data-testid": "pj-lay-screen-off-row" }, screenOff, h("span", {}, t("pj.lay.screenOff"), h("span", { class: "hint ex-hint" }, t("pj.lay.screenOff.hint")))) : null,
    ),
    h("div", { class: "row editor-toolbar" }, undoButton, redoButton, clearButton, saveStatus),
    h("div", { class: "row", "data-testid": "pj-lay-suggest-row" }, sugButton, h("label", { class: "check" }, sugLlm, h("span", {}, t("pj.lay.sug.llm"), h("span", { class: "hint ex-hint" }, t(settings.llmRemote ? "pj.lay.sug.hint.remote" : "pj.lay.sug.hint"))))),
    sugHost,
    conflictHost,
    h("h4", {}, t("pj.lay.scenes")),
    summary,
    h(
      "div",
      { class: "lay-scenes" },
      h(
        "table",
        { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, t("pj.lay.col.start")), h("th", {}, t("pj.lay.col.length")), h("th", {}, t("pj.lay.col.layout")), h("th", {}, t("pj.lay.col.source")), h("th", {}, t("pj.lay.col.manual")))),
        tbody,
      ),
    ),
  );

  el.addEventListener("keydown", onKey);
  sync();

  return {
    el,
    dispose() {
      gone = true;
      unsubscribe();
      stopFollowing();
      stopClipWatch();
      window.removeEventListener("pagehide", onLeave);
      if (window.__syncPreview === hook) delete window.__syncPreview;
      preview.dispose();
      stg.previewSlot.replaceChildren();
      stg.tl.setSceneBounds([]);
      el.replaceChildren();
    },
  };
}
