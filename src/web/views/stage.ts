import { keptDuration, toOutput, type Edl, type Range } from "../../shared/edl.js";
import type { Aspect } from "../../shared/layout.js";
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
  /** Moves the playhead (a position inside a removed range lands after it) and refreshes everything that follows it. Ends a clip preview. */
  seek(ms: number): void;
  /** Called after the playhead was moved on purpose (timeline, a word, a scene, a clip), not for the player's own jumps over cuts. */
  onSeek(listener: (ms: number) => void): () => void;
  /**
   * Plays the stretch [range.s, range.e) and stops at its end. The picture of the layout preview is shown in `aspect`
   * while it plays (9:16 for a short) and goes back to the saved shape at its end, on `stopClip`, on a pause or a seek.
   * Without pictures it only plays the audio. Brings the preview into view if it is off screen.
   */
  playClip(range: Range, aspect: Aspect): void;
  /** Stops a clip preview and restores the saved shape; does nothing when none is playing. */
  stopClip(): void;
  /** Called at once and on every change with the clip preview that plays now, or null. */
  onClip(listener: (clip: ClipPlayback | null) => void): () => void;
  /** Plays the whole edited program from its start with the picture in the saved shape. Brings the preview into view if it is off screen. */
  playFromStart(): void;
  /** The prepared media came or went (after an export, or prepared again): the player follows without losing the cuts. */
  setMedia(project: ProjectFile): void;
  /** Called with the playhead position on every frame while playing and after every seek or edit. */
  onTick(listener: (ms: number) => void): () => void;
  /** Saves what is pending. */
  flush(): Promise<void>;
  dispose(): void;
}

/** A stretch of the recording that is being played as a preview, and the shape of the picture shown for it. */
export interface ClipPlayback {
  range: Range;
  aspect: Aspect;
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
  const seekListeners = new Set<(ms: number) => void>();
  const clipListeners = new Set<(clip: ClipPlayback | null) => void>();
  let clip: ClipPlayback | null = null;
  let disposed = false;

  const tl = timeline({ durationMs, highlights: project.highlights.map((highlight) => highlight.atMs), onSeek: (ms) => seek(ms) });
  const position = h("span", { class: "hint", "data-testid": "pj-ed-pos" });
  const kept = h("span", { "data-testid": "pj-ed-kept" });
  const saveStatus = h("span", { class: "pill", "data-testid": "pj-ed-save" });
  const conflictHost = h("div");
  const undoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-undo", onclick: () => edit.undo() }, t("pj.ed.undo"));
  const redoButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-redo", onclick: () => edit.redo() }, t("pj.ed.redo"));

  function setClip(next: ClipPlayback | null): void {
    if (next === clip) return;
    clip = next;
    for (const listener of [...clipListeners]) listener(clip);
  }

  function refresh(): void {
    const ms = audio.currentTime * 1000;
    // a clip preview stops at its end, and a position outside it (a jump over a cut that ran past its end) ends it too
    if (clip && ms >= clip.range.e) {
      setClip(null);
      audio.pause();
    }
    tl.setPlayhead(ms);
    position.textContent = t("pj.ed.position", { pos: formatClock(ms), edited: formatClock(toOutput(edit.edl, ms)) });
    for (const listener of [...listeners]) listener(ms);
  }

  /** Moves the playhead without touching a clip preview (the callers decide what happens to it). */
  function moveTo(ms: number): void {
    player.seek(Math.max(0, ms));
    refresh();
    for (const listener of [...seekListeners]) listener(ms);
  }

  function seek(ms: number): void {
    setClip(null);
    moveTo(ms);
  }

  /** The picture is what the user wants to see when a preview starts: bring it into view once, only when it is off screen. */
  function showPreview(): void {
    (previewSlot.hasChildNodes() ? previewSlot : el).scrollIntoView({ block: "nearest" });
  }

  function playClip(range: Range, aspect: Aspect): void {
    setClip(null);
    moveTo(range.s);
    const mine: ClipPlayback = { range, aspect };
    setClip(mine);
    showPreview();
    void audio.play().catch(() => {
      if (clip === mine) setClip(null);
    });
  }

  function stopClip(): void {
    if (!clip) return;
    setClip(null);
    audio.pause();
  }

  function playFromStart(): void {
    setClip(null);
    moveTo(0);
    showPreview();
    void audio.play().catch(() => undefined);
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
  // a pause by the user (or the end of the recording) ends a clip preview; the end of the clip itself is handled in `refresh`
  audio.addEventListener("pause", () => setClip(null));
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
    onSeek(listener) {
      seekListeners.add(listener);
      return () => seekListeners.delete(listener);
    },
    playClip,
    stopClip,
    onClip(listener) {
      clipListeners.add(listener);
      listener(clip);
      return () => clipListeners.delete(listener);
    },
    playFromStart,
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
      setClip(null);
      clipListeners.clear();
      seekListeners.clear();
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
