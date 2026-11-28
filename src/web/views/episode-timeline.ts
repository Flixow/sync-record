import type { Range } from "../../shared/edl.js";
import {
  clampZoom,
  commonOf,
  dragRange,
  fitPxPerSec,
  layoutOverride,
  msToPx,
  participantLanes,
  pxToMs,
  sceneRange,
  scenesIn,
  soundRuns,
  sourceOverride,
  sourceOwner,
  tickStepMs,
  touchesOverride,
  windowColumns,
  type ParticipantLanes,
  type SoundRun,
  type Span,
} from "../../shared/episode-timeline.js";
import { LAYOUT_IDS, type LayoutId } from "../../shared/layout.js";
import type { ProjectFile } from "../../shared/project.js";
import type { Scene } from "../../shared/scenes.js";
import { h, setChildren } from "../lib/dom.js";
import type { ProjectApi } from "../lib/project-api.js";
import type { SceneState } from "../lib/scene-state.js";
import { formatClock, formatSeconds } from "../lib/time.js";
import { t } from "../i18n/index.js";
import type { PreviewSource } from "./layout-preview.js";
import type { Stage } from "./stage.js";
import { combinePeaks } from "./timeline.js";

const PALETTE = ["#2563eb", "#d97706", "#059669", "#9333ea", "#db2777", "#0891b2"];
const HEIGHT = { ruler: 24, picture: 46, sound: 26, audio: 40, camera: 20, screen: 20 } as const;
const FALLBACK = PALETTE[0] as string;
const DRAG_PX = 4;
const KEY_STEP_MS = 1000;
const KEY_STEP_BIG_MS = 10_000;
const BUTTON_ZOOM = 1.6;
const WHEEL_ZOOM = 1.25;
const FOLLOW_MARGIN = 0.1;
const FOLLOW_LANDING = 0.25;

type LaneKind = keyof typeof HEIGHT;

export interface SceneBoard {
  state: SceneState;
  sources: PreviewSource[];
}

export interface EpisodeTimeline {
  el: HTMLElement;
  dispose(): void;
}

interface Row {
  kind: LaneKind;
  testId: string;
  label: string;
  sub: string;
  color: string | null;
  lane: HTMLElement;
}

const option = (value: string, label: string): HTMLOptionElement => h("option", { value }, label);

/**
 * The episode as a video editor shows it: a ruler, the program lanes (the picture the episode shows and whose voice carries it),
 * and per participant a sound, camera and screen lane. The lanes share one time axis that zooms and scrolls. A click moves the
 * playhead of the player; a drag selects a stretch whose picture and layout can be changed (the scene plan's own overrides, with its undo).
 */
export function episodeTimeline(api: ProjectApi, stg: Stage, project: ProjectFile, board: SceneBoard | null): EpisodeTimeline {
  const durationMs = stg.durationMs;
  const people = participantLanes(project);
  const colorOf = new Map(people.map((person, index) => [person.participantId, PALETTE[index % PALETTE.length] as string]));
  const sourceById = new Map((board?.sources ?? []).map((source) => [source.id, source]));
  let pps = 1;
  let viewport = 0;
  let selection: Span | null = null;
  let disposed = false;
  let frame = 0;
  let removed: Range[] = [];
  let runs: SoundRun[] = [];
  let personPeaks: (Uint8Array | null)[] = people.map(() => null);

  const content = h("div", { class: "etl-content", "data-testid": "pj-tl-content" });
  const scroller = h("div", { class: "etl-scroller", tabindex: 0, role: "group", "aria-label": t("tl.lanes"), "data-testid": "pj-tl-lanes" }, content);
  const labels = h("div", { class: "etl-labels" });
  const overlay = h("div", { class: "etl-overlay" });
  const playhead = h("div", { class: "etl-playhead", "data-testid": "pj-tl-playhead" });
  const selectionBox = h("div", { class: "etl-selection", hidden: true, "data-testid": "pj-tl-selection" });
  overlay.append(selectionBox, playhead);

  const rows: Row[] = [];
  const addRow = (kind: LaneKind, testId: string, label: string, sub: string, color: string | null): Row => {
    const lane = h("div", { class: `etl-lane etl-lane-${kind}`, "data-lane": kind, "data-testid": testId });
    lane.style.height = `${HEIGHT[kind]}px`;
    const row: Row = { kind, testId, label, sub, color, lane };
    rows.push(row);
    return row;
  };

  addRow("ruler", "pj-tl-ruler", "", "", null);
  const pictureRow = board ? addRow("picture", "pj-tl-picture", t("tl.lane.picture"), "", null) : null;
  const soundRow = addRow("sound", "pj-tl-sound", t("tl.lane.sound"), "", null);
  const audioRows = new Map<string, Row>();
  const spanRows: { row: Row; spans: Span[] }[] = [];
  for (const person of people) {
    const color = colorOf.get(person.participantId) ?? FALLBACK;
    if (person.audio.length > 0) audioRows.set(person.participantId, addRow("audio", `pj-tl-audio-${person.participantId}`, person.name, t("tl.lane.audio"), color));
    if (person.camera.length > 0) spanRows.push({ row: addRow("camera", `pj-tl-camera-${person.participantId}`, person.name, t("tl.lane.camera"), color), spans: person.camera });
    if (person.screen.length > 0) spanRows.push({ row: addRow("screen", `pj-tl-screen-${person.participantId}`, person.name, t("tl.lane.screen"), color), spans: person.screen });
  }
  for (const row of rows) {
    content.append(row.lane);
    const label = h("div", { class: `etl-label etl-label-${row.kind}` });
    label.style.height = `${HEIGHT[row.kind]}px`;
    if (row.color) label.style.setProperty("--etl-c", row.color);
    if (row.label) setChildren(label, h("span", { class: "etl-label-name" }, row.label), row.sub ? h("span", { class: "etl-label-sub" }, row.sub) : null);
    labels.append(label);
  }
  content.append(overlay);

  const canvases = new Map<Row, HTMLCanvasElement>();
  for (const row of rows) {
    if (row.kind === "ruler" || row.kind === "sound" || row.kind === "audio") {
      const canvas = h("canvas", { class: "etl-canvas", "aria-hidden": "true" });
      canvas.style.height = `${HEIGHT[row.kind]}px`;
      canvases.set(row, canvas);
      row.lane.append(canvas);
    }
  }

  const readout = h("span", { class: "hint etl-readout", "data-testid": "pj-tl-readout" });
  const scrub = h("input", {
    type: "range",
    class: "etl-scrub",
    min: 0,
    max: Math.max(1, Math.round(durationMs)),
    step: 100,
    value: 0,
    "aria-label": t("tl.scrub"),
    "data-testid": "pj-tl-scrub",
    oninput: () => stg.seek(Number(scrub.value)),
  });

  const button = (testId: string, text: string, onclick: () => void): HTMLButtonElement => h("button", { type: "button", class: "btn btn-small", "data-testid": testId, onclick }, text);
  const zoomOut = button("pj-tl-zoom-out", t("tl.zoom.out"), () => zoomBy(1 / BUTTON_ZOOM));
  const zoomIn = button("pj-tl-zoom-in", t("tl.zoom.in"), () => zoomBy(BUTTON_ZOOM));
  const zoomFit = button("pj-tl-zoom-fit", t("tl.zoom.fit"), () => setZoom(fitPxPerSec(durationMs, viewport), stg.audio.currentTime * 1000));
  const follow = h("input", { type: "checkbox", checked: true, "data-testid": "pj-tl-follow" });
  const state = board?.state ?? null;
  const undoButton = button("pj-tl-undo", t("pj.lay.undo"), () => state?.undo());
  const redoButton = button("pj-tl-redo", t("pj.lay.redo"), () => state?.redo());
  const allAuto = button("pj-tl-all-auto", t("tl.allAuto"), () => state?.clearOverrides());
  const saveStatus = h("span", { class: "pill", "data-testid": "pj-tl-save" });

  const selRange = h("span", { class: "etl-sel-range", "data-testid": "pj-tl-sel-range" });
  const sourceSelect = h("select", { "aria-label": t("tl.sel.source"), "data-testid": "pj-tl-sel-source", onchange: () => applySource() }, option("", t("tl.sel.mixed")), ...(board?.sources ?? []).map((source) => option(source.id, source.name)));
  const layoutSelect = h("select", { "aria-label": t("tl.sel.layout"), "data-testid": "pj-tl-sel-layout", onchange: () => applyLayout() }, option("", t("tl.sel.mixed")), ...LAYOUT_IDS.map((id) => option(id, t(`pj.lay.layout.${id}`))));
  const autoAgain = button("pj-tl-sel-auto", t("tl.sel.auto"), () => {
    if (state && selection) state.resetRange(selection.s, selection.e);
  });
  const clearSelection = button("pj-tl-sel-clear", t("tl.sel.clear"), () => select(null));
  const selectionHint = h("p", { class: "hint", "data-testid": "pj-tl-sel-hint" }, t(board ? "tl.sel.hint" : "tl.sel.hintAudio"));
  const field = (label: string, control: HTMLElement): HTMLElement => h("label", { class: "field" }, h("span", {}, label), control);
  const sceneControls = [field(t("tl.sel.source"), sourceSelect), field(t("tl.sel.layout"), layoutSelect), autoAgain];
  const editor = h("div", { class: "etl-editor stack", hidden: true, "data-testid": "pj-tl-editor" }, h("div", { class: "row" }, h("strong", {}, t("tl.sel.title")), selRange), h("div", { class: "row" }, ...sceneControls, clearSelection));

  const toolbar = h(
    "div",
    { class: "row etl-toolbar", role: "toolbar", "aria-label": t("tl.title") },
    zoomOut,
    zoomIn,
    zoomFit,
    h("label", { class: "check etl-follow" }, follow, h("span", {}, t("tl.follow"))),
    state ? undoButton : null,
    state ? redoButton : null,
    state ? allAuto : null,
    state ? saveStatus : null,
    readout,
  );
  const body = h("div", { class: "etl-body" }, labels, scroller);
  const el = h("div", { class: "etl stack", "data-testid": "pj-tl" }, h("p", { class: "hint" }, t("tl.guide")), toolbar, scrub, body, selectionHint, editor);

  const xOf = (ms: number): number => msToPx(ms, pps);
  const msAtClient = (clientX: number): number => Math.min(durationMs, Math.max(0, pxToMs(clientX - content.getBoundingClientRect().left, pps)));
  const nameOf = (id: string): string => sourceById.get(id)?.name ?? id;

  function place(block: HTMLElement, span: Span): void {
    block.style.left = `${xOf(span.s)}px`;
    block.style.width = `${Math.max(1, xOf(span.e - span.s))}px`;
  }

  function paintWave(canvas: HTMLCanvasElement, peaks: Uint8Array | null, color: string, start: number, end: number): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const height = canvas.height / dpr;
    ctx.clearRect(0, 0, viewport, height);
    if (!peaks) return;
    const columns = windowColumns(peaks, start, end, viewport);
    ctx.fillStyle = color;
    const mid = height / 2;
    for (let x = 0; x < viewport; x++) {
      const amplitude = Math.sqrt((columns[x] as number) / 255);
      const half = Math.max(0.5, amplitude * (mid - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }

  function paintSound(canvas: HTMLCanvasElement, start: number, end: number): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const height = canvas.height / dpr;
    ctx.clearRect(0, 0, viewport, height);
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const run of runs) {
      if (run.e < start) continue;
      if (run.s > end) break;
      const x = Math.max(0, xOf(run.s) - scroller.scrollLeft);
      const width = Math.max(1, xOf(run.e) - scroller.scrollLeft - x);
      const person = people[run.who] as ParticipantLanes;
      ctx.fillStyle = colorOf.get(person.participantId) ?? FALLBACK;
      ctx.fillRect(x, 2, width, height - 4);
      if (width > 56) {
        ctx.fillStyle = "#fff";
        ctx.fillText(person.name, x + 6, height / 2, width - 10);
      }
    }
  }

  function paintRuler(canvas: HTMLCanvasElement, start: number, end: number): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const height = canvas.height / dpr;
    ctx.clearRect(0, 0, viewport, height);
    const style = getComputedStyle(canvas);
    ctx.fillStyle = style.getPropertyValue("--muted").trim() || "#475569";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "top";
    const step = tickStepMs(pps);
    for (let at = Math.floor(start / step) * step; at <= end; at += step) {
      const x = Math.round(xOf(at) - scroller.scrollLeft);
      ctx.fillRect(x, height - 8, 1, 8);
      ctx.fillText(formatClock(at).replace(/\.0$/, ""), x + 3, 3);
    }
  }

  function paint(): void {
    frame = 0;
    if (disposed || viewport <= 0) return;
    const start = pxToMs(scroller.scrollLeft, pps);
    const end = start + pxToMs(viewport, pps);
    const dpr = window.devicePixelRatio || 1;
    for (const [row, canvas] of canvases) {
      const width = Math.round(viewport * dpr);
      if (canvas.width !== width) canvas.width = width;
      const height = Math.round(HEIGHT[row.kind] * dpr);
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${viewport}px`;
      if (row.kind === "ruler") paintRuler(canvas, start, end);
      else if (row.kind === "sound") paintSound(canvas, start, end);
      else {
        const index = people.findIndex((person) => audioRows.get(person.participantId) === row);
        paintWave(canvas, personPeaks[index] ?? null, row.color ?? FALLBACK, start, end);
      }
    }
  }

  function schedule(): void {
    if (frame === 0 && !disposed) frame = requestAnimationFrame(paint);
  }

  function renderSpans(): void {
    for (const { row, spans } of spanRows) {
      setChildren(
        row.lane,
        ...spans.map((span) => {
          const block = h("div", { class: "etl-span", "data-testid": `${row.testId}-span`, "data-start": String(Math.round(span.s)), "data-end": String(Math.round(span.e)) });
          block.style.setProperty("--etl-c", row.color ?? FALLBACK);
          place(block, span);
          return block;
        }),
      );
    }
  }

  function renderRemoved(): void {
    overlay.querySelectorAll(".etl-removed").forEach((node) => node.remove());
    for (const range of removed) {
      const block = h("div", { class: "etl-removed", title: t("tl.cut"), "data-testid": "pj-tl-removed" });
      place(block, range);
      overlay.prepend(block);
    }
  }

  const isManual = (scene: Scene): boolean => (state ? touchesOverride(state.plan.overrides, scene) : false);

  function renderScenes(): void {
    if (!pictureRow || !state) return;
    const blocks = state.scenes.map((scene) => {
      const main = scene.sources[0] ?? "";
      const names = scene.sources.map(nameOf);
      const more = scene.layout !== "solo" && scene.sources.length > 1 ? ` +${scene.sources.length - 1}` : "";
      const owner = sourceOwner(project, main);
      const manual = isManual(scene);
      const block = h(
        "div",
        {
          class: `etl-scene${manual ? " manual" : ""}${sourceById.get(main)?.kind === "screen" ? " screen" : ""}`,
          title: `${names.join(", ")} · ${t(`pj.lay.layout.${scene.layout}`)}${manual ? ` · ${t("tl.manual")}` : ""}`,
          "data-testid": "pj-tl-scene",
          "data-start": String(scene.s),
          "data-end": String(scene.e),
          "data-main": main,
          "data-layout": scene.layout,
          "data-state": manual ? "manual" : "auto",
        },
        h("span", { class: "etl-scene-name" }, `${nameOf(main)}${more}`),
        manual ? h("span", { class: "etl-scene-mark", "aria-hidden": "true" }, "●") : null,
      );
      block.style.setProperty("--etl-c", (owner ? colorOf.get(owner) : undefined) ?? FALLBACK);
      place(block, scene);
      return block;
    });
    setChildren(pictureRow.lane, ...blocks);
    pictureRow.lane.dataset.scenes = String(blocks.length);
  }

  function layoutAll(): void {
    content.style.width = `${xOf(durationMs)}px`;
    content.dataset.pps = pps.toFixed(3);
    renderSpans();
    renderRemoved();
    renderScenes();
    renderSelection();
    movePlayhead(stg.audio.currentTime * 1000);
    schedule();
  }

  function renderSelection(): void {
    selectionBox.hidden = selection === null;
    if (!selection) return;
    place(selectionBox, selection);
    selectionBox.dataset.start = String(selection.s);
    selectionBox.dataset.end = String(selection.e);
  }

  function syncEditor(): void {
    const open = selection !== null;
    editor.hidden = !open;
    selectionHint.hidden = open;
    if (!open || !selection) return;
    selRange.textContent = t("tl.sel.range", { from: formatClock(selection.s), to: formatClock(selection.e), length: formatSeconds(selection.e - selection.s) });
    const inside = state ? scenesIn(state.scenes, selection) : [];
    const editable = state !== null && inside.length > 0;
    sourceSelect.value = commonOf(inside, (scene) => scene.sources[0] ?? "") ?? "";
    layoutSelect.value = commonOf<LayoutId>(inside, (scene) => scene.layout) ?? "";
    sourceSelect.disabled = !editable;
    layoutSelect.disabled = !editable;
    autoAgain.disabled = !state || !selection || !touchesOverride(state.plan.overrides, selection);
    for (const control of sceneControls) control.hidden = state === null;
  }

  function syncState(): void {
    if (!state) return;
    undoButton.disabled = !state.canUndo;
    redoButton.disabled = !state.canRedo;
    allAuto.disabled = state.plan.overrides.length === 0;
    saveStatus.setAttribute("data-status", state.status);
    saveStatus.textContent = t(`pj.ed.save.${state.status}`);
    saveStatus.className = `pill pill-${state.status === "saved" ? "ok" : state.status === "error" ? "failed" : "pending"}`;
    renderScenes();
    syncEditor();
  }

  function select(next: Span | null): void {
    selection = next;
    renderSelection();
    syncEditor();
  }

  function applySource(): void {
    if (!state || !selection || sourceSelect.value === "") return;
    state.addOverride(sourceOverride(state.scenes, selection, sourceSelect.value));
  }

  function applyLayout(): void {
    if (!state || !selection || layoutSelect.value === "") return;
    state.addOverride(layoutOverride(selection, layoutSelect.value as LayoutId));
  }

  function movePlayhead(ms: number): void {
    playhead.style.transform = `translateX(${xOf(ms)}px)`;
    playhead.dataset.ms = String(Math.round(ms));
    readout.textContent = `${formatClock(ms)} / ${formatClock(durationMs)}`;
    if (document.activeElement !== scrub || stg.audio.paused === false) scrub.value = String(Math.round(ms));
    scrub.setAttribute("aria-valuetext", formatClock(ms));
  }

  function reveal(ms: number, always: boolean): void {
    if (viewport <= 0) return;
    const x = xOf(ms);
    const margin = viewport * FOLLOW_MARGIN;
    if (x >= scroller.scrollLeft + margin && x <= scroller.scrollLeft + viewport - margin) return;
    if (!always && !follow.checked) return;
    scroller.scrollLeft = Math.max(0, x - viewport * FOLLOW_LANDING);
  }

  function setZoom(next: number, anchorMs: number, anchorX = viewport / 2): void {
    const clamped = clampZoom(next, durationMs, viewport);
    if (clamped === pps && content.style.width !== "") return;
    pps = clamped;
    layoutAll();
    scroller.scrollLeft = Math.max(0, xOf(anchorMs) - anchorX);
    schedule();
  }

  function zoomBy(factor: number): void {
    const ms = stg.audio.currentTime * 1000;
    const x = xOf(ms) - scroller.scrollLeft;
    setZoom(pps * factor, ms, x >= 0 && x <= viewport ? x : viewport / 2);
  }

  const stopTick = stg.onTick((ms) => {
    movePlayhead(ms);
    if (!stg.audio.paused) reveal(ms, false);
  });
  const stopSeek = stg.onSeek((ms) => reveal(ms, true));
  const stopEdit = stg.edit.subscribe(() => {
    removed = stg.edit.edl.removed;
    renderRemoved();
  });
  const stopState = state?.subscribe(syncState);

  let down: { ms: number; x: number; lane: string; moved: boolean } | null = null;
  content.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    down = { ms: msAtClient(event.clientX), x: event.clientX, lane: (event.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane ?? "", moved: false };
    content.setPointerCapture(event.pointerId);
  });
  content.addEventListener("pointermove", (event) => {
    if (!down) return;
    if (!down.moved && Math.abs(event.clientX - down.x) > DRAG_PX) down.moved = true;
    if (down.moved) {
      selection = dragRange(down.ms, msAtClient(event.clientX), durationMs);
      renderSelection();
    }
  });
  const finish = (event: PointerEvent): void => {
    const gesture = down;
    down = null;
    if (!gesture) return;
    if (gesture.moved) {
      select(dragRange(gesture.ms, msAtClient(event.clientX), durationMs));
      return;
    }
    stg.seek(gesture.ms);
    if (gesture.lane === "picture" && state) select(sceneRange(state.scenes, gesture.ms));
  };
  content.addEventListener("pointerup", finish);
  content.addEventListener("pointercancel", () => {
    down = null;
    renderSelection();
  });

  scroller.addEventListener("scroll", schedule);
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const x = event.clientX - rect.left;
      setZoom(pps * (event.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM), pxToMs(scroller.scrollLeft + x, pps), x);
    },
    { passive: false },
  );
  scroller.addEventListener("keydown", (event) => {
    const now = stg.audio.currentTime * 1000;
    const step = event.shiftKey ? KEY_STEP_BIG_MS : KEY_STEP_MS;
    if (event.key === "ArrowRight") stg.seek(Math.min(durationMs, now + step));
    else if (event.key === "ArrowLeft") stg.seek(Math.max(0, now - step));
    else if (event.key === "Home") stg.seek(0);
    else if (event.key === "End") stg.seek(durationMs);
    else if (event.key === "Escape") select(null);
    else if (event.key === "+" || event.key === "=") zoomBy(BUTTON_ZOOM);
    else if (event.key === "-") zoomBy(1 / BUTTON_ZOOM);
    else return;
    event.preventDefault();
  });

  const observer = new ResizeObserver(() => {
    const width = scroller.clientWidth;
    if (width <= 0 || width === viewport) return;
    const first = viewport === 0;
    viewport = width;
    setZoom(first ? fitPxPerSec(durationMs, width) : pps, stg.audio.currentTime * 1000);
  });
  observer.observe(scroller);

  void Promise.allSettled(
    people.map(async (person) => {
      const tracks = await Promise.all(person.audio.map((file) => api.peaks(file)));
      return combinePeaks(tracks);
    }),
  ).then((results) => {
    if (disposed) return;
    personPeaks = results.map((result) => (result.status === "fulfilled" ? result.value : null));
    const loaded = personPeaks.map((peaks) => peaks ?? new Uint8Array(0));
    runs = soundRuns(loaded, durationMs);
    soundRow.lane.dataset.speakers = [...new Set(runs.map((run) => (people[run.who] as ParticipantLanes).name))].join("|");
    soundRow.lane.dataset.runs = String(runs.length);
    for (const [id, row] of audioRows) row.lane.dataset.loaded = String(personPeaks[people.findIndex((person) => person.participantId === id)] !== null);
    schedule();
  });

  removed = stg.edit.edl.removed;
  layoutAll();
  syncState();
  syncEditor();

  return {
    el,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      stopTick();
      stopSeek();
      stopEdit();
      stopState?.();
      el.replaceChildren();
    },
  };
}
