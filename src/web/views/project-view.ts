import type { Range } from "../../shared/edl.js";
import type { JobRecord, ProjectFile } from "../../shared/project.js";
import { ApiError, SessionApi } from "../lib/api.js";
import { h, setChildren } from "../lib/dom.js";
import type { ProjectApi, ProjectState } from "../lib/project-api.js";
import { formatBytes, formatDuration } from "../lib/storage-math.js";
import { t } from "../i18n/index.js";
import { clipsPanel, type ClipsPanel } from "./clips-panel.js";
import { exportPanel, type ExportPanel } from "./export-panel.js";
import { claimLinkPanel } from "./access.js";
import { banner, card, page } from "./layout.js";
import { layoutPanel, type LayoutPanel } from "./layout-panel.js";
import { publishPanel, type PublishPanel } from "./publish-panel.js";
import { stage, type Stage } from "./stage.js";
import { transcriptPanel, type TranscriptPanel } from "./transcript-panel.js";

const ACTIVE = new Set(["queued", "running"]);

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const key = `pj.err.${error.code}`;
    const known = ["session_not_ended", "tracks_pending", "no_tracks", "disk_low", "jobs_active", "not_prepared"];
    if (known.includes(error.code)) return t(key as "pj.err.disk_low");
    return t("err.generic", { message: error.code });
  }
  return t("err.generic", { message: error instanceof Error ? error.message : "?" });
}

const hasPictures = (project: ProjectFile): boolean => project.sources.some((source) => source.hasVideo && (source.kind === "camera" || source.kind === "screen"));

/**
 * What the stage (player, timeline, cut list) is built for: the audio of the project and its length. The prepared media
 * come and go under it (after an export, prepared again) without tearing down playback position and undo history.
 */
const stageKeyOf = (project: ProjectFile): string => (project.sources.some((source) => source.audio) ? String(project.durationMs) : "");

/** The project page: tracks on the shared timeline, the preparation of the media, cutting, layout and export. */
export function projectView(api: ProjectApi): { el: HTMLElement; dispose: () => void } {
  const info = h("div", { class: "stack" });
  const notice = h("div");
  let state: ProjectState | null = null;
  let missing = false;
  let timer: number | undefined;
  let disposed = false;

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setChildren(notice);
    try {
      await action();
    } catch (error) {
      const failure = banner("error", errorText(error), "pj-error");
      setChildren(notice, failure);
      failure.scrollIntoView({ block: "nearest" });
    }
    await refresh();
  };

  async function refresh(): Promise<void> {
    window.clearTimeout(timer);
    try {
      state = await api.state();
      missing = false;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        state = null;
        missing = true;
      } else {
        setChildren(notice, banner("error", errorText(error), "pj-error"));
      }
    }
    if (disposed) return;
    render();
    if (state?.jobs.some((job) => ACTIVE.has(job.status))) timer = window.setTimeout(() => void refresh(), 1500);
  }

  function activeJob(kind = "conform"): JobRecord | undefined {
    return state?.jobs.find((job) => ACTIVE.has(job.status) && job.kind === kind);
  }

  // The sections below the sources keep their player, scroll position and unsaved input across the page's status refreshes:
  // each one is built once for a key and only rebuilt when its key changes.
  const stageHost = h("div");
  const stageSection = h("div", { class: "step", hidden: true }, stageHost);
  const trControls = h("div", { class: "stack" });
  const trHost = h("div");
  const trSection = h("div", { class: "step", hidden: true }, h("h3", {}, t("pj.tr.title")), trControls, trHost);
  const layHost = h("div");
  const laySection = h("div", { class: "step", hidden: true, "data-testid": "pj-lay-section" }, h("h3", {}, t("pj.lay.title")), layHost);
  const clHost = h("div");
  const clSection = h("div", { class: "step", hidden: true, "data-testid": "pj-cl-section" }, h("h3", {}, t("pj.cl.title")), clHost);
  const exHost = h("div");
  const exSection = h("div", { class: "step", hidden: true, "data-testid": "pj-ex-section" }, h("h3", {}, t("pj.ex.title")), exHost);
  const pubHost = h("div");
  const pubSection = h("div", { class: "step", hidden: true, "data-testid": "pj-pub-section" }, h("h3", {}, t("pj.pub.title")), pubHost);
  const body = h("div", { class: "stack" }, info, stageSection, trSection, laySection, clSection, exSection, pubSection);

  let stg: Stage | null = null;
  let stgKey = "";
  let trPanel: TranscriptPanel | null = null;
  let trKey = "";
  let trLang = "auto";
  let layPanel: LayoutPanel | null = null;
  let layKey = "";
  let exPanel: ExportPanel | null = null;
  let clPanel: ClipsPanel | null = null;
  let pubPanel: PublishPanel | null = null;
  let stopRange: (() => void) | null = null;

  /** Builds, replaces or drops the stage for the project's current media; the panels that follow it are rebuilt after it. */
  function syncStage(project: ProjectFile): void {
    const key = stageKeyOf(project);
    if (key === stgKey) return;
    stgKey = key;
    const old = stg;
    const oldLayout = layPanel;
    stg = null;
    trPanel?.dispose();
    trPanel = null;
    trKey = "";
    layPanel = null;
    layKey = "";
    setChildren(trHost);
    setChildren(layHost);
    stageSection.hidden = true;
    void (async () => {
      // the new stage reads the saved cut list: let the old one finish saving it first
      await Promise.allSettled([old?.flush(), oldLayout?.flush()]);
      oldLayout?.dispose();
      old?.dispose();
      setChildren(stageHost);
      if (!key) return;
      try {
        const saved = await api.edl();
        if (disposed || stgKey !== key || !state) return;
        stg = stage(api, state.project, saved);
        setChildren(stageHost, stg.el);
        stageSection.hidden = false;
        syncPanels(state);
      } catch (error) {
        stgKey = "";
        setChildren(notice, banner("error", errorText(error), "pj-error"));
      }
    })();
  }

  function syncTranscript(current: ProjectState): void {
    const { project, jobs } = current;
    const transcript = project.transcript;
    const job = activeJob("transcribe");
    const ready = project.conform.status === "done" && project.sources.some((source) => source.audio);
    const lowDisk = current.disk.freeBytes !== null && current.disk.freeBytes < current.disk.minFreeBytes;
    const lang = h("select", { "data-testid": "pj-tr-lang", "aria-label": t("pj.tr.lang"), onchange: (event: Event) => { trLang = (event.target as HTMLSelectElement).value; } }, ...(["auto", "en", "pl"] as const).map((code) => h("option", { value: code, selected: code === trLang }, t(`pj.tr.lang.${code}`))));
    setChildren(
      trControls,
      h("div", { class: "row" }, h("span", { class: `pill pill-${transcript.status === "done" ? "ok" : transcript.status === "failed" ? "failed" : "pending"}`, "data-testid": "pj-tr-status", "data-status": transcript.status }, t(`pj.tr.status.${transcript.status}`))),
      job
        ? h("div", { class: "stack" }, h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(Math.round(job.progress * 100)) }, h("div", { class: "bar-fill", style: `width:${Math.round(job.progress * 100)}%` })), h("p", { class: "hint", "data-testid": "pj-tr-progress" }, `${Math.round(job.progress * 100)}% ${job.stage ?? ""}`), h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-tr-cancel", onclick: () => void run(() => api.cancelJob(job.id)) }, t("pj.cancel")))
        : h("div", { class: "row" }, lang, h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-tr-start", disabled: !ready || lowDisk, onclick: () => void run(() => api.startJob("transcribe", { lang: trLang })) }, transcript.status === "done" ? t("pj.tr.again") : t("pj.tr.start"))),
      ready ? null : h("p", { class: "hint" }, t("pj.tr.needMedia")),
      transcript.error ? banner("error", transcript.error, "pj-tr-error") : null,
      h("p", { class: "hint" }, t("pj.tr.hint")),
    );
    const key = stg && transcript.status === "done" ? `${stgKey}|${transcript.atMs}` : "";
    if (key === trKey) {
      trPanel?.update(jobs);
      return;
    }
    trKey = key;
    trPanel?.dispose();
    trPanel = null;
    setChildren(trHost);
    if (!key || !stg) return;
    const mine = stg;
    void api
      .transcript()
      .then((file) => {
        if (disposed || trKey !== key || stg !== mine) return;
        trPanel = transcriptPanel(api, mine, current.project, file, { run });
        setChildren(trHost, trPanel.el);
        trPanel.update(state?.jobs ?? jobs);
      })
      .catch((error) => setChildren(trHost, banner("error", errorText(error), "pj-error")));
  }

  function syncLayout(project: ProjectFile): void {
    // the pictures come from the prepared media: the preview is rebuilt when those are made again or removed
    const key = stg && hasPictures(project) ? `${stgKey}|${project.conform.atMs}|${project.sources.map((source) => (source.video ? 1 : 0)).join("")}` : "";
    laySection.hidden = key === "";
    if (key === layKey) return;
    layKey = key;
    const old = layPanel;
    layPanel = null;
    setChildren(layHost);
    if (!key || !stg) {
      old?.dispose();
      return;
    }
    const mine = stg;
    void (async () => {
      // the new panel reads the saved layout: let the old one finish saving it first
      await old?.flush().catch(() => undefined);
      old?.dispose();
      try {
        const file = await api.scenes();
        if (disposed || layKey !== key || stg !== mine || !state) return;
        layPanel = layoutPanel(api, mine, state.project, file, state.settings);
        setChildren(layHost, layPanel.el);
      } catch (error) {
        setChildren(layHost, banner("error", errorText(error), "pj-lay-error"));
      }
    })();
  }

  function syncExport(current: ProjectState): void {
    const exportable = current.project.sources.some((source) => source.audio);
    exSection.hidden = !exportable;
    if (!exportable) return;
    if (!exPanel) {
      exPanel = exportPanel(api, { run });
      setChildren(exHost, exPanel.el);
    }
    exPanel.update(current);
  }

  /** Plays a stretch of the recording on the stage's player: the playhead goes to its start and the player stops at its end. */
  function play(range: Range): void {
    const current = stg;
    if (!current) return;
    stopRange?.();
    current.seek(range.s);
    void current.audio.play();
    const unwatch = current.onTick((ms) => {
      if (ms >= range.e) current.audio.pause();
    });
    // a pause, at the end of the stretch or by the user, ends the watch
    const done = (): void => {
      current.audio.removeEventListener("pause", done);
      unwatch();
      stopRange = null;
    };
    current.audio.addEventListener("pause", done);
    stopRange = done;
  }

  /** Clips and publishing sit beside the export: they need the audio and use the same render queue. */
  function syncPublishing(current: ProjectState): void {
    const available = current.project.sources.some((source) => source.audio);
    clSection.hidden = !available;
    pubSection.hidden = !available;
    if (!available) return;
    if (!clPanel) {
      clPanel = clipsPanel(api, { run, play });
      setChildren(clHost, clPanel.el);
    }
    if (!pubPanel) {
      pubPanel = publishPanel(api, { run });
      setChildren(pubHost, pubPanel.el);
    }
    clPanel.update(current);
    pubPanel.update(current);
  }

  function syncPanels(current: ProjectState): void {
    syncTranscript(current);
    syncLayout(current.project);
  }

  function render(): void {
    if (!state) {
      trSection.hidden = true;
      laySection.hidden = true;
      exSection.hidden = true;
      clSection.hidden = true;
      pubSection.hidden = true;
      stageSection.hidden = true;
      setChildren(
        info,
        h("p", {}, t("pj.none")),
        missing
          ? h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-create", onclick: () => void run(() => api.create()) }, t("pj.create"))
          : null,
      );
      return;
    }
    const { project } = state;
    const job = activeJob();
    const conform = project.conform;
    const lowDisk = state.disk.freeBytes !== null && state.disk.freeBytes < state.disk.minFreeBytes;
    const rows = project.sources.map((source) =>
      h(
        "tr",
        { "data-testid": `pj-source-${source.id}` },
        h("td", {}, `${source.participantName} · ${t(`rec.track.${source.kind}`)}${source.segment > 1 ? ` #${source.segment}` : ""}`),
        h("td", { class: "num" }, `${(source.offsetMs / 1000).toFixed(2)} s`),
        h("td", { class: "num" }, formatDuration(source.timelineDurationMs / 1000)),
        h("td", { class: "num", title: source.driftNote ?? "" }, `${source.driftPpm >= 0 ? "+" : ""}${source.driftPpm.toFixed(0)} ppm ${source.driftApplied ? t("pj.drift.corrected") : t("pj.drift.kept")}`),
      ),
    );
    setChildren(
      info,
      h("p", { class: "hint" }, t("pj.lead")),
      h(
        "table",
        { class: "data-table", "data-testid": "pj-sources" },
        h("thead", {}, h("tr", {}, h("th", {}, t("pj.col.track")), h("th", {}, t("pj.col.start")), h("th", {}, t("pj.col.length")), h("th", {}, t("pj.col.drift")))),
        h("tbody", {}, ...rows),
      ),
      h("p", { class: "hint" }, t("pj.duration", { time: formatDuration(project.durationMs / 1000) })),
    );
    const prepared = h(
      "div",
      { class: "stack" },
      h("div", { class: "row" }, h("span", {}, t("pj.media")), h("span", { class: `pill pill-${conform.status === "done" ? "ok" : conform.status === "failed" ? "failed" : "pending"}`, "data-testid": "pj-conform-status", "data-status": conform.status }, t(`pj.status.${conform.status}`))),
      job
        ? h("div", { class: "stack" }, h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(Math.round(job.progress * 100)) }, h("div", { class: "bar-fill", style: `width:${Math.round(job.progress * 100)}%` })), h("p", { class: "hint", "data-testid": "pj-progress" }, `${Math.round(job.progress * 100)}% ${job.stage ?? ""}`), h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-cancel", onclick: () => void run(() => api.cancelJob(job.id)) }, t("pj.cancel")))
        : h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-prepare", disabled: lowDisk, onclick: () => void run(() => api.startJob("conform")) }, conform.status === "done" ? t("pj.prepare.again") : t("pj.prepare")),
      conform.error ? banner("error", conform.error, "pj-conform-error") : null,
      lowDisk ? banner("warn", t("pj.err.disk_low"), "pj-disk-low") : null,
      state.disk.freeBytes !== null ? h("p", { class: "hint", "data-testid": "pj-disk" }, t("pj.disk", { free: formatBytes(state.disk.freeBytes), min: formatBytes(state.disk.minFreeBytes) })) : null,
      conform.status === "done" || project.sources.some((source) => source.audio || source.video)
        ? h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-drop-proxies", disabled: job !== undefined, onclick: () => { if (confirm(t("pj.drop.proxiesConfirm"))) void run(() => api.dropCache("proxies")); } }, t("pj.drop.proxies")),
            h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-drop-all", disabled: job !== undefined, onclick: () => { if (confirm(t("pj.drop.allConfirm"))) void run(() => api.dropCache("all")); } }, t("pj.drop.all")),
          )
        : null,
      h("p", { class: "hint" }, t("pj.retention")),
    );
    info.append(h("section", { class: "step" }, prepared));
    trSection.hidden = false;
    syncStage(project);
    stg?.setMedia(project);
    syncPanels(state);
    syncExport(state);
    syncPublishing(state);
  }

  const el = page(card(t("pj.title"), claimLinkPanel(new SessionApi(api.sid, api.token)), notice, body));
  void refresh();
  return {
    el,
    dispose: () => {
      disposed = true;
      window.clearTimeout(timer);
      trPanel?.dispose();
      layPanel?.dispose();
      exPanel?.dispose();
      clPanel?.dispose();
      pubPanel?.dispose();
      stopRange?.();
      stg?.dispose();
    },
  };
}
