import { DEFAULT_DRIFT_OPTIONS } from "../../shared/drift.js";
import type { Range } from "../../shared/edl.js";
import { presetById } from "../../shared/presets.js";
import type { JobRecord, ProjectFile } from "../../shared/project.js";
import { ApiError, SessionApi } from "../lib/api.js";
import { h, setChildren } from "../lib/dom.js";
import type { ExportRecord, ProjectApi, ProjectState } from "../lib/project-api.js";
import { formatBytes, formatDuration } from "../lib/storage-math.js";
import { formatNumber } from "../lib/number.js";
import { getLang, t, type MessageKey } from "../i18n/index.js";
import { clipsPanel, type ClipsPanel } from "./clips-panel.js";
import { exportPanel, type ExportPanel } from "./export-panel.js";
import { claimLinkPanel } from "./access.js";
import { failureBanner, progressBar, stageLabel } from "./job-status.js";
import { banner, card, page, scrollable } from "./layout.js";
import { layoutPanel, type LayoutPanel } from "./layout-panel.js";
import { publishPanel, type PublishPanel } from "./publish-panel.js";
import { stage, type Stage } from "./stage.js";
import { isStepId, stepTabs, type StepId } from "./steps.js";
import { transcriptPanel, type TranscriptPanel } from "./transcript-panel.js";

const ACTIVE = new Set(["queued", "running"]);
/** Below this width the transcript goes under the step, as a section that can be folded. */
const WIDE_QUERY = "(min-width: 1000px)";
const LANGS = ["auto", "en", "pl"] as const;
type AsrLang = (typeof LANGS)[number];
const isAsrLang = (value: string | null): value is AsrLang => LANGS.some((code) => code === value);

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
const hasAudio = (project: ProjectFile): boolean => project.sources.some((source) => source.audio !== null);

type Source = ProjectFile["sources"][number];

const trackName = (source: Source): string => `${source.participantName} · ${t(`rec.track.${source.kind}`)}${source.segment > 1 ? ` #${source.segment}` : ""}`;
const percentOf = (job: JobRecord): number => Math.round(job.progress * 100);
const progressText = (job: JobRecord): string => `${percentOf(job)}% ${stageLabel(job.stage)}`.trim();
const isClipRender = (job: JobRecord): boolean => job.kind === "render" && typeof job.params.clip === "string";

/** Session storage can be off (private windows, blocked cookies): what is remembered is a convenience only. */
function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

function driftWarnings(project: ProjectFile): HTMLElement[] {
  return project.sources
    .filter(
      (source) =>
        !source.driftApplied && Math.abs(source.driftPpm) > DEFAULT_DRIFT_OPTIONS.maxPpm && source.timelineDurationMs >= DEFAULT_DRIFT_OPTIONS.minSpanSec * 1000,
    )
    .map((source) => {
      const seconds = formatNumber((Math.abs(source.driftPpm) * source.timelineDurationMs) / 1e9, 1);
      return banner("warn", t(source.driftPpm < 0 ? "pj.drift.shorter" : "pj.drift.longer", { track: trackName(source), seconds }), "pj-drift-warning");
    });
}

/**
 * What the stage (player, timeline, cut list) is built for: the audio of the project and its length. The prepared media
 * come and go under it (after an export, prepared again) without tearing down playback position and undo history.
 */
const stageKeyOf = (project: ProjectFile): string => (project.sources.some((source) => source.audio) ? String(project.durationMs) : "");

/**
 * The project page: a workspace with the transcript always at hand in one column, and in the other the player with
 * the step the user is on: prepare the recordings, check the episode and export it, make shorts, cover and text, details.
 */
export function projectView(api: ProjectApi): { el: HTMLElement; dispose: () => void } {
  const notice = h("div", { class: "ws-notice" });
  let state: ProjectState | null = null;
  let missing = false;
  let timer: number | undefined;
  let disposed = false;

  const stepKey = `syncrecord.pj.step.${api.sid}`;
  const langKey = `syncrecord.pj.lang.${api.sid}`;
  const storedStep = recall(stepKey);
  /** The user picked a step (now or earlier in this tab): from then on the page no longer moves on by itself. */
  let stepChosen = isStepId(storedStep);
  const tabs = stepTabs(isStepId(storedStep) ? storedStep : "prepare", (id) => {
    stepChosen = true;
    remember(stepKey, id);
  });
  /** The language of the conversation: Polish on a Polish screen, otherwise detected. Remembered per project in this tab. */
  const storedLang = recall(langKey);
  let trLang: AsrLang = isAsrLang(storedLang) ? storedLang : getLang() === "pl" ? "pl" : "auto";

  const go = (id: StepId): void => {
    tabs.select(id, true);
    stepChosen = true;
    remember(stepKey, id);
  };

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

  // ---- "Prepare episode" runs the whole chain: the recordings first, then the transcript, one after the other ----------
  // Only a click starts it; opening the page never starts a job. `chain` names the stage the user's click is waiting for.
  let chain: "conform" | "transcribe" | null = null;
  let advancing = false;

  async function advanceChain(current: ProjectState): Promise<boolean> {
    if (chain === null || advancing) return false;
    if (activeJob("conform") || activeJob("transcribe")) return false;
    const { conform, transcript } = current.project;
    if (chain !== "conform" || conform.status !== "done" || transcript.status === "done") {
      // the transcript ran, or the recordings did not get ready: the page shows which, with a retry
      chain = null;
      return false;
    }
    chain = "transcribe";
    advancing = true;
    try {
      await api.startJob("transcribe", { lang: trLang });
      return true;
    } catch (error) {
      chain = null;
      setChildren(notice, banner("error", errorText(error), "pj-error"));
      return false;
    } finally {
      advancing = false;
    }
  }

  async function refresh(): Promise<void> {
    window.clearTimeout(timer);
    try {
      state = await api.state();
      missing = false;
      if (await advanceChain(state)) state = await api.state();
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

  function activeJob(kind: string): JobRecord | undefined {
    return state?.jobs.find((job) => ACTIVE.has(job.status) && job.kind === kind);
  }

  function prepare(): void {
    const current = state;
    if (!current) return;
    const { conform, transcript } = current.project;
    // the recordings are ready already (a failed or cancelled transcript, or one never started): only the transcript is left
    const job = conform.status === "done" && transcript.status !== "done" ? "transcribe" : "conform";
    chain = job;
    void run(async () => {
      try {
        await api.startJob(job, job === "transcribe" ? { lang: trLang } : {});
      } catch (error) {
        chain = null;
        throw error;
      }
    });
  }

  // ---- the hosts of the panels: built once for a key and only rebuilt when it changes ---------------------------------
  // They keep their player, scroll position and unsaved input across the page's status refreshes. The tab bodies hold
  // them hidden, so a panel of another step keeps running.
  const stageHost = h("div");
  const stageSection = h("div", { class: "card ws-stage", hidden: true, "data-testid": "pj-stage-card" }, stageHost);
  const trHost = h("div");
  const trEmpty = h("p", { class: "hint", "data-testid": "pj-tr-empty" }, t("flow.tr.empty"));
  const trSection = h("details", { class: "card ws-transcript", open: true, "data-testid": "pj-tr-card" }, h("summary", {}, h("h2", {}, t("pj.tr.title"))), trEmpty, trHost);
  // beside the step the transcript is a column that stays open; below it, a section the user may fold
  const wide = window.matchMedia(WIDE_QUERY);
  const keepOpen = (): void => {
    if (wide.matches) trSection.open = true;
  };
  wide.addEventListener("change", keepOpen);
  trSection.addEventListener("toggle", keepOpen);

  // step 1
  const prepHost = h("div", { class: "stack" });
  // step 2
  const layHost = h("div");
  const laySection = h("details", { class: "ws-fold", hidden: true, "data-testid": "pj-lay-section" }, h("summary", {}, t("flow.ep.layout")), layHost);
  const exHost = h("div");
  const exSection = h("details", { class: "ws-fold", hidden: true, "data-testid": "pj-ex-section" }, h("summary", {}, t("flow.ep.settings")), exHost);
  const filesHost = h("div");
  const epGuide = h("p", { class: "ws-guide", "data-testid": "pj-ep-guide" });
  const playButton = h("button", { type: "button", class: "btn btn-primary btn-large", "data-testid": "pj-ep-play", onclick: () => stg?.playFromStart() }, t("flow.ep.play"));
  const exportButton = h(
    "button",
    {
      type: "button",
      class: "btn btn-primary btn-large",
      "data-testid": "pj-ep-export",
      onclick: () => {
        // a value of the form out of range is shown there: open the settings so the user sees which
        if (exPanel && !exPanel.start()) exSection.open = true;
      },
    },
    t("flow.ep.exportVideo"),
  );
  const prepareAgain = h("button", { type: "button", class: "btn btn-small", hidden: true, "data-testid": "pj-ep-prepare", onclick: () => void run(() => api.startJob("conform")) }, t("flow.ep.prepareAgain"));
  const epNotes = h("div", { class: "stack" });
  const epNoPicture = banner("info", t("flow.ep.noPicture"), "pj-ep-nopicture");
  const epBody = h(
    "div",
    { class: "stack", hidden: true, "data-testid": "pj-ep-body" },
    epGuide,
    h("div", { class: "row ws-actions" }, playButton, exportButton, prepareAgain),
    epNotes,
    epNoPicture,
    filesHost,
    laySection,
    exSection,
  );
  // step 3 and 4
  const clHost = h("div");
  const clSection = h("div", { hidden: true, "data-testid": "pj-cl-section" }, clHost);
  const pubHost = h("div");
  const pubSection = h("div", { hidden: true, "data-testid": "pj-pub-section" }, pubHost);
  // step 5
  const detHost = h("div", { class: "stack" });

  /** What a step that needs the prepared episode shows until there is one. */
  const needPrepare = (id: string): HTMLElement =>
    h(
      "div",
      { class: "stack", "data-testid": `pj-need-${id}` },
      h("p", { class: "ws-guide" }, t("flow.needPrepare")),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => go("prepare") }, t("flow.goPrepare"))),
    );
  const needEpisode = needPrepare("episode");
  const needShorts = needPrepare("shorts");
  const needCover = needPrepare("cover");

  const shortsBody = h("div", { class: "stack", hidden: true, "data-testid": "pj-sh-body" }, h("p", { class: "ws-guide" }, t("flow.sh.guide")), clSection);
  const coverBody = h("div", { class: "stack", hidden: true, "data-testid": "pj-cv-body" }, h("p", { class: "ws-guide" }, t("flow.cv.guide")), pubSection);
  setChildren(tabs.panel("prepare"), prepHost);
  setChildren(tabs.panel("episode"), needEpisode, epBody);
  setChildren(tabs.panel("shorts"), needShorts, shortsBody);
  setChildren(tabs.panel("cover"), needCover, coverBody);
  setChildren(tabs.panel("details"), detHost, h("section", { class: "stack" }, h("h3", {}, t("pj.access.title")), h("p", { class: "hint" }, t("flow.det.accessHint")), claimLinkPanel(new SessionApi(api.sid, api.token))));

  let stg: Stage | null = null;
  let stgKey = "";
  let trPanel: TranscriptPanel | null = null;
  let trKey = "";
  let layPanel: LayoutPanel | null = null;
  let layKey = "";
  let exPanel: ExportPanel | null = null;
  let clPanel: ClipsPanel | null = null;
  let pubPanel: PublishPanel | null = null;
  /** The finished exports (reported by the export panel): they say which steps have a result. */
  let exportList: ExportRecord[] = [];

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
    trEmpty.hidden = false;
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
    const key = stg && project.transcript.status === "done" ? `${stgKey}|${project.transcript.atMs}` : "";
    if (key === trKey) {
      trPanel?.update(jobs);
      return;
    }
    trKey = key;
    trPanel?.dispose();
    trPanel = null;
    trEmpty.hidden = false;
    setChildren(trHost);
    if (!key || !stg) return;
    const mine = stg;
    void api
      .transcript()
      .then((file) => {
        if (disposed || trKey !== key || stg !== mine) return;
        trPanel = transcriptPanel(api, mine, project, file, { run });
        trEmpty.hidden = true;
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
    const exportable = hasAudio(current.project);
    exSection.hidden = !exportable;
    if (!exportable) return;
    if (!exPanel) {
      exPanel = exportPanel(api, {
        run,
        onList: (records) => {
          exportList = records;
          updateMarks();
        },
        onFormat: (kind) => {
          exportButton.textContent = t(kind === "video" ? "flow.ep.exportVideo" : "flow.ep.exportAudio");
        },
      });
      setChildren(exHost, exPanel.el);
      setChildren(filesHost, exPanel.files);
    }
    exPanel.update(current);
  }

  /** Clips and publishing sit beside the export: they need the audio and use the same render queue. */
  function syncPublishing(current: ProjectState): void {
    const available = hasAudio(current.project);
    clSection.hidden = !available;
    pubSection.hidden = !available;
    if (!available) return;
    if (!clPanel) {
      clPanel = clipsPanel(api, { run, play, stop: () => stg?.stopClip(), onPlaying: (listener) => stg?.onClip(listener) ?? (() => undefined) });
      setChildren(clHost, clPanel.el);
    }
    if (!pubPanel) {
      pubPanel = publishPanel(api, { run });
      setChildren(pubHost, pubPanel.el);
    }
    clPanel.update(current);
    pubPanel.update(current);
  }

  /** Plays a stretch of the recording on the stage's player, with the picture in the shape of a short. */
  function play(range: Range): void {
    stg?.playClip(range, "9:16");
  }

  // ---- step 1: prepare ---------------------------------------------------------------------------------------------------
  const pill = (status: string, label: string, testId: string): HTMLElement =>
    h("span", { class: `pill pill-${status === "done" ? "ok" : status === "failed" ? "failed" : "pending"}`, "data-testid": testId, "data-status": status }, label);

  function languageField(testId: string): HTMLElement {
    const select = h(
      "select",
      {
        "data-testid": testId,
        "aria-label": t("flow.prep.lang"),
        onchange: () => {
          trLang = select.value as AsrLang;
          remember(langKey, trLang);
        },
      },
      ...LANGS.map((code) => h("option", { value: code, selected: code === trLang }, t(`flow.lang.${code}`))),
    );
    return h("div", { class: "field" }, h("span", {}, t("flow.prep.lang")), select);
  }

  function renderPrepare(current: ProjectState): void {
    const { project, disk } = current;
    const { conform, transcript } = project;
    const conformJob = activeJob("conform");
    const transcribeJob = activeJob("transcribe");
    const job = conformJob ?? transcribeJob;
    const lowDisk = disk.freeBytes !== null && disk.freeBytes < disk.minFreeBytes;
    const done = conform.status === "done" && transcript.status === "done";
    const failed = !job && (conform.status === "failed" || transcript.status === "failed");
    const stageKey: MessageKey = conformJob || (!transcribeJob && chain === "conform") ? "flow.prep.stage.conform" : "flow.prep.stage.transcribe";

    let action: HTMLElement | null;
    if (job) {
      const testPrefix = conformJob ? "pj-" : "pj-tr-";
      action = h(
        "div",
        { class: "stack" },
        h("p", { class: "ws-now" }, `${t(stageKey)}…`),
        progressBar(percentOf(job), t(stageKey), job.stage),
        h("p", { class: "hint", "data-testid": `${testPrefix}progress` }, progressText(job)),
        h("p", { class: "hint" }, t("flow.prep.wait")),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "data-testid": `${testPrefix}cancel`,
            onclick: () => {
              chain = null;
              void run(() => api.cancelJob(job.id));
            },
          },
          t("pj.cancel"),
        ),
      );
    } else if (chain !== null) {
      // the first stage is done and the next one is about to start
      action = h("p", { class: "ws-now" }, `${t(stageKey)}…`);
    } else if (done) {
      action = h("div", { class: "stack" }, banner("ok", t("flow.prep.doneTitle"), "pj-prepare-done"), h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary btn-large", "data-testid": "pj-prepare-next", onclick: () => go("episode") }, t("flow.prep.next"))));
    } else {
      action = h(
        "div",
        { class: "stack" },
        h("div", { class: "row ws-actions" }, transcript.status === "done" ? null : languageField("pj-tr-lang"), h("button", { type: "button", class: "btn btn-primary btn-large", "data-testid": "pj-prepare", disabled: lowDisk, onclick: () => prepare() }, failed ? t("flow.prep.retry") : t("flow.prep.button"))),
        h("p", { class: "hint" }, t("flow.prep.hint")),
      );
    }

    setChildren(
      prepHost,
      h("p", { class: "ws-guide" }, t("flow.prep.lead")),
      h(
        "ul",
        { class: "plain-list ws-checks" },
        h("li", {}, h("span", {}, t("flow.prep.stage.conform")), pill(conform.status, t(`flow.prep.state.${conform.status}`), "pj-conform-status")),
        h("li", {}, h("span", {}, t("flow.prep.stage.transcribe")), pill(transcript.status, t(`flow.prep.state.${transcript.status}`), "pj-tr-status")),
      ),
      action,
      conform.error ? failureBanner("flow.prep.failed.conform", conform.error, "pj-conform-error") : null,
      transcript.error ? failureBanner("flow.prep.failed.transcribe", transcript.error, "pj-tr-error") : null,
      lowDisk ? banner("warn", t("pj.err.disk_low"), "pj-disk-low") : null,
    );
  }

  // ---- step 2: the episode -----------------------------------------------------------------------------------------------
  function renderEpisode(current: ProjectState): void {
    const { project, jobs, disk } = current;
    const pictures = hasPictures(project);
    const playable = stg !== null && project.mixProxy !== null;
    const rendering = jobs.some((job) => job.kind === "render" && ACTIVE.has(job.status));
    const lowDisk = disk.freeBytes !== null && disk.freeBytes < disk.minFreeBytes;
    epGuide.textContent = t(pictures ? "flow.ep.guide" : "flow.ep.guideAudio");
    epNoPicture.hidden = pictures;
    playButton.disabled = !playable;
    exportButton.disabled = rendering || lowDisk || !hasAudio(project);
    prepareAgain.hidden = playable || stg === null || jobs.some((job) => ACTIVE.has(job.status));
    setChildren(
      epNotes,
      playable ? null : h("p", { class: "hint", "data-testid": "pj-ep-nofiles" }, t("flow.ep.noFiles")),
      rendering ? h("p", { class: "hint", "data-testid": "pj-ep-busy" }, t("flow.ep.busy")) : null,
      lowDisk ? banner("warn", t("pj.err.disk_low"), "pj-ep-disk-low") : null,
    );
  }

  // ---- step 5: details ---------------------------------------------------------------------------------------------------
  function renderDetails(current: ProjectState): void {
    const { project, disk } = current;
    const { conform, transcript } = project;
    const busy = current.jobs.some((job) => ACTIVE.has(job.status));
    const lowDisk = disk.freeBytes !== null && disk.freeBytes < disk.minFreeBytes;
    const ready = conform.status === "done" && hasAudio(project);
    const rows = project.sources.map((source) =>
      h(
        "tr",
        { "data-testid": `pj-source-${source.id}` },
        h("td", {}, trackName(source)),
        h("td", { class: "num" }, `${formatNumber(source.offsetMs / 1000, 2)} s`),
        h("td", { class: "num" }, formatDuration(source.timelineDurationMs / 1000)),
        h("td", { class: "num" }, `${source.driftPpm >= 0 ? "+" : ""}${formatNumber(source.driftPpm, 0)} ppm ${source.driftApplied ? t("pj.drift.corrected") : t("pj.drift.kept")}`),
      ),
    );
    const confirmed = (message: MessageKey, scope: "proxies" | "all"): void => {
      if (confirm(t(message))) void run(() => api.dropCache(scope));
    };
    setChildren(
      detHost,
      h("p", { class: "ws-guide" }, t("flow.det.lead")),
      h(
        "section",
        { class: "stack" },
        h("h3", {}, t("flow.det.tracks")),
        h("p", { class: "hint" }, t("flow.det.sync")),
        scrollable(
          h(
            "table",
            { class: "data-table", "data-testid": "pj-sources" },
            h("thead", {}, h("tr", {}, h("th", {}, t("pj.col.track")), h("th", {}, t("pj.col.start")), h("th", {}, t("pj.col.length")), h("th", {}, t("flow.det.col.speed")))),
            h("tbody", {}, ...rows),
          ),
        ),
        ...driftWarnings(project),
        h("p", { class: "hint" }, t("pj.duration", { time: formatDuration(project.durationMs / 1000) })),
      ),
      h(
        "section",
        { class: "stack" },
        h("h3", {}, t("flow.det.files")),
        h("p", { class: "hint" }, t("flow.det.filesHint")),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-prepare-again", disabled: busy || lowDisk, onclick: () => void run(() => api.startJob("conform")) }, conform.status === "done" ? t("flow.det.prepareAgain") : t("flow.det.prepare"))),
        h(
          "div",
          { class: "row" },
          languageField("pj-tr-lang-again"),
          h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-tr-start", disabled: !ready || busy || lowDisk, onclick: () => void run(() => api.startJob("transcribe", { lang: trLang })) }, transcript.status === "done" ? t("pj.tr.again") : t("pj.tr.start")),
        ),
        ready ? null : h("p", { class: "hint" }, t("pj.tr.needMedia")),
        h("p", { class: "hint" }, t("pj.tr.hint")),
        conform.status === "done" || project.sources.some((source) => source.audio || source.video)
          ? h(
              "div",
              { class: "row" },
              h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-drop-proxies", disabled: busy, onclick: () => confirmed("pj.drop.proxiesConfirm", "proxies") }, t("flow.det.dropPreview")),
              h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-drop-all", disabled: busy, onclick: () => confirmed("pj.drop.allConfirm", "all") }, t("flow.det.dropAll")),
            )
          : null,
        disk.freeBytes !== null ? h("p", { class: "hint", "data-testid": "pj-disk" }, t("pj.disk", { free: formatBytes(disk.freeBytes), min: formatBytes(disk.minFreeBytes) })) : null,
        h("p", { class: "hint" }, t("pj.retention")),
      ),
    );
  }

  // ---- the step bar and the lead sentence --------------------------------------------------------------------------------
  const lead = h("p", { class: "lead ws-lead", "data-testid": "pj-lead" });

  function updateMarks(): void {
    const current = state;
    if (!current) return;
    const { project, jobs } = current;
    const working = (match: (job: JobRecord) => boolean): boolean => jobs.some((job) => ACTIVE.has(job.status) && match(job));
    const clipJobs = new Set(jobs.filter(isClipRender).map((job) => job.id));
    const preparing = chain !== null || working((job) => job.kind === "conform" || job.kind === "transcribe");
    tabs.setMark("prepare", preparing ? "working" : hasAudio(project) && project.transcript.status === "done" ? "done" : "todo");
    // the episode is exported as video, or as audio when the project has no picture; a clip render is a short, not the episode
    const episodeDone = exportList.some((record) => presetById(record.preset) !== null && !clipJobs.has(record.id));
    tabs.setMark("episode", working((job) => job.kind === "render" && !isClipRender(job)) ? "working" : episodeDone ? "done" : "todo");
    tabs.setMark("shorts", working(isClipRender) ? "working" : exportList.some((record) => clipJobs.has(record.id)) ? "done" : "todo");
    tabs.setMark("cover", working((job) => job.kind === "thumbnail" || job.kind === "thumbnail-previews") ? "working" : exportList.some((record) => record.preset.startsWith("thumbnail-")) ? "done" : "todo");
  }

  function syncPanels(current: ProjectState): void {
    syncTranscript(current);
    syncLayout(current.project);
    renderEpisode(current);
  }

  // ---- the page ----------------------------------------------------------------------------------------------------------
  const noneHost = h("div", { class: "stack" });
  const noneCard = card(null, noneHost);
  const workspace = h(
    "div",
    { class: "ws", hidden: true },
    trSection,
    h("div", { class: "ws-main" }, stageSection, h("section", { class: "card ws-body" }, tabs.panels)),
  );
  const stepBar = h("div", { class: "card ws-steps", hidden: true }, tabs.bar);

  function render(): void {
    if (!state) {
      workspace.hidden = true;
      stepBar.hidden = true;
      lead.hidden = true;
      noneCard.hidden = false;
      setChildren(
        noneHost,
        h("p", {}, t("pj.none")),
        missing ? h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-create", onclick: () => void run(() => api.create()) }, t("pj.create")) : null,
      );
      return;
    }
    const { project } = state;
    noneCard.hidden = true;
    workspace.hidden = false;
    stepBar.hidden = false;
    lead.hidden = false;
    const prepared = hasAudio(project) && project.transcript.status === "done";
    lead.textContent = t(prepared ? "flow.lead.ready" : "flow.lead.prepare");
    // until the user picks a step, the page shows the first one that is not done
    if (!stepChosen) tabs.select(prepared ? "episode" : "prepare");

    const available = hasAudio(project);
    needEpisode.hidden = available;
    epBody.hidden = !available;
    needShorts.hidden = available;
    shortsBody.hidden = !available;
    needCover.hidden = available;
    coverBody.hidden = !available;

    renderPrepare(state);
    renderDetails(state);
    syncStage(project);
    stg?.setMedia(project);
    syncPanels(state);
    syncExport(state);
    syncPublishing(state);
    updateMarks();
  }

  const el = page(
    h("header", { class: "ws-head" }, h("h1", { class: "page-title" }, t("flow.title")), h("span", { class: "hint", "data-testid": "pj-sid" }, t("room.session", { id: api.sid.slice(0, 8) }))),
    lead,
    stepBar,
    notice,
    noneCard,
    workspace,
  );
  void refresh();
  return {
    el,
    dispose: () => {
      disposed = true;
      window.clearTimeout(timer);
      wide.removeEventListener("change", keepOpen);
      trPanel?.dispose();
      layPanel?.dispose();
      exPanel?.dispose();
      clPanel?.dispose();
      pubPanel?.dispose();
      stg?.dispose();
    },
  };
}
