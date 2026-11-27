import type { JobRecord } from "../../shared/project.js";
import { h, setChildren } from "../lib/dom.js";
import type { EditState } from "../lib/edit-state.js";
import type { ProjectApi } from "../lib/project-api.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { failureBanner, progressBar, stageLabel } from "./job-status.js";

/** The newest job of a kind, by creation time. */
function latest(jobs: JobRecord[], kind: string, status?: JobRecord["status"]): JobRecord | undefined {
  return jobs.filter((job) => job.kind === kind && (status === undefined || job.status === status)).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
}

/**
 * Renders the edit to one audio file on the collector so the user can hear the real joins. The job list comes from the
 * page's status polling (`update`); the audio element of a finished render is created once per job and kept.
 */
export function cutPreview(api: ProjectApi, edit: EditState, start: () => Promise<void>): { el: HTMLElement; update: (jobs: JobRecord[]) => void; dispose: () => void } {
  const button = h("button", { type: "button", class: "btn", "data-testid": "pj-ed-render" }, t("pj.ed.render"));
  const progress = h("div");
  const result = h("div", { class: "stack" });
  let shownId = "";
  let doneJob: JobRecord | undefined;
  let busy = false;
  let running = false;

  const stale = h("p", { class: "hint", "data-testid": "pj-ed-cut-stale", hidden: true }, t("pj.ed.render.stale"));

  function refreshStale(): void {
    stale.hidden = !doneJob || (doneJob.result?.rev === edit.rev && edit.status === "saved");
  }

  function update(jobs: JobRecord[]): void {
    const active = latest(jobs, "cut-preview", "queued") ?? latest(jobs, "cut-preview", "running");
    const newest = latest(jobs, "cut-preview");
    running = active !== undefined;
    button.disabled = busy || running;
    if (active) {
      const percent = Math.round(active.progress * 100);
      setChildren(
        progress,
        progressBar(percent, t("pj.ed.render.title"), active.stage),
        h("p", { class: "hint", "data-testid": "pj-ed-render-progress" }, `${percent}% ${stageLabel(active.stage)}`.trim()),
      );
    } else if (newest?.status === "failed") {
      setChildren(progress, failureBanner("pj.job.cutPreview", newest.error ?? "?", "pj-ed-render-error"));
    } else {
      setChildren(progress);
    }
    doneJob = latest(jobs, "cut-preview", "done");
    const file = typeof doneJob?.result?.file === "string" ? doneJob.result.file : null;
    const id = doneJob && file ? doneJob.id : "";
    if (id !== shownId) {
      shownId = id;
      if (!doneJob || !file) {
        setChildren(result);
      } else {
        const url = api.mediaUrl(file);
        const keptMs = typeof doneJob.result?.keptMs === "number" ? doneJob.result.keptMs : null;
        setChildren(
          result,
          h("audio", { controls: true, preload: "none", src: url, "data-testid": "pj-ed-cut-audio" }),
          h("div", { class: "row" }, h("a", { class: "btn btn-small", href: url, download: "mix-cut.m4a", "data-testid": "pj-ed-cut-link" }, t("pj.ed.render.download")), keptMs !== null ? h("span", { class: "hint" }, t("pj.ed.render.length", { time: formatClock(keptMs) })) : null),
        );
      }
    }
    refreshStale();
  }

  button.addEventListener("click", () => {
    busy = true;
    button.disabled = true;
    // the render reads the saved edit, so whatever is still waiting in the debounce goes first
    void edit
      .flush()
      .then(start)
      .finally(() => {
        busy = false;
        button.disabled = running;
      });
  });
  const unsubscribe = edit.subscribe(refreshStale);
  refreshStale();

  const el = h("div", { class: "stack", "data-testid": "pj-ed-preview" }, h("h4", {}, t("pj.ed.render.title")), h("p", { class: "hint" }, t("pj.ed.render.hint")), h("div", { class: "row" }, button), progress, result, stale);
  return { el, update, dispose: unsubscribe };
}
