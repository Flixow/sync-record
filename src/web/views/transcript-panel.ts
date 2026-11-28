import { isRemoved, keepOnly, removeRange, restoreRange, wordSpanRange, type Range } from "../../shared/edl.js";
import type { JobRecord, ProjectFile } from "../../shared/project.js";
import { searchWords, type TranscriptFile } from "../../shared/transcript.js";
import { h } from "../lib/dom.js";
import { FollowState, followTarget, scrollTopFor, type ScrollBox } from "../lib/follow-scroll.js";
import { isTyping } from "../lib/keys.js";
import type { ProjectApi } from "../lib/project-api.js";
import { formatDuration } from "../lib/storage-math.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { cutPreview } from "./cut-preview.js";
import { silencePanel } from "./silence-panel.js";
import type { Stage } from "./stage.js";

const TURN_GAP_MS = 2500;
/** Keys with which the user scrolls a focused column. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);
/** A press this close to the right edge of the column is taken for one on its scrollbar. */
const SCROLLBAR_ZONE_PX = 18;
/** The room the "Follow playback" button takes over the bottom of the column. */
const FOLLOW_BUTTON_ROOM_PX = 16;
/** A word found by a search is put in the middle of the column. */
const CENTER = 0.5;

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

/**
 * The transcript as the cutting tool, in a column of its own that scrolls by itself (never the page): select words to
 * delete, keep or restore them, search, highlights, and, folded away, silences, the preview render and the exports.
 * The column follows the playing word until the user scrolls it; a button and any seek bring the following back.
 */
export function transcriptPanel(api: ProjectApi, stg: Stage, project: ProjectFile, transcript: TranscriptFile, hooks: PanelHooks): TranscriptPanel {
  const words = transcript.words;
  const starts = words.map((word) => word.s);
  const duration = stg.durationMs;
  const names = new Map(transcript.speakers.map((speaker) => [speaker.pid, speaker.name]));
  const { edit, audio, tl } = stg;
  // A seek from a click on the words stays quiet: the word is under the cursor, so the text must not move away from it.
  let quietSeek = false;
  const seekFromWord = (ms: number): void => {
    quietSeek = true;
    try {
      stg.seek(ms);
    } finally {
      quietSeek = false;
    }
  };

  // ---- transcript text -------------------------------------------------------------------------------------------
  const spans: HTMLElement[] = [];
  const body = h("div", { class: "transcript", "data-testid": "pj-transcript", lang: transcript.lang });
  let turn: HTMLElement | null = null;
  let lastPid = "";
  let lastEnd = 0;
  words.forEach((word, index) => {
    if (!turn || word.pid !== lastPid || word.s - lastEnd > TURN_GAP_MS) {
      const turnHead = h("button", { type: "button", class: "turn-head", onclick: () => seekFromWord(word.s) }, `${names.get(word.pid) ?? word.pid} · ${formatDuration(word.s / 1000)}`);
      turn = h("p", { class: "turn" }, turnHead);
      body.append(turn);
    }
    const span = h("span", { class: "w", "data-i": index }, word.t);
    spans.push(span);
    turn.append(span, " ");
    lastPid = word.pid;
    lastEnd = word.e;
  });

  // ---- following the playing word, inside the column and nowhere else ----------------------------------------------------
  // The page never scrolls from here: the column's own scrollTop is set, so the user's scrolling of the page is not fought.
  const follow = new FollowState(performance.now());
  /** Index of the last word at or before the playhead (-1 before the first). */
  let nearest = -1;
  /** The scroll position this panel set last; a scroll event that lands elsewhere came from the user. */
  let ownTop = 0;
  const followButton = h("button", { type: "button", class: "btn btn-small btn-primary tr-follow", "data-testid": "pj-tr-follow", hidden: true, onclick: () => resumeFollowing() }, t("prev.tr.follow"));
  const syncFollowButton = (): void => {
    followButton.hidden = follow.active || audio.paused;
  };

  /** Scrolls the column so that word `index` sits where `pick` says (null: leave it). */
  function scrollWord(index: number, pick: (box: ScrollBox, wordTop: number, wordHeight: number) => number | null): void {
    const span = spans[index];
    if (!span || el.clientHeight === 0) return;
    const column = el.getBoundingClientRect();
    const rect = span.getBoundingClientRect();
    const box: ScrollBox = {
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      topInset: controls.offsetHeight,
      bottomInset: followButton.hidden ? 0 : followButton.offsetHeight + FOLLOW_BUTTON_ROOM_PX,
    };
    const target = pick(box, rect.top - column.top - el.clientTop + el.scrollTop, rect.height);
    if (target === null) return;
    el.scrollTop = target;
    ownTop = el.scrollTop;
  }
  const followWord = (index: number): void => scrollWord(index, followTarget);

  function resumeFollowing(): void {
    follow.resume();
    syncFollowButton();
    followWord(nearest);
  }

  // the word being played is marked, and followed while the user has not scrolled the column away
  let current = -1;
  const markPlaying = (ms: number): void => {
    nearest = wordAt(starts, ms);
    const inside = nearest >= 0 && ms <= (words[nearest]?.e ?? 0) + 400 ? nearest : -1;
    if (inside === current) return;
    spans[current]?.classList.remove("now");
    current = inside;
    const span = spans[current];
    if (!span) return;
    span.classList.add("now");
    if (follow.active && !audio.paused && dragFrom < 0) followWord(current);
  };
  const stopFollowing = stg.onTick(markPlaying);
  // a seek anywhere (timeline, scene list, clip) takes the column to the playhead; one from a click on the words leaves it be
  const stopSeekWatch = stg.onSeek(() => {
    follow.resume();
    syncFollowButton();
    if (!quietSeek) followWord(nearest);
  });
  const onPlay = (): void => {
    follow.played(performance.now());
    syncFollowButton();
    if (follow.active) followWord(nearest);
  };
  const onPause = (): void => {
    follow.paused(performance.now());
    syncFollowButton();
  };
  audio.addEventListener("play", onPlay);
  audio.addEventListener("pause", onPause);

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
    if (selFirst >= 0) seekFromWord(words[selFirst]?.s ?? 0);
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
    scrollWord(index, (box, wordTop, wordHeight) => scrollTopFor(box, wordTop, wordHeight, CENTER));
    seekFromWord(words[index]?.s ?? 0);
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
    h("button", { type: "button", class: "chip", "data-testid": "pj-highlight", title: highlight.participantName, onclick: () => stg.seek(highlight.atMs) }, formatDuration(highlight.atMs / 1000)),
  );

  // ---- parts that live in their own modules ----------------------------------------------------------------------------
  const silences = silencePanel(api, edit, (range) => stg.player.previewCut(range));
  const preview = cutPreview(api, edit, () => hooks.run(() => api.startJob("cut-preview")));

  // the controls stay at the top of the column while the text scrolls under them
  const controls = h(
    "div",
    { class: "tr-head" },
    h("div", { class: "row editor-toolbar", role: "toolbar", "aria-label": t("pj.ed.title") }, deleteButton, keepButton, restoreButton, selInfo),
    h(
      "div",
      { class: "row tr-search" },
      input,
      h("button", { type: "button", class: "btn btn-small", "aria-label": t("pj.tr.prev"), title: t("pj.tr.prev"), onclick: () => gotoHit(-1) }, "↑"),
      h("button", { type: "button", class: "btn btn-small", "aria-label": t("pj.tr.next"), title: t("pj.tr.next"), onclick: () => gotoHit(1) }, "↓"),
      count,
    ),
  );
  const tools = h(
    "details",
    { class: "tr-tools", "data-testid": "pj-tr-tools" },
    h("summary", {}, t("prev.tr.tools")),
    h(
      "div",
      { class: "stack" },
      h("section", { class: "ed-block" }, silences.el),
      h("section", { class: "ed-block" }, preview.el),
      h("div", { class: "row" }, h("label", { class: "check" }, withSpeakers, t("pj.tr.speakers")), link("srt"), link("vtt"), link("txt")),
      h("p", { class: "hint" }, t("pj.tr.meta", { engine: transcript.engine, model: transcript.model, lang: transcript.lang, words: words.length, dropped: transcript.bleedDropped })),
    ),
  );
  const el = h(
    "div",
    { class: "stack tr-column", role: "region", "aria-label": t("pj.tr.title"), "data-testid": "pj-tr-column" },
    controls,
    h("p", { class: "hint" }, t("pj.ed.hint")),
    chips.length > 0 ? h("div", { class: "row" }, h("span", { class: "hint" }, t("pj.tr.highlights")), ...chips) : null,
    tools,
    body,
    followButton,
  );

  // the user's own scrolling of the column (wheel, touch, keys, scrollbar) switches the following off
  const userScrolled = (): void => {
    follow.userScrolled();
    syncFollowButton();
  };
  el.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) userScrolled();
  }, { passive: true });
  el.addEventListener("touchmove", userScrolled, { passive: true });
  el.addEventListener("keydown", (event) => {
    if (SCROLL_KEYS.has(event.key) && !isTyping(event.target)) userScrolled();
  });
  el.addEventListener("pointerdown", (event) => {
    if (event.target === el && event.clientX > el.getBoundingClientRect().right - SCROLLBAR_ZONE_PX) userScrolled();
  });
  // a scrollbar that draws over the content (macOS) gives no press to see: a scroll that is not ours is the user's
  el.addEventListener("scroll", () => {
    if (Math.abs(el.scrollTop - ownTop) > 2) userScrolled();
  }, { passive: true });

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
      stopSeekWatch();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      unsubscribe();
      silences.dispose();
      preview.dispose();
      tl.setSelection(null);
      el.replaceChildren();
    },
  };
}
