import { keptDuration, toOutput, type Edl } from "../../shared/edl.js";
import type { ProjectFile } from "../../shared/project.js";
import { h, setChildren } from "../lib/dom.js";
import { EditState } from "../lib/edit-state.js";
import { historyKey } from "../lib/keys.js";
import type { EdlFile, ProjectApi } from "../lib/project-api.js";
import { attachSkipPlayer, type SkipPlayer } from "../lib/skip-player.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { banner } from "./layout.js";
import { combinePeaks, timeline, type Timeline } from "./timeline.js";

export interface Stage {
  el: HTMLElement;
  /** The element the layout preview goes into (above the player). */
  previewSlot: HTMLElement;
  audio: HTMLAudioElement;
  player: SkipPlayer;
  edit: EditState;
  tl: Timeline;
  durationMs: number;
  /** Moves the playhead (a position inside a removed range lands after it) and refreshes everything that follows it. */
  seek(ms: number): void;
  /** The prepared media came or went (after an export, or prepared again): the player follows without losing the cuts. */
  setMedia(project: ProjectFile): void;
  /** Called with the playhead position on every frame while playing and after every seek or edit. */
  onTick(listener: (ms: number) => void): () => void;
  /** Saves what is pending. */
  flush(): Promise<void>;
  dispose(): void;
}

/**
 * The player of the project page: one audio element on the mix, the skip logic over the cut list, the timeline strip,
 * the edit state with its undo/redo and the position readouts. The transcript and the layout preview follow it.
 */
export function stage(api: ProjectApi, project: ProjectFile, saved: EdlFile): Stage {
  const durationMs = project.durationMs;
  const edit = new EditState(api, durationMs, saved);
  // the mix is addressed with the time of its last preparation, so that a prepared-again file is not taken from the cache
  const mediaOf = (current: ProjectFile): string | null => (current.mixProxy ? `${api.mediaUrl(current.mixProxy)}&v=${current.conform.atMs ?? 0}` : null);
  let media = mediaOf(project);
  const audio = h("audio", { controls: true, preload: "metadata", "data-testid": "pj-player", src: media ?? undefined });
  const player = attachSkipPlayer(audio, () => edit.edl);
  const listeners = new Set<(ms: number) => void>();
  let disposed = false;

  const tl = timeline({ durationMs, highlights: project.highlights.map((highlight) => highlight.atMs), onSeek: (ms) => seek(ms) });
  const position = h("span", { class: "hint", "data-testid": "pj-ed-pos" });
  const kept = h("span", { "data-testid": "pj-ed-kept" });
  const saveStatus = h("span", { class: "pill", "data-testid": "pj-ed-save" });
  const conflictHost = h("div");
  const undoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-undo", onclick: () => edit.undo() }, t("pj.ed.undo"));
  const redoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-redo", onclick: () => edit.redo() }, t("pj.ed.redo"));

  function refresh(): void {
    const ms = audio.currentTime * 1000;
    tl.setPlayhead(ms);
    position.textContent = t("pj.ed.position", { pos: formatClock(ms), edited: formatClock(toOutput(edit.edl, ms)) });
    for (const listener of [...listeners]) listener(ms);
  }

  function seek(ms: number): void {
    player.seek(Math.max(0, ms));
    refresh();
  }

  let frame = 0;
  const loop = (): void => {
    frame = 0;
    refresh();
    if (!audio.paused && !audio.ended && !disposed) frame = requestAnimationFrame(loop);
  };
  const startLoop = (): void => {
    if (frame === 0) frame = requestAnimationFrame(loop);
  };
  audio.addEventListener("playing", startLoop);
  audio.addEventListener("timeupdate", refresh);
  audio.addEventListener("seeked", refresh);
  audio.addEventListener("loadedmetadata", refresh);

  // The waveform comes from the peaks of every audio track; the strip stays empty when they are not there (removed media).
  const peakFiles = project.sources.flatMap((source) => (source.audio ? [source.audio.peaks] : []));
  void Promise.allSettled(peakFiles.map((file) => api.peaks(file))).then((results) => {
    if (disposed) return;
    const tracks = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (tracks.length > 0) tl.setPeaks(combinePeaks(tracks));
  });

  let shownEdl: Edl | null = null;
  function onEdit(): void {
    saveStatus.setAttribute("data-status", edit.status);
    saveStatus.textContent = t(`pj.ed.save.${edit.status}`);
    saveStatus.className = `pill pill-${edit.status === "saved" ? "ok" : edit.status === "error" ? "failed" : "pending"}`;
    setChildren(conflictHost, edit.conflict ? banner("warn", t("pj.ed.conflict"), "pj-ed-conflict") : null);
    undoButton.disabled = !edit.canUndo;
    redoButton.disabled = !edit.canRedo;
    if (edit.edl === shownEdl) return;
    shownEdl = edit.edl;
    tl.setRemoved(edit.edl.removed);
    const keptMs = keptDuration(edit.edl, durationMs);
    kept.textContent = t("pj.ed.kept", { kept: formatClock(keptMs), total: formatClock(durationMs), cut: formatClock(durationMs - keptMs) });
    kept.setAttribute("data-kept-ms", String(keptMs));
    kept.setAttribute("data-total-ms", String(durationMs));
    refresh();
  }
  const unsubscribe = edit.subscribe(onEdit);

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y undo and redo the cuts; a focused layout panel takes the keys before they get here.
  const onKey = (event: KeyboardEvent): void => {
    const action = historyKey(event);
    if (!action) return;
    event.preventDefault();
    if (action === "undo") edit.undo();
    else edit.redo();
  };
  document.addEventListener("keydown", onKey);
  const onLeave = (): void => edit.saveOnLeave();
  window.addEventListener("pagehide", onLeave);

  const noMedia = h("p", { class: "hint", "data-testid": "pj-ed-nomedia", hidden: media !== null }, t("pj.ed.noMedia"));
  const previewSlot = h("div");
  const el = h(
    "div",
    { class: "stack", "data-testid": "pj-stage" },
    previewSlot,
    audio,
    noMedia,
    h("div", { class: "row editor-status" }, position, kept, saveStatus),
    tl.el,
    conflictHost,
    h("div", { class: "row editor-toolbar", role: "toolbar", "aria-label": t("pj.ed.title") }, undoButton, redoButton),
  );

  onEdit();

  return {
    el,
    previewSlot,
    audio,
    player,
    edit,
    tl,
    durationMs,
    seek,
    setMedia(next) {
      const url = mediaOf(next);
      if (url === media) return;
      media = url;
      const at = audio.currentTime;
      if (url) {
        audio.src = url;
        audio.addEventListener(
          "loadedmetadata",
          () => {
            audio.currentTime = at;
          },
          { once: true },
        );
      } else {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      noMedia.hidden = url !== null;
      refresh();
    },
    onTick(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: () => edit.flush(),
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onLeave);
      unsubscribe();
      listeners.clear();
      player.dispose();
      tl.dispose();
      edit.dispose();
      audio.pause();
      audio.removeAttribute("src");
      setChildren(el);
    },
  };
}
