import { isRemoved, keepOnly, removeRange, restoreRange, wordSpanRange, type Range } from "../../shared/edl.js";
import type { JobRecord, ProjectFile } from "../../shared/project.js";
import { searchWords, type TranscriptFile } from "../../shared/transcript.js";
import { h } from "../lib/dom.js";
import { isTyping } from "../lib/keys.js";
import type { ProjectApi } from "../lib/project-api.js";
import { formatDuration } from "../lib/storage-math.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { cutPreview } from "./cut-preview.js";
import { silencePanel } from "./silence-panel.js";
import type { Stage } from "./stage.js";

const TURN_GAP_MS = 2500;

/** Index of the last word that starts at or before `ms` (-1 before the first). */
export function wordAt(starts: number[], ms: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] as number) <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export interface PanelHooks {
  /** Runs a call that changes the project: shows its error and refreshes the page's state. */
  run: (action: () => Promise<unknown>) => Promise<void>;
}

export interface TranscriptPanel {
  el: HTMLElement;
  /** The page's latest job list (for the preview render). */
  update: (jobs: JobRecord[]) => void;
  dispose: () => void;
}

/** The transcript as the cutting tool: select words to delete, keep or restore them, search, highlights, silences, preview render, exports. */
export function transcriptPanel(api: ProjectApi, stg: Stage, project: ProjectFile, transcript: TranscriptFile, hooks: PanelHooks): TranscriptPanel {
  const words = transcript.words;
  const starts = words.map((word) => word.s);
  const duration = stg.durationMs;
  const names = new Map(transcript.speakers.map((speaker) => [speaker.pid, speaker.name]));
  const { edit, audio, tl } = stg;
  const seek = (ms: number): void => stg.seek(ms);

  // ---- transcript text -------------------------------------------------------------------------------------------
  const spans: HTMLElement[] = [];
  const body = h("div", { class: "transcript", "data-testid": "pj-transcript", lang: transcript.lang });
  let turn: HTMLElement | null = null;
  let lastPid = "";
  let lastEnd = 0;
  words.forEach((word, index) => {
    if (!turn || word.pid !== lastPid || word.s - lastEnd > TURN_GAP_MS) {
      const head = h("button", { type: "button", class: "turn-head", onclick: () => seek(word.s) }, `${names.get(word.pid) ?? word.pid} · ${formatDuration(word.s / 1000)}`);
      turn = h("p", { class: "turn" }, head);
      body.append(turn);
    }
    const span = h("span", { class: "w", "data-i": index }, word.t);
    spans.push(span);
    turn.append(span, " ");
    lastPid = word.pid;
    lastEnd = word.e;
  });

  // the word being played is marked and followed while playing
  let current = -1;
  const markPlaying = (ms: number): void => {
    const index = wordAt(starts, ms);
    const inside = index >= 0 && ms <= (words[index]?.e ?? 0) + 400 ? index : -1;
    if (inside === current) return;
    spans[current]?.classList.remove("now");
    current = inside;
    const span = spans[current];
    if (span) {
      span.classList.add("now");
      if (!audio.paused) span.scrollIntoView({ block: "nearest" });
    }
  };
  const stopFollowing = stg.onTick(markPlaying);

  // ---- selection of words ----------------------------------------------------------------------------------------------
  let selFirst = -1;
  let selLast = -1;
  let anchor = -1;
  let dragFrom = -1;
  const selInfo = h("span", { class: "hint", "data-testid": "pj-ed-selinfo" });
  const deleteButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-delete", onclick: () => deleteSelection() }, t("pj.ed.delete"));
  const keepButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-keep", onclick: () => keepSelection() }, t("pj.ed.keep"));
  const restoreButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ed-restore", onclick: () => restoreSelection() }, t("pj.ed.restore"));

  /** The span of the timeline the selected words stand for: cuts go through the middle of the pauses around them. */
  const selectedRange = (): Range | null => (selFirst < 0 ? null : wordSpanRange(words, selFirst, selLast, duration));

  function showSelection(): void {
    const range = selectedRange();
    tl.setSelection(range);
    const none = range === null;
    deleteButton.disabled = none;
    keepButton.disabled = none;
    restoreButton.disabled = none;
    selInfo.textContent = range ? t("pj.ed.selection", { count: selLast - selFirst + 1, time: formatClock(range.e - range.s) }) : t("pj.ed.noSelection");
  }

  function setSelection(first: number, last: number): void {
    if (first === selFirst && last === selLast) return;
    for (let i = selFirst; i >= 0 && i <= selLast; i++) spans[i]?.classList.remove("sel");
    selFirst = first;
    selLast = last;
    for (let i = selFirst; i >= 0 && i <= selLast; i++) spans[i]?.classList.add("sel");
    showSelection();
  }

  const clearSelection = (): void => {
    anchor = -1;
    setSelection(-1, -1);
  };

  const wordIndex = (target: EventTarget | null): number => {
    const span = target instanceof Element ? target.closest(".w") : null;
    return span instanceof HTMLElement ? Number(span.dataset.i) : -1;
  };

  // Click selects one word and plays from it; shift-click extends from the last click; dragging over words selects the stretch.
  body.addEventListener("mousedown", (event) => {
    const index = wordIndex(event.target);
    if (event.button !== 0 || index < 0) return;
    if (event.shiftKey && anchor >= 0) {
      event.preventDefault();
      setSelection(Math.min(anchor, index), Math.max(anchor, index));
      return;
    }
    anchor = index;
    dragFrom = index;
    setSelection(index, index);
  });
  body.addEventListener("mouseover", (event) => {
    const index = wordIndex(event.target);
    if (dragFrom >= 0 && index >= 0) setSelection(Math.min(dragFrom, index), Math.max(dragFrom, index));
  });
  const onMouseUp = (): void => {
    if (dragFrom < 0) return;
    dragFrom = -1;
    if (selFirst >= 0) seek(words[selFirst]?.s ?? 0);
  };
  window.addEventListener("mouseup", onMouseUp);

  // ---- cutting -------------------------------------------------------------------------------------------------------------
  function deleteSelection(): void {
    const range = selectedRange();
    if (range) edit.apply(removeRange(edit.edl, range, duration));
  }
  function keepSelection(): void {
    const range = selectedRange();
    if (range) edit.apply(keepOnly([range], duration));
  }
  function restoreSelection(): void {
    const range = selectedRange();
    if (range) edit.apply(restoreRange(edit.edl, range));
  }

  // a word is struck through when the middle of it is removed, so a word a cut only grazes stays plain
  const cut = new Array<boolean>(words.length).fill(false);
  let shownRemoved: Range[] | null = null;
  function onEdit(): void {
    if (edit.edl.removed === shownRemoved) return;
    shownRemoved = edit.edl.removed;
    words.forEach((word, index) => {
      const removed = isRemoved(edit.edl, (word.s + word.e) / 2);
      if (removed !== cut[index]) {
        cut[index] = removed;
        spans[index]?.classList.toggle("cut", removed);
      }
    });
  }
  const unsubscribe = edit.subscribe(onEdit);

  // Delete removes the selected words and Escape drops the selection; the undo shortcuts belong to the stage.
  const onKey = (event: KeyboardEvent): void => {
    if (isTyping(event.target)) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "Delete" || event.key === "Backspace") && selFirst >= 0) {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === "Escape" && selFirst >= 0) {
      clearSelection();
    }
  };
  document.addEventListener("keydown", onKey);

  // ---- search, highlights, exports --------------------------------------------------------------------------------------
  let hits: number[] = [];
  let hitPos = -1;
  const count = h("span", { class: "hint", "data-testid": "pj-search-count" });
  const input = h("input", { type: "search", class: "input", "data-testid": "pj-search", placeholder: t("pj.tr.search"), "aria-label": t("pj.tr.search") });
  const gotoHit = (step: number): void => {
    if (hits.length === 0) return;
    hitPos = (hitPos + step + hits.length) % hits.length;
    const index = hits[hitPos] as number;
    spans[index]?.scrollIntoView({ block: "center" });
    seek(words[index]?.s ?? 0);
    count.textContent = t("pj.tr.hit", { n: hitPos + 1, total: hits.length });
  };
  input.addEventListener("input", () => {
    for (const hit of hits) spans[hit]?.classList.remove("hit");
    hits = searchWords(words, input.value);
    hitPos = -1;
    for (const hit of hits) spans[hit]?.classList.add("hit");
    count.textContent = input.value.trim() === "" ? "" : hits.length === 0 ? t("pj.tr.nohit") : t("pj.tr.hits", { total: hits.length });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") gotoHit(event.shiftKey ? -1 : 1);
  });

  const withSpeakers = h("input", { type: "checkbox", checked: true, "data-testid": "pj-tr-speakers" });
  const link = (format: "srt" | "vtt" | "txt"): HTMLElement => {
    const anchorEl = h("a", { class: "btn btn-small", href: api.transcriptUrl(format, true), download: `transcript.${format}`, "data-testid": `pj-export-${format}` }, format.toUpperCase());
    withSpeakers.addEventListener("change", () => anchorEl.setAttribute("href", api.transcriptUrl(format, withSpeakers.checked)));
    return anchorEl;
  };

  const chips = project.highlights.map((highlight) =>
    h("button", { type: "button", class: "chip", "data-testid": "pj-highlight", title: highlight.participantName, onclick: () => seek(highlight.atMs) }, formatDuration(highlight.atMs / 1000)),
  );

  // ---- parts that live in their own modules ----------------------------------------------------------------------------
  const silences = silencePanel(api, edit, (range) => stg.player.previewCut(range));
  const preview = cutPreview(api, edit, () => hooks.run(() => api.startJob("cut-preview")));

  const el = h(
    "div",
    { class: "stack" },
    h("div", { class: "row editor-toolbar", role: "toolbar", "aria-label": t("pj.ed.title") }, deleteButton, keepButton, restoreButton, selInfo),
    h("p", { class: "hint" }, t("pj.ed.hint")),
    h("div", { class: "row" }, input, h("button", { type: "button", class: "btn btn-small", onclick: () => gotoHit(-1) }, "↑"), h("button", { type: "button", class: "btn btn-small", onclick: () => gotoHit(1) }, "↓"), count),
    chips.length > 0 ? h("div", { class: "row" }, h("span", { class: "hint" }, t("pj.tr.highlights")), ...chips) : null,
    body,
    h("section", { class: "ed-block" }, silences.el),
    h("section", { class: "ed-block" }, preview.el),
    h("div", { class: "row" }, h("label", { class: "check" }, withSpeakers, t("pj.tr.speakers")), link("srt"), link("vtt"), link("txt")),
    h("p", { class: "hint" }, t("pj.tr.meta", { engine: transcript.engine, model: transcript.model, lang: transcript.lang, words: words.length, dropped: transcript.bleedDropped })),
  );

  showSelection();
  onEdit();
  markPlaying(audio.currentTime * 1000);

  return {
    el,
    update: (jobs) => preview.update(jobs),
    dispose: () => {
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKey);
      stopFollowing();
      unsubscribe();
      silences.dispose();
      preview.dispose();
      tl.setSelection(null);
      el.replaceChildren();
    },
  };
}
