import { adjustClip, clipText, DEFAULT_CLIP_LIMIT, REASON_TEXT, wordStep, type ClipProject, type ClipSuggestion } from "../../shared/clips.js";
import type { Range } from "../../shared/edl.js";
import { trimTo } from "../../shared/lexicon.js";
import { presetById } from "../../shared/presets.js";
import type { JobRecord } from "../../shared/project.js";
import type { TranscriptFile } from "../../shared/transcript.js";
import { ApiError } from "../lib/api.js";
import { h, setChildren } from "../lib/dom.js";
import type { ClipsFile, ClipSuggestions, ProjectApi, ProjectState } from "../lib/project-api.js";
import { formatClock } from "../lib/time.js";
import { getLang, t } from "../i18n/index.js";
import { captionStyleSelect } from "./caption-style-select.js";
import { failureBanner, progressBar, stageLabel } from "./job-status.js";
import { banner } from "./layout.js";
import { formatSelect } from "./preset-select.js";
import type { ClipPlayback } from "./stage.js";

const ACTIVE = new Set(["queued", "running"]);
/** A clip is meant for a vertical feed; a recording without picture gets the audio format instead. */
const CLIP_PRESET = "vertical-1080p30";
const AUDIO_CLIP_PRESET = "audio-mp3";
const DEFAULT_CAPTIONS = "clean";
/** The longest excerpt on a card, in characters. */
const EXCERPT_CHARS = 360;

export interface ClipsPanelHooks {
  /** Runs a call that changes the project: shows its error and refreshes the page's state. */
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Previews a stretch of the recording as a short (vertical, as it will be rendered) on the page's player. */
  play: (range: Range) => void;
  /** Stops the preview that `play` started. */
  stop?: () => void;
  /** Reports the preview that plays now (null: none), at once and on every change; returns the way to stop listening. */
  onPlaying?: (listener: (clip: ClipPlayback | null) => void) => () => void;
}

export interface ClipsPanel {
  el: HTMLElement;
  /** The page's latest state: the render jobs, the transcript status and whether the media are there. */
  update(state: ProjectState): void;
  dispose(): void;
}

/** The newest render job of a clip. */
const clipJob = (jobs: JobRecord[], id: string): JobRecord | undefined => jobs.filter((job) => job.kind === "render" && job.params.clip === id).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];

/**
 * Clips: suggestions with the reason each was picked, in and out points that move word by word, saving a suggestion as a
 * clip and rendering a saved clip on its own. The suggestions stay on screen across the page's refreshes.
 */
export function clipsPanel(api: ProjectApi, hooks: ClipsPanelHooks): ClipsPanel {
  let state: ProjectState | null = null;
  let transcript: TranscriptFile | null = null;
  let saved: ClipsFile = { schemaVersion: 1, rev: 0, updatedAtMs: 0, clips: [] };
  let suggestions: ClipSuggestion[] = [];
  let cards: HTMLElement[] = [];
  let note: HTMLElement | null = null;
  let source: ClipSuggestions["source"] = "rule";
  let searching = false;
  let suggested = false;
  let playable = false;
  /** The preview that plays on the page's player now. */
  let playing: ClipPlayback | null = null;
  let stopWatching: (() => void) | null = null;
  let initialised = false;
  let disposed = false;
  let savedSignature = "";
  /** The captions style chosen for each saved clip; it is a choice of the next render, not part of the clip. */
  const captionChoice = new Map<string, string>();

  const llmToggle = h("input", { type: "checkbox", "data-testid": "pj-cl-llm" });
  const llmHint = h("span", { class: "hint ex-hint", "data-testid": "pj-cl-llm-hint" }, t("pj.cl.llm.hint"));
  const suggestButton = h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-cl-suggest", onclick: () => suggest() }, t("pj.cl.suggest"));
  const needTranscript = h("p", { class: "hint", "data-testid": "pj-cl-need-transcript", hidden: true }, t("pj.cl.needTranscript"));
  const suggestionsHost = h("div", { class: "stack", "data-testid": "pj-cl-suggestions" });
  const conflictHost = h("div");
  const savedHost = h("div", { class: "stack", "data-testid": "pj-cl-saved" });
  /** What a short is and what the preview shows; only for a recording with picture, where the clips become vertical videos. */
  const explain = h("p", { class: "clip-explain", "data-testid": "pj-cl-explain", hidden: true }, t("prev.cl.explain"));

  const hasVideo = (): boolean => state?.project.sources.some((source) => source.hasVideo && source.kind !== "audio") ?? false;

  // ---- previewing a stretch as a short ------------------------------------------------------------------------------------
  const isPlaying = (range: Range): boolean => playing !== null && playing.range.s === range.s && playing.range.e === range.e;

  function paintPreview(button: HTMLElement): void {
    const on = isPlaying({ s: Number(button.dataset.previewS), e: Number(button.dataset.previewE) });
    button.textContent = on ? t("prev.cl.stop") : hasVideo() ? t("prev.cl.preview") : t("pj.cl.play");
    button.dataset.state = on ? "playing" : "idle";
  }
  const paintPreviews = (): void => {
    for (const button of el.querySelectorAll<HTMLElement>("[data-preview-s]")) paintPreview(button);
  };

  function startPreview(range: Range): void {
    hooks.play(range);
    stopWatching?.();
    stopWatching =
      hooks.onPlaying?.((clip) => {
        playing = clip;
        paintPreviews();
      }) ?? null;
  }

  /** The button that previews a stretch as a short, and stops it while it plays. */
  function previewButton(testId: string, clip: Range): HTMLButtonElement {
    // only the two ends go to the page's player, not the card they come from
    const range: Range = { s: clip.s, e: clip.e };
    const button = h("button", {
      type: "button",
      class: "btn btn-small",
      "data-testid": testId,
      "data-preview-s": String(range.s),
      "data-preview-e": String(range.e),
      disabled: !playable,
      title: playable ? undefined : t("pj.cl.noMedia"),
      onclick: () => (isPlaying(range) ? hooks.stop?.() : startPreview(range)),
    });
    paintPreview(button);
    return button;
  }

  // ---- rendering a saved clip ---------------------------------------------------------------------------------------------
  const captionStyleOf = (clip: ClipProject): string => captionChoice.get(clip.id) ?? (state?.project.transcript.status === "done" ? DEFAULT_CAPTIONS : "off");

  function startRender(clip: ClipProject, captionStyle: string): void {
    const video = presetById(clip.preset)?.kind === "video";
    void hooks.run(() => api.startJob("render", { preset: clip.preset, ...(video ? { captions: captionStyle === "off" ? false : { style: captionStyle } } : {}), range: { s: clip.s, e: clip.e }, clip: clip.id }));
  }

  function jobNote(job: JobRecord): string {
    if (ACTIVE.has(job.status)) return t("pj.cl.progress", { percent: Math.round(job.progress * 100), stage: stageLabel(job.stage) });
    if (job.status === "done") return t("pj.cl.done");
    if (job.status === "failed") return t("pj.cl.failed");
    return job.status === "canceled" ? t("pj.cl.canceled") : "";
  }

  /** Keeps the render button and the status line of the suggestion cards that were saved in step with the render jobs, without redrawing the cards. */
  function syncCardRenders(): void {
    const jobs = state?.jobs ?? [];
    const rendering = jobs.some((job) => job.kind === "render" && ACTIVE.has(job.status));
    for (const button of suggestionsHost.querySelectorAll<HTMLButtonElement>('button[data-testid="pj-cl-card-render"]')) {
      const clip = saved.clips.find((item) => item.id === button.dataset.clip);
      button.disabled = rendering || (clip !== undefined && presetById(clip.preset)?.kind === "video" && !hasVideo());
    }
    for (const line of suggestionsHost.querySelectorAll<HTMLElement>('[data-testid="pj-cl-card-status"]')) {
      const job = clipJob(jobs, line.dataset.clip ?? "");
      line.textContent = job ? jobNote(job) : "";
    }
  }

  function suggest(): void {
    searching = true;
    suggestButton.disabled = true;
    renderSuggestions();
    void hooks.run(async () => {
      try {
        const [result, file] = await Promise.all([api.suggestClips(DEFAULT_CLIP_LIMIT, llmToggle.checked), api.transcript()]);
        transcript = file;
        suggestions = result.suggestions;
        source = result.source;
        suggested = true;
        const llm = result.llmUsed ? "used" : result.llmAvailable ? "failed" : "unavailable";
        note = llmToggle.checked ? banner(llm === "used" ? "info" : "warn", t(`pj.cl.llm.${llm}`), "pj-cl-llm-note") : null;
        note?.setAttribute("data-state", llm);
        if (result.llmFailure !== null) note?.setAttribute("data-failure", result.llmFailure);
      } finally {
        searching = false;
        if (!disposed) {
          suggestButton.disabled = state?.project.transcript.status !== "done";
          renderSuggestions();
        }
      }
    });
  }

  /** Moves the in or out point of a suggestion by words and redraws only its card, keeping the keyboard focus on the button. */
  function nudge(index: number, edge: "s" | "e", steps: number, focusId: string): void {
    const clip = suggestions[index];
    const old = cards[index];
    if (!clip || !old || !transcript) return;
    suggestions[index] = adjustClip(clip, transcript.words, wordStep(clip, transcript.words, edge, steps));
    const next = buildCard(index);
    old.replaceWith(next);
    syncCardRenders();
    next.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
  }

  function buildCard(index: number): HTMLElement {
    const clip = suggestions[index] as ClipSuggestion;
    const names = new Map((state?.project.participants ?? []).map((participant) => [participant.id, participant.name]));
    const nameOf = (pid: string): string => names.get(pid) ?? pid;
    const savedClip = saved.clips.find((item) => item.id === clip.id);
    const excerpt = transcript ? clipText(transcript.words, clip, nameOf) : "";
    const step = (testId: string, edge: "s" | "e", steps: number, label: string): HTMLButtonElement => {
      const visible = steps < 0 ? t("pj.cl.wordEarlier") : t("pj.cl.wordLater");
      return h("button", { type: "button", class: "btn btn-small", "data-testid": testId, "aria-label": `${visible}: ${label}`, title: label, onclick: () => nudge(index, edge, steps, testId) }, visible);
    };
    const el = h(
      "article",
      { class: "clip-card", "data-testid": "pj-cl-card", "data-id": clip.id, "data-start": String(clip.s), "data-end": String(clip.e) },
      h("h4", {}, clip.title),
      clip.hook ? h("p", { class: "clip-hook", "data-testid": "pj-cl-hook" }, `“${clip.hook}”`) : null,
      clip.why ? h("p", { class: "hint", "data-testid": "pj-cl-why" }, clip.why) : null,
      h(
        "p",
        { class: "hint", "data-testid": "pj-cl-range" },
        [t("pj.cl.range", { start: formatClock(clip.s), end: formatClock(clip.e), length: formatClock(clip.e - clip.s) }), clip.speakers.length > 0 ? t("pj.cl.speakers", { names: clip.speakers.map(nameOf).join(", ") }) : ""].filter(Boolean).join(" · "),
      ),
      h("ul", { class: "clip-reasons", "aria-label": t("pj.cl.why") }, ...clip.reasons.map((key) => h("li", { "data-reason": key }, REASON_TEXT[key]?.[getLang()] ?? key))),
      excerpt ? h("blockquote", { class: "clip-text", "data-testid": "pj-cl-text" }, trimTo(excerpt, EXCERPT_CHARS)) : null,
      h(
        "div",
        { class: "row clip-nudge" },
        h("span", { class: "hint" }, t("pj.cl.in")),
        step("pj-cl-in-earlier", "s", -1, t("pj.cl.inEarlier")),
        step("pj-cl-in-later", "s", 1, t("pj.cl.inLater")),
        h("span", { class: "hint" }, t("pj.cl.out")),
        step("pj-cl-out-earlier", "e", -1, t("pj.cl.outEarlier")),
        step("pj-cl-out-later", "e", 1, t("pj.cl.outLater")),
      ),
      h(
        "div",
        { class: "row" },
        previewButton("pj-cl-play", clip),
        h("button", { type: "button", class: savedClip ? "btn btn-small" : "btn btn-small btn-primary", "data-testid": "pj-cl-save", disabled: savedClip !== undefined, onclick: () => saveSuggestion(clip) }, savedClip ? t("pj.cl.savedOne") : t("pj.cl.save")),
        savedClip
          ? h("button", { type: "button", class: "btn btn-small btn-primary", "data-testid": "pj-cl-card-render", "data-clip": savedClip.id, onclick: () => startRender(savedClip, captionStyleOf(savedClip)) }, t("pj.cl.render"))
          : null,
        savedClip ? h("span", { class: "hint", "data-testid": "pj-cl-card-status", "data-clip": savedClip.id }) : null,
      ),
    );
    cards[index] = el;
    return el;
  }

  function renderSuggestions(): void {
    cards = [];
    setChildren(
      suggestionsHost,
      searching ? h("p", { class: "hint", "data-testid": "pj-cl-searching" }, t("pj.cl.suggesting")) : null,
      note,
      suggested && !searching ? h("h4", {}, t("pj.cl.found", { count: suggestions.length })) : null,
      suggested && !searching && suggestions.length > 0 ? h("p", { class: "hint", "data-testid": "pj-cl-source", "data-source": source }, t(`pj.cl.source.${source}`)) : null,
      suggested && !searching && suggestions.length === 0 ? h("p", { class: "hint", "data-testid": "pj-cl-none" }, t("pj.cl.none")) : null,
      ...(searching ? [] : suggestions.map((_, index) => buildCard(index))),
    );
    syncCardRenders();
  }

  /** Saves the clip list on the revision the page knows; a list that changed in another window is loaded instead. */
  async function persist(clips: ClipProject[]): Promise<void> {
    setChildren(conflictHost);
    try {
      saved = await api.saveClips(saved.rev, clips);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "clips_conflict") throw error;
      saved = await api.clips();
      setChildren(conflictHost, banner("warn", t("pj.cl.conflict"), "pj-cl-conflict"));
    } finally {
      if (!disposed) {
        renderSaved();
        renderSuggestions();
      }
    }
  }

  function saveSuggestion(clip: ClipSuggestion): void {
    const preset = hasVideo() ? CLIP_PRESET : AUDIO_CLIP_PRESET;
    void hooks.run(() => persist([...saved.clips, { id: clip.id, parentSid: api.sid, s: clip.s, e: clip.e, preset, name: clip.title }]));
  }

  function savedRow(clip: ClipProject): HTMLElement {
    const jobs = state?.jobs ?? [];
    const video = presetById(clip.preset)?.kind === "video";
    const transcriptReady = state?.project.transcript.status === "done";
    const rendering = jobs.some((job) => job.kind === "render" && ACTIVE.has(job.status));
    const job = clipJob(jobs, clip.id);

    const preset = formatSelect("pj-cl-preset", t("pj.cl.preset"));
    for (const option of preset.options) option.disabled = option.dataset.kind === "video" && !hasVideo();
    preset.value = clip.preset;
    preset.addEventListener("change", () => void hooks.run(() => persist(saved.clips.map((item) => (item.id === clip.id ? { ...item, preset: preset.value } : item)))));
    const captions = captionStyleSelect("pj-cl-captions", t("pj.cl.captions"), t("pj.cl.captions.off"));
    captions.value = captionStyleOf(clip);
    captions.disabled = !video || !transcriptReady;
    captions.addEventListener("change", () => captionChoice.set(clip.id, captions.value));

    let status: Node | null = null;
    if (job && ACTIVE.has(job.status)) {
      const percent = Math.round(job.progress * 100);
      const stage = stageLabel(job.stage);
      status = h(
        "div",
        { class: "stack" },
        progressBar(percent, t("pj.cl.render"), job.stage),
        h("p", { class: "hint", "data-testid": "pj-cl-progress", "data-status": job.status }, t("pj.cl.progress", { percent, stage })),
        h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-cl-cancel", onclick: () => void hooks.run(() => api.cancelJob(job.id)) }, t("pj.cancel")),
      );
    } else if (job?.status === "done") status = h("p", { class: "hint", "data-testid": "pj-cl-done" }, t("pj.cl.done"));
    else if (job?.status === "failed") status = failureBanner("pj.cl.failed", job.error, "pj-cl-failed");
    else if (job?.status === "canceled") status = h("p", { class: "hint", "data-testid": "pj-cl-canceled" }, t("pj.cl.canceled"));

    return h(
      "li",
      { class: "clip-row stack", "data-testid": "pj-cl-row", "data-id": clip.id },
      h("div", { class: "row" }, h("strong", {}, clip.name), h("span", { class: "hint" }, t("pj.cl.range", { start: formatClock(clip.s), end: formatClock(clip.e), length: formatClock(clip.e - clip.s) }))),
      h(
        "div",
        { class: "row" },
        h("div", { class: "field" }, h("span", {}, t("pj.cl.preset")), preset),
        h("div", { class: "field" }, h("span", {}, t("pj.cl.captions")), captions),
        previewButton("pj-cl-row-play", clip),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small btn-primary",
            "data-testid": "pj-cl-render",
            disabled: rendering || (video && !hasVideo()),
            onclick: () => startRender(clip, captions.value),
          },
          t("pj.cl.render"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "data-testid": "pj-cl-delete",
            onclick: () => {
              if (confirm(t("pj.cl.deleteConfirm"))) void hooks.run(() => persist(saved.clips.filter((item) => item.id !== clip.id)));
            },
          },
          t("pj.cl.delete"),
        ),
      ),
      status,
    );
  }

  /** What the saved list depends on besides the clips: the clips' render jobs and the state of the media and the transcript. */
  function signature(): string {
    const jobs = state?.jobs ?? [];
    return JSON.stringify([
      saved.rev,
      jobs.filter((job) => job.kind === "render" && typeof job.params.clip === "string").map((job) => [job.id, job.status, Math.round(job.progress * 100), job.stage]),
      jobs.some((job) => job.kind === "render" && ACTIVE.has(job.status)),
      hasVideo(),
      playable,
      state?.project.transcript.status,
    ]);
  }

  function renderSaved(): void {
    savedSignature = signature();
    setChildren(
      savedHost,
      h("h4", {}, t("pj.cl.savedTitle")),
      saved.clips.length === 0 ? h("p", { class: "hint", "data-testid": "pj-cl-saved-empty" }, t("pj.cl.savedEmpty")) : h("ul", { class: "clip-list" }, ...saved.clips.map(savedRow)),
    );
  }

  function update(next: ProjectState): void {
    state = next;
    llmHint.textContent = t(next.settings.llmRemote ? "pj.cl.llm.hint.remote" : "pj.cl.llm.hint");
    const transcriptReady = next.project.transcript.status === "done";
    suggestButton.disabled = searching || !transcriptReady;
    needTranscript.hidden = transcriptReady;
    const canPlay = next.project.mixProxy !== null;
    if (!initialised) {
      initialised = true;
      llmToggle.checked = next.settings.llm;
      void hooks.run(async () => {
        saved = await api.clips();
        if (!disposed) renderSaved();
      });
    }
    if (canPlay !== playable) {
      playable = canPlay;
      renderSuggestions();
    }
    explain.hidden = !hasVideo();
    paintPreviews();
    syncCardRenders();
    if (signature() !== savedSignature) renderSaved();
  }

  renderSuggestions();
  renderSaved();

  const el = h(
    "div",
    { class: "stack", "data-testid": "pj-clips" },
    explain,
    h("p", { class: "hint" }, t("pj.cl.lead")),
    h("div", { class: "row" }, suggestButton, h("label", { class: "check" }, llmToggle, h("span", {}, t("pj.cl.llm"), llmHint))),
    needTranscript,
    suggestionsHost,
    conflictHost,
    savedHost,
  );

  return {
    el,
    update,
    dispose() {
      disposed = true;
      stopWatching?.();
      el.replaceChildren();
    },
  };
}
