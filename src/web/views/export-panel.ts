import { presetById } from "../../shared/presets.js";
import type { JobRecord } from "../../shared/project.js";
import { ApiError } from "../lib/api.js";
import { h, setChildren } from "../lib/dom.js";
import type { ExportRecord, ProjectApi, ProjectState } from "../lib/project-api.js";
import { formatBytes, formatDuration } from "../lib/storage-math.js";
import { formatNumber } from "../lib/number.js";
import { getLang, t } from "../i18n/index.js";
import { captionStyleSelect } from "./caption-style-select.js";
import { failureBanner, progressBar, stageLabel } from "./job-status.js";
import { banner, scrollable, srOnly } from "./layout.js";
import { formatSelect } from "./preset-select.js";

const ACTIVE = new Set(["queued", "running"]);
/** The ranges the server accepts. */
const LUFS_RANGE = { min: -40, max: -5 };
const TRUE_PEAK_RANGE = { min: -9, max: 0 };
/** The bleed gate reduction the server accepts, and the one the form starts with. */
const GATE_RANGE = { min: -90, max: -1 };
const GATE_DEFAULT_DB = -30;

export interface ExportPanelHooks {
  /** Runs a call that changes the project: shows its error and refreshes the page's state. */
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** The list of finished exports, on every change (the page marks its steps by it). */
  onList?: (exports: ExportRecord[]) => void;
  /** The kind of file the form is set to render, whenever it may have changed. */
  onFormat?: (kind: "video" | "audio") => void;
}

export interface ExportPanel {
  /** The settings: format, captions, loudness, cleanup and the render button. */
  el: HTMLElement;
  /** What is being made and what is made: the progress of a render and the list of finished files. */
  files: HTMLElement;
  /** The page's latest state: the render job, the settings and whether the media are there. */
  update(state: ProjectState): void;
  /** Renders with the settings of the form, like its Render button; false (and nothing started) when a value is out of range. */
  start(): boolean;
  dispose(): void;
}

const fileName = (file: string): string => file.split("/").pop() ?? file;
const inRange = (value: number, range: { min: number; max: number }): boolean => Number.isFinite(value) && value >= range.min && value <= range.max;

function exportLabel(record: ExportRecord): string {
  const preset = presetById(record.preset);
  if (preset) return preset.label;
  if (record.preset === "thumbnail-video") return t("pj.ex.thumbnail.video");
  if (record.preset === "thumbnail-short") return t("pj.ex.thumbnail.short");
  return record.preset;
}

/** The newest render job of the list, active or not. */
function lastRender(jobs: JobRecord[]): JobRecord | undefined {
  return jobs.filter((job) => job.kind === "render").sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
}

/**
 * Renders the edit into a file: format, loudness, a progress bar with the stage and a cancel button while it runs, and
 * the list of finished exports with download and delete. The form keeps what the user typed across the page's refreshes.
 */
export function exportPanel(api: ProjectApi, hooks: ExportPanelHooks): ExportPanel {
  let exports: ExportRecord[] = [];
  let disposed = false;
  let lastDone = "";
  let initialised = false;

  const presetSelect = formatSelect("pj-ex-preset", t("pj.ex.preset"));
  presetSelect.addEventListener("change", () => syncControls());
  const lufsInput = h("input", { type: "number", class: "input-number", min: LUFS_RANGE.min, max: LUFS_RANGE.max, step: 1, "data-testid": "pj-ex-lufs", "aria-label": t("pj.ex.lufs") });
  const peakInput = h("input", { type: "number", class: "input-number", min: TRUE_PEAK_RANGE.min, max: TRUE_PEAK_RANGE.max, step: 0.5, "data-testid": "pj-ex-peak", "aria-label": t("pj.ex.truePeak") });
  const sourceSelect = h("select", { "data-testid": "pj-ex-source", "aria-label": t("pj.ex.source") });
  const sourceField = h("div", { class: "field" }, h("span", {}, t("pj.ex.source")), sourceSelect);
  const advanced = h(
    "details",
    { class: "ex-advanced", "data-testid": "pj-ex-advanced" },
    h("summary", {}, t("pj.ex.advanced")),
    h("div", { class: "row" }, h("div", { class: "field" }, h("span", {}, t("pj.ex.lufs")), lufsInput), h("div", { class: "field" }, h("span", {}, t("pj.ex.truePeak")), peakInput), sourceField),
  );
  const renderButton = h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-ex-render", onclick: () => start() }, t("pj.ex.render"));
  const formError = h("div");
  const progressHost = h("div", { class: "stack" });
  const statusHost = h("div", { class: "stack" });
  const note = h("p", { class: "hint", "data-testid": "pj-ex-note" });
  const needMedia = h("p", { class: "hint", "data-testid": "pj-ex-needmedia", hidden: true }, t("pj.ex.needMedia"));
  const checkbox = (testId: string, onchange?: () => void): HTMLInputElement => h("input", { type: "checkbox", "data-testid": testId, ...(onchange ? { onchange } : {}) });
  const checkRow = (input: HTMLInputElement, label: string, hint?: string): HTMLElement => h("label", { class: "check" }, input, h("span", {}, label, hint ? h("span", { class: "hint ex-hint" }, hint) : null));

  // captions: burned into the picture of a video export; the .srt and .vtt files go next to it
  const captionsToggle = checkbox("pj-ex-captions", () => syncControls());
  const captionsStyle = captionStyleSelect("pj-ex-captions-style", t("pj.ex.captions.style"));
  const captionsNeed = h("p", { class: "hint", "data-testid": "pj-ex-captions-need", hidden: true }, t("pj.ex.captions.needTranscript"));
  const captionsBlock = h(
    "div",
    { class: "ex-block", "data-testid": "pj-ex-captions-block" },
    h("h4", {}, t("pj.ex.captions.title")),
    h("div", { class: "row" }, checkRow(captionsToggle, t("pj.ex.captions.burn")), captionsStyle),
    h("p", { class: "hint" }, t("pj.ex.captions.note")),
    captionsNeed,
  );

  // audio cleanup: every part is off until the user turns it on
  const levelToggle = checkbox("pj-ex-clean-level");
  const gateToggle = checkbox("pj-ex-clean-gate", () => syncControls());
  const gateDb = h("input", { type: "number", class: "input-number", min: GATE_RANGE.min, max: GATE_RANGE.max, step: 1, value: String(GATE_DEFAULT_DB), "data-testid": "pj-ex-clean-gate-db", "aria-label": t("pj.ex.clean.gateDb") });
  const denoiseToggle = checkbox("pj-ex-clean-denoise");
  const denoiseHost = h("div", { class: "stack" });
  const cleanBlock = h(
    "div",
    { class: "ex-block", "data-testid": "pj-ex-clean-block" },
    h("h4", {}, t("pj.ex.clean.title")),
    h("p", { class: "hint", "data-testid": "pj-ex-clean-note" }, t("pj.ex.clean.note")),
    checkRow(levelToggle, t("pj.ex.clean.level"), t("pj.ex.clean.level.hint")),
    checkRow(gateToggle, t("pj.ex.clean.gate"), t("pj.ex.clean.gate.hint")),
    h("div", { class: "field" }, h("span", {}, t("pj.ex.clean.gateDb")), gateDb),
    checkRow(denoiseToggle, t("pj.ex.clean.denoise"), t("pj.ex.clean.denoise.hint")),
    denoiseHost,
  );
  /** The denoise model lives on the server; it is known to be missing only once a render with denoise was refused. */
  let denoise: "unknown" | "missing" | "downloading" | "ready" = "unknown";
  let transcriptReady = false;
  const listHost = h("div", { "data-testid": "pj-ex-list" });

  function syncControls(): void {
    const kind = presetById(presetSelect.value)?.kind ?? "audio";
    captionsBlock.hidden = kind !== "video";
    captionsToggle.disabled = !transcriptReady;
    captionsStyle.disabled = !transcriptReady || !captionsToggle.checked;
    captionsNeed.hidden = transcriptReady;
    gateDb.disabled = !gateToggle.checked;
    hooks.onFormat?.(kind);
  }

  function renderDenoise(): void {
    const busy = denoise === "downloading";
    setChildren(
      denoiseHost,
      denoise === "missing" || busy
        ? h(
            "div",
            { class: "stack" },
            banner("warn", t("pj.ex.clean.modelMissing"), "pj-ex-denoise-missing"),
            h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ex-denoise-download", disabled: busy, onclick: () => downloadModel() }, busy ? t("pj.ex.clean.downloading") : t("pj.ex.clean.download"))),
          )
        : null,
      denoise === "ready" ? h("p", { class: "hint", "data-testid": "pj-ex-denoise-ready" }, t("pj.ex.clean.modelReady")) : null,
    );
  }

  function downloadModel(): void {
    denoise = "downloading";
    renderDenoise();
    void hooks.run(async () => {
      try {
        await api.downloadDenoiseModel();
        denoise = "ready";
      } catch (error) {
        denoise = "missing";
        throw error;
      } finally {
        if (!disposed) renderDenoise();
      }
    });
  }

  function start(): boolean {
    const lufs = Number(lufsInput.value);
    const truePeakDb = Number(peakInput.value);
    if (!inRange(lufs, LUFS_RANGE) || !inRange(truePeakDb, TRUE_PEAK_RANGE)) {
      setChildren(formError, banner("error", t("pj.ex.invalid"), "pj-ex-invalid"));
      advanced.open = true;
      return false;
    }
    const bleedGateDb = Number(gateDb.value);
    if (gateToggle.checked && !inRange(bleedGateDb, GATE_RANGE)) {
      setChildren(formError, banner("error", t("pj.ex.invalidGate"), "pj-ex-invalid-gate"));
      return false;
    }
    setChildren(formError);
    const preset = presetById(presetSelect.value);
    const video = preset?.kind === "video";
    const source = video && sourceSelect.value !== "" ? sourceSelect.value : undefined;
    const cleaning = levelToggle.checked || gateToggle.checked || denoiseToggle.checked;
    const params = {
      preset: presetSelect.value,
      lufs,
      truePeakDb,
      ...(source === undefined ? {} : { source }),
      ...(video ? { captions: captionsToggle.checked ? { style: captionsStyle.value } : false } : {}),
      ...(cleaning ? { clean: { level: levelToggle.checked, bleedGate: gateToggle.checked, bleedGateDb: gateToggle.checked ? bleedGateDb : GATE_DEFAULT_DB, denoise: denoiseToggle.checked } } : {}),
    };
    void hooks.run(async () => {
      try {
        await api.startJob("render", params);
      } catch (error) {
        // the denoiser needs a model file the host has not downloaded: offer the download instead of an error
        if (!(error instanceof ApiError) || error.code !== "denoise_model_missing") throw error;
        denoise = "missing";
        if (!disposed) renderDenoise();
      }
    });
    return true;
  }

  function renderList(): void {
    hooks.onList?.(exports);
    if (exports.length === 0) {
      setChildren(listHost, h("p", { class: "hint", "data-testid": "pj-ex-empty" }, t("pj.ex.empty")));
      return;
    }
    const rows = exports.map((record) =>
      h(
        "tr",
        { "data-testid": "pj-ex-row", "data-id": record.id, "data-preset": record.preset },
        h("td", {}, exportLabel(record)),
        h("td", { class: "num" }, formatBytes(record.bytes)),
        h("td", { class: "num" }, record.durationMs > 0 ? formatDuration(record.durationMs / 1000) : "–"),
        h("td", {}, new Date(record.createdAtMs).toLocaleString(getLang())),
        h("td", { class: "num" }, record.loudnessLufs === null ? "–" : t("pj.ex.loudness", { lufs: formatNumber(record.loudnessLufs, 1) })),
        h(
          "td",
          { class: "row" },
          h("a", { class: "btn btn-small", href: api.mediaUrl(record.file), download: fileName(record.file), "data-testid": "pj-ex-download" }, t("pj.ex.download")),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-small",
              "data-testid": "pj-ex-delete",
              onclick: () => {
                if (confirm(t("pj.ex.deleteConfirm"))) {
                  void hooks.run(async () => {
                    exports = await api.deleteExport(record.id);
                    if (!disposed) renderList();
                  });
                }
              },
            },
            t("pj.ex.delete"),
          ),
        ),
      ),
    );
    setChildren(
      listHost,
      scrollable(
        h(
          "table",
          { class: "data-table" },
          h("thead", {}, h("tr", {}, h("th", {}, t("pj.ex.col.format")), h("th", {}, t("pj.ex.col.size")), h("th", {}, t("pj.ex.col.length")), h("th", {}, t("pj.ex.col.created")), h("th", {}, t("pj.ex.col.loudness")), h("th", {}, srOnly(t("common.actions"))))),
          h("tbody", {}, ...rows),
        ),
      ),
    );
  }

  async function loadList(): Promise<void> {
    try {
      const next = await api.exports();
      if (disposed) return;
      exports = next;
      renderList();
    } catch {
      // the list is a convenience; a failed read leaves the last one on screen and the next refresh tries again
    }
  }

  function update(state: ProjectState): void {
    const { project, jobs, settings } = state;
    const hasVideo = project.sources.some((source) => source.hasVideo && source.kind !== "audio");
    const hasAudio = project.sources.some((source) => source.audio !== null);
    const lowDisk = state.disk.freeBytes !== null && state.disk.freeBytes < state.disk.minFreeBytes;
    const active = jobs.find((job) => job.kind === "render" && ACTIVE.has(job.status));
    const last = lastRender(jobs);
    transcriptReady = project.transcript.status === "done";

    if (!initialised) {
      initialised = true;
      lufsInput.value = String(settings.loudnessLufs);
      peakInput.value = String(settings.truePeakDb);
      presetSelect.value = hasVideo ? "youtube-1080p30" : "audio-mp3";
      void loadList();
    }
    for (const preset of presetSelect.options) preset.disabled = preset.dataset.kind === "video" && !hasVideo;
    if (presetById(presetSelect.value)?.kind === "video" && !hasVideo) presetSelect.value = "audio-mp3";
    syncControls();

    // the picture of a video export: the layout's scenes, or one source alone
    const picked = sourceSelect.value;
    const pictureSources = project.sources.filter((source) => source.hasVideo && (source.kind === "camera" || source.kind === "screen"));
    setChildren(
      sourceSelect,
      h("option", { value: "" }, t("pj.ex.source.layout")),
      ...pictureSources.map((source) => h("option", { value: source.id }, t("pj.ex.source.only", { name: `${source.participantName} · ${t(`rec.track.${source.kind}`)}` }))),
    );
    sourceSelect.value = pictureSources.some((source) => source.id === picked) ? picked : "";
    sourceField.hidden = !hasVideo;

    renderButton.disabled = active !== undefined || !hasAudio || lowDisk;
    needMedia.hidden = hasAudio;
    note.textContent = settings.retention === "keep-all" ? t("pj.ex.keepAll") : t("pj.ex.keepNote");

    if (active) {
      const percent = Math.round(active.progress * 100);
      const stage = stageLabel(active.stage);
      setChildren(
        progressHost,
        progressBar(percent, t("pj.ex.title"), active.stage),
        h("p", { class: "hint", "data-testid": "pj-ex-progress", "data-stage": active.stage ?? "", "data-status": active.status }, t("pj.ex.progress", { percent, stage })),
        h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-ex-cancel", onclick: () => void hooks.run(() => api.cancelJob(active.id)) }, t("pj.cancel")),
      );
    } else {
      setChildren(progressHost);
    }
    setChildren(
      statusHost,
      !active && last?.status === "failed" ? failureBanner("pj.job.render", last.error ?? "?", "pj-ex-error") : null,
      !active && last?.status === "canceled" ? h("p", { class: "hint", "data-testid": "pj-ex-canceled" }, t("pj.ex.canceled")) : null,
    );

    // a render or thumbnail that has just finished: its file is in the list now
    const finished = jobs.filter((job) => (job.kind === "render" || job.kind === "thumbnail") && job.status === "done").sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (finished && finished.id !== lastDone) {
      lastDone = finished.id;
      void loadList();
    }
  }

  renderList();

  const el = h(
    "div",
    { class: "stack", "data-testid": "pj-export" },
    h("p", { class: "hint" }, t("pj.ex.lead")),
    h("div", { class: "row" }, h("div", { class: "field" }, h("span", {}, t("pj.ex.preset")), presetSelect)),
    advanced,
    captionsBlock,
    cleanBlock,
    h("div", { class: "row" }, renderButton),
    formError,
    needMedia,
    note,
  );
  const files = h("div", { class: "stack", "data-testid": "pj-exports" }, progressHost, statusHost, h("h4", {}, t("pj.ex.list")), listHost);

  return {
    el,
    files,
    update,
    start,
    dispose() {
      disposed = true;
      el.replaceChildren();
      files.replaceChildren();
    },
  };
}
