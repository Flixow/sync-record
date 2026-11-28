// The thumbnail block of the publish panel, in three steps: pick a frame (pictures the server ranked by light, colour and
// sharpness), add a headline (ideas from the words spoken at that frame), then make the 4K picture. Everything is made on the
// server from the recording; nothing is sent anywhere. Frames and headline ideas come from jobs and requests of their own.

import type { JobRecord } from "../../shared/project.js";
import { overlayTextLayout, thumbnailSpec, type ThumbnailKind } from "../../shared/publish.js";
import type { ThumbnailPreview, ThumbnailPreviewsResult } from "../../shared/thumb-score.js";
import { defaultTextSide, HOOK_MAX_CHARS, HOOK_MAX_WORDS, normalizeHook, THUMBNAIL_COLOR_HEX, THUMBNAIL_COLORS, THUMBNAIL_SIDES, type ThumbnailColor, type ThumbnailSide } from "../../shared/thumb-style.js";
import { h, setChildren } from "../lib/dom.js";
import type { ExportRecord, ProjectApi, ProjectState, ThumbnailHooksReport } from "../lib/project-api.js";
import { formatBytes } from "../lib/storage-math.js";
import { formatClock } from "../lib/time.js";
import { t } from "../i18n/index.js";
import { failureBanner, progressBar } from "./job-status.js";
import { banner } from "./layout.js";

const KINDS: ThumbnailKind[] = ["video", "short"];
const ACTIVE = new Set(["queued", "running"]);
/** Headline ideas are asked for this long after the last frame was picked, so flipping through frames does not ask the model for each. */
const IDEAS_DELAY_MS = 400;

export interface ThumbnailSectionHooks {
  /** Runs a call that changes the project or reads from it: shows its error and refreshes the page's state. */
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Whether the language model may write the headline ideas: the page's checkbox. */
  useModel: () => boolean;
  /** The draft title the ideas must not repeat, when there is one. */
  title: () => string | undefined;
}

export interface ThumbnailSection {
  el: HTMLElement;
  /** The page's latest state, whether the transcript is done and whether the recording has a picture. */
  update(state: ProjectState, ready: boolean, picture: boolean): void;
  /** The page's checkbox for the model changed: ask for ideas again. */
  refreshIdeas(): void;
  dispose(): void;
}

const newestFirst = (a: JobRecord, b: JobRecord): number => b.createdAtMs - a.createdAtMs;
const wordsIn = (text: string): number => text.split(/\s+/u).filter((word) => word !== "").length;
const percentOf = (job: JobRecord): number => Math.round(job.progress * 100);
const ended = (job: JobRecord | undefined): boolean => job !== undefined && (job.status === "failed" || job.status === "canceled");

export function thumbnailSection(api: ProjectApi, hooks: ThumbnailSectionHooks): ThumbnailSection {
  let state: ProjectState | null = null;
  let ready = false;
  let picture = false;
  let kind: ThumbnailKind = "video";
  let picked: number | null = null;
  let nearbyFor: number | null = null;
  let side: ThumbnailSide = defaultTextSide();
  let color: ThumbnailColor = "white";
  /** The user typed or cleared the headline: new ideas no longer fill it in. */
  let textEdited = false;
  let ideas: ThumbnailHooksReport | null = null;
  let ideasStatus: "loading" | "ready" | "failed" = "ready";
  let ideasKey = "";
  let ideasSeq = 0;
  let ideasTimer: number | undefined;
  const startedFor = new Set<string>();
  let exports: ExportRecord[] = [];
  let lastDone = "";
  let framesSignature = "";
  let statusSignature = "";
  let initialised = false;
  let disposed = false;

  const noPicture = h("p", { class: "hint", "data-testid": "pj-pub-thumb-nopicture", hidden: true }, t("pj.pub.thumb.noVideo"));
  const kindButtons = KINDS.map((value) => h("button", { type: "button", class: "btn btn-small toggle", "data-testid": `pj-pub-kind-${value}`, "aria-pressed": String(value === kind), onclick: () => setKind(value) }, t(`pj.pub.thumb.${value}`)));
  const spec = h("p", { class: "hint", "data-testid": "pj-pub-thumb-spec" });
  const framesHost = h("div", { class: "stack", "data-testid": "pj-pub-moments" });

  // headline: the chosen frame with the lettering as the server will place it, the field, ideas and the look
  const stageImg = h("img", { alt: t("thumb.preview.alt"), "data-testid": "pj-pub-thumb-stage-img" });
  const headline = h("div", { class: "thumb-headline", "data-testid": "pj-pub-thumb-headline" });
  const stage = h(
    "figure",
    { class: "thumb-figure", "data-testid": "pj-pub-thumb-stage", hidden: true },
    h("div", { class: "thumb-stage" }, stageImg, headline),
    h("figcaption", { class: "hint" }, t("thumb.preview.note")),
  );
  const input = h("input", { type: "text", maxlength: String(HOOK_MAX_CHARS), placeholder: t("thumb.headline.placeholder"), "data-testid": "pj-pub-thumb-text", "aria-label": t("thumb.headline"), oninput: () => onTyped() });
  const counter = h("span", { class: "hint", "data-testid": "pj-pub-thumb-words" });
  const ideasHost = h("div", { class: "stack", "data-testid": "pj-pub-hooks" });
  const colorButtons = THUMBNAIL_COLORS.map((value) =>
    h(
      "button",
      {
        type: "button",
        class: "btn btn-small toggle",
        "data-testid": `pj-pub-thumb-color-${value}`,
        "aria-pressed": String(value === color),
        onclick: () => {
          color = value;
          syncLook();
        },
      },
      h("span", { class: "thumb-swatch", style: `background:#${THUMBNAIL_COLOR_HEX[value]}` }),
      t(`thumb.color.${value}`),
    ),
  );
  const sideButtons = THUMBNAIL_SIDES.map((value) =>
    h(
      "button",
      {
        type: "button",
        class: "btn btn-small toggle",
        "data-testid": `pj-pub-thumb-side-${value}`,
        "aria-pressed": String(value === side),
        onclick: () => {
          side = value;
          syncLook();
        },
      },
      t(`thumb.side.${value}`),
    ),
  );
  const sideRow = h("div", { class: "row", role: "group", "aria-label": t("thumb.side") }, h("span", { class: "hint" }, t("thumb.side")), ...sideButtons);
  const shortNote = h("p", { class: "hint", "data-testid": "pj-pub-thumb-top-note", hidden: true }, t("thumb.side.short"));

  // the picture
  const createButton = h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-pub-thumb-create", disabled: true, onclick: () => create() }, t("pj.pub.thumb.create"));
  const statusHost = h("div", { class: "stack", "data-testid": "pj-pub-thumb-status" });
  const controls = h(
    "div",
    { class: "stack" },
    h("div", { class: "row", role: "group", "aria-label": t("pj.pub.thumb.shape") }, ...kindButtons),
    spec,
    h("h5", {}, t("thumb.step.frame")),
    h("p", { class: "hint", "data-testid": "pj-pub-thumb-hint" }, t("thumb.frame.hint")),
    framesHost,
    h("h5", {}, t("thumb.step.headline")),
    stage,
    h("div", { class: "field" }, h("span", {}, t("thumb.headline")), input, counter),
    ideasHost,
    h("div", { class: "row", role: "group", "aria-label": t("thumb.color") }, h("span", { class: "hint" }, t("thumb.color")), ...colorButtons),
    sideRow,
    shortNote,
    h("h5", {}, t("thumb.step.create")),
    h("div", { class: "row" }, createButton),
    statusHost,
    h("p", { class: "hint", "data-testid": "pj-pub-thumb-privacy" }, t("thumb.privacy")),
  );

  const el = h("div", { class: "ex-block", "data-testid": "pj-pub-thumb-block" }, h("h4", {}, t("pj.pub.thumb")), h("p", { class: "hint" }, t("thumb.lead")), noPicture, controls);

  // ---- frames ----

  /** The newest previews job of the chosen shape: of the best frames of the recording, or of the frames around one moment. */
  function previewsJob(around: number | null): JobRecord | undefined {
    const jobs = (state?.jobs ?? []).filter((job) => job.kind === "thumbnail-previews" && job.params.kind === kind && (around === null ? job.params.around === undefined : job.params.around === around));
    return jobs.sort(newestFirst)[0];
  }

  function previewsOf(job: JobRecord | undefined): ThumbnailPreview[] {
    if (job?.status !== "done") return [];
    const result = job.result as ThumbnailPreviewsResult | null;
    return result?.previews ?? [];
  }

  const knownFrames = (): ThumbnailPreview[] => [...previewsOf(previewsJob(null)), ...(nearbyFor === null ? [] : previewsOf(previewsJob(nearbyFor)))];

  /** What the frames area shows, as a string: it is redrawn only when this changes, never for the frame that is picked. */
  function framesKey(): string {
    const main = previewsJob(null);
    const near = nearbyFor === null ? undefined : previewsJob(nearbyFor);
    return JSON.stringify([kind, nearbyFor, main?.id, main?.status, main ? percentOf(main) : 0, near?.id, near?.status, near ? percentOf(near) : 0]);
  }

  function startPreviews(around?: number): void {
    void hooks.run(() => api.thumbnailPreviews(kind, around));
  }

  /** Queues the frames of the recording the first time they are needed, and again when the transcript they were chosen from has changed. */
  function startIfNeeded(): void {
    if (!ready || !picture || state === null) return;
    const spokenAt = state.project.transcript.atMs ?? 0;
    const key = `${kind}|${spokenAt}`;
    if (startedFor.has(key)) return;
    const job = previewsJob(null);
    if (job !== undefined && !(job.status === "done" && job.createdAtMs < spokenAt)) return;
    startedFor.add(key);
    startPreviews();
  }

  function pickButton(frame: ThumbnailPreview, testId: string): HTMLButtonElement {
    return h(
      "button",
      { type: "button", class: "thumb-pick", "data-testid": testId, "data-at": String(frame.atMs), "aria-pressed": String(frame.atMs === picked), onclick: () => pick(frame.atMs) },
      h("img", { src: api.mediaUrl(frame.file), alt: "", loading: "lazy" }),
      h("span", { class: "thumb-pick-meta" }, h("span", {}, formatClock(frame.atMs)), frame.weak ? h("span", { class: "thumb-weak" }, t(`thumb.weak.${frame.weak}`)) : null),
    );
  }

  const strip = (list: ThumbnailPreview[], testId: string, label: string): HTMLElement => h("div", { class: "thumb-strip", "data-kind": kind, role: "group", "aria-label": label }, ...list.map((frame) => pickButton(frame, testId)));

  function jobProgress(job: JobRecord): HTMLElement {
    return h("div", { class: "stack" }, progressBar(percentOf(job), t("thumb.step.frame"), job.stage), h("p", { class: "hint", "data-testid": "pj-pub-thumb-frames-progress", "data-status": job.status }, t("thumb.frames.loading", { percent: percentOf(job) })));
  }

  const jobFailure = (job: JobRecord, testId: string): HTMLElement => (job.status === "failed" ? failureBanner("thumb.frames.failed", job.error, testId) : banner("warn", t("thumb.frames.canceled"), testId));

  function renderFrames(): void {
    framesSignature = framesKey();
    const main = previewsJob(null);
    const near = nearbyFor === null ? undefined : previewsJob(nearbyFor);
    const list = previewsOf(main);
    const nearList = previewsOf(near);
    if (picked === null || !knownFrames().some((frame) => frame.atMs === picked)) picked = list[0]?.atMs ?? null;
    const nearbyBlock =
      list.length === 0
        ? null
        : h(
            "div",
            { class: "stack" },
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-pub-thumb-nearby", disabled: picked === null || (near !== undefined && ACTIVE.has(near.status)), onclick: () => showNearby() }, t("thumb.nearby")),
              h("span", { class: "hint ex-hint" }, t("thumb.nearby.hint")),
            ),
            near && ACTIVE.has(near.status) ? jobProgress(near) : null,
            near && ended(near) ? jobFailure(near, "pj-pub-thumb-nearby-error") : null,
            nearList.length > 0 && nearbyFor !== null ? strip(nearList, "pj-pub-nearby-moment", t("thumb.nearby.group", { time: formatClock(nearbyFor) })) : null,
          );
    setChildren(
      framesHost,
      main && ACTIVE.has(main.status) ? jobProgress(main) : null,
      main && ended(main) ? h("div", { class: "stack" }, jobFailure(main, "pj-pub-thumb-frames-error"), h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-pub-thumb-retry", onclick: () => startPreviews() }, t("thumb.frames.retry")))) : null,
      main?.status === "done" && list.length === 0 ? h("p", { class: "hint", "data-testid": "pj-pub-thumb-none" }, t("pj.pub.thumb.none")) : null,
      list.length > 0 ? strip(list, "pj-pub-moment", t("pj.pub.thumb.moments")) : null,
      list.some((frame) => frame.weak !== null) ? h("p", { class: "hint", "data-testid": "pj-pub-thumb-weak" }, t("thumb.frames.weakNote")) : null,
      nearbyBlock,
    );
    paintStage();
    syncCreate();
    scheduleIdeas();
  }

  function pick(atMs: number): void {
    picked = atMs;
    for (const button of framesHost.querySelectorAll<HTMLButtonElement>("button.thumb-pick")) button.setAttribute("aria-pressed", String(Number(button.dataset.at) === picked));
    paintStage();
    syncCreate();
    scheduleIdeas();
  }

  /** Asks for the frames just before and after the picked one: a blink lasts a fraction of a second. */
  function showNearby(): void {
    const around = picked;
    if (around === null) return;
    nearbyFor = around;
    const existing = previewsJob(around);
    if (existing === undefined || ended(existing)) startPreviews(around);
    renderFrames();
  }

  function setKind(next: ThumbnailKind): void {
    if (next === kind) return;
    kind = next;
    picked = null;
    nearbyFor = null;
    kindButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(KINDS[index] === kind)));
    sideRow.hidden = kind === "short";
    shortNote.hidden = kind !== "short";
    paintSpec();
    startIfNeeded();
    renderFrames();
    renderStatus();
  }

  function paintSpec(): void {
    const size = thumbnailSpec(kind);
    spec.textContent = t("pj.pub.thumb.spec", { width: size.width, height: size.height, mb: Math.round(size.maxBytes / (1024 * 1024)) });
  }

  // ---- headline ----

  /** The chosen frame with the headline laid out the way the server will place it (its own font and the real size aside). */
  function paintStage(): void {
    const shown = knownFrames().find((frame) => frame.atMs === picked);
    stage.hidden = shown === undefined;
    stage.dataset.kind = kind;
    if (shown) {
      const src = api.mediaUrl(shown.file);
      if (stageImg.getAttribute("src") !== src) stageImg.src = src;
    }
    paintHeadline();
  }

  function paintHeadline(): void {
    const count = wordsIn(input.value);
    counter.textContent = count === 0 ? "" : count > HOOK_MAX_WORDS ? t("thumb.words.over", { max: HOOK_MAX_WORDS }) : t("thumb.words", { count, max: HOOK_MAX_WORDS });
    counter.classList.toggle("thumb-over", count > HOOK_MAX_WORDS);
    const text = normalizeHook(input.value).toUpperCase();
    headline.hidden = text === "";
    if (text === "") return;
    const canvas = thumbnailSpec(kind);
    const layout = overlayTextLayout(text, canvas, kind === "short" ? "top" : side);
    const share = (value: number, whole: number): string => `${((value / whole) * 100).toFixed(3)}%`;
    headline.setAttribute("style", `left:${share(layout.box.x, canvas.width)};top:${share(layout.box.y, canvas.height)};width:${share(layout.box.w, canvas.width)};height:${share(layout.box.h, canvas.height)};color:#${THUMBNAIL_COLOR_HEX[color]}`);
    setChildren(headline, ...layout.lines.map((line) => h("div", { style: `font-size:${((layout.fontSize / canvas.width) * 100).toFixed(3)}cqw` }, line)));
  }

  function setText(value: string): void {
    input.value = value;
    paintHeadline();
  }

  function onTyped(): void {
    textEdited = true;
    paintHeadline();
  }

  function syncLook(): void {
    colorButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(THUMBNAIL_COLORS[index] === color)));
    sideButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(THUMBNAIL_SIDES[index] === side)));
    paintHeadline();
  }

  function renderIdeas(): void {
    const report = ideas;
    const note = report === null ? null : report.llmUsed ? "model" : report.llmFailure !== null ? "modelFailed" : "rules";
    setChildren(
      ideasHost,
      ideasStatus === "loading" ? h("p", { class: "hint", "data-testid": "pj-pub-hooks-loading" }, t("thumb.hooks.loading")) : null,
      ideasStatus === "failed" ? h("p", { class: "hint", "data-testid": "pj-pub-hooks-failed" }, t("thumb.hooks.failed")) : null,
      ideasStatus === "ready" && report && report.hooks.length === 0 ? h("p", { class: "hint", "data-testid": "pj-pub-hooks-none" }, t("thumb.hooks.none")) : null,
      ideasStatus === "ready" && report && report.hooks.length > 0
        ? h(
            "div",
            { class: "row", role: "group", "aria-label": t("thumb.hooks.title") },
            h("span", { class: "hint" }, t("thumb.hooks.title")),
            ...report.hooks.map((hook) =>
              h(
                "button",
                {
                  type: "button",
                  class: "thumb-hook",
                  "data-testid": "pj-pub-hook-chip",
                  onclick: () => {
                    textEdited = false;
                    setText(hook);
                  },
                },
                hook,
              ),
            ),
          )
        : null,
      ideasStatus === "ready" && note !== null ? h("p", { class: "hint", "data-testid": "pj-pub-hooks-note", "data-source": note }, t(`thumb.hooks.${note}`)) : null,
    );
  }

  /** Asks for headline ideas for the picked frame once the picking has settled; an answer for a frame that is no longer picked is dropped. */
  function scheduleIdeas(): void {
    if (!ready || !picture || picked === null) return;
    const atMs = picked;
    const model = hooks.useModel();
    const key = `${atMs}|${model}`;
    if (key === ideasKey) return;
    ideasKey = key;
    const seq = ++ideasSeq;
    window.clearTimeout(ideasTimer);
    ideasStatus = "loading";
    renderIdeas();
    ideasTimer = window.setTimeout(() => {
      void api
        .thumbnailHooks(atMs, model, hooks.title())
        .then((report) => {
          if (disposed || seq !== ideasSeq) return;
          ideas = report;
          ideasStatus = "ready";
          if (!textEdited) setText(report.hooks[0] ?? "");
        })
        .catch(() => {
          if (disposed || seq !== ideasSeq) return;
          ideas = null;
          ideasStatus = "failed";
        })
        .finally(() => {
          if (!disposed && seq === ideasSeq) renderIdeas();
        });
    }, IDEAS_DELAY_MS);
  }

  // ---- the picture ----

  const newestThumbnailJob = (): JobRecord | undefined => (state?.jobs ?? []).filter((job) => job.kind === "thumbnail").sort(newestFirst)[0];

  function syncCreate(): void {
    const job = newestThumbnailJob();
    createButton.disabled = picked === null || !picture || (job !== undefined && ACTIVE.has(job.status));
  }

  function create(): void {
    const atMs = picked;
    if (atMs === null) return;
    const text = input.value.trim();
    void hooks.run(() => api.startJob("thumbnail", { atMs, kind, text, color, ...(kind === "video" ? { side } : {}) }));
  }

  /** What the status area shows, as a string: it is redrawn only when this changes. */
  function statusKey(): string {
    const job = newestThumbnailJob();
    return JSON.stringify([job?.id, job?.status, job ? percentOf(job) : 0, exports.find((item) => item.preset === `thumbnail-${kind}`)?.id, kind]);
  }

  /** The progress or failure of the newest thumbnail job and the picture of the newest thumbnail of the chosen shape. */
  function renderStatus(): void {
    const job = newestThumbnailJob();
    const active = job !== undefined && ACTIVE.has(job.status);
    const record = exports.find((item) => item.preset === `thumbnail-${kind}`);
    statusSignature = statusKey();
    setChildren(
      statusHost,
      job && active
        ? h(
            "div",
            { class: "stack" },
            progressBar(percentOf(job), t("pj.pub.thumb"), job.stage),
            h("p", { class: "hint", "data-testid": "pj-pub-thumb-progress", "data-status": job.status }, t("pj.pub.thumb.progress", { percent: percentOf(job) })),
          )
        : null,
      job?.status === "failed" ? failureBanner("pj.pub.thumb.failed", job.error, "pj-pub-thumb-error") : null,
      record
        ? h(
            "figure",
            { class: "pub-thumb", "data-testid": "pj-pub-thumb-result", "data-id": record.id },
            h("img", { src: api.mediaUrl(record.file), alt: t("pj.pub.thumb.alt"), "data-testid": "pj-pub-thumb-img" }),
            h(
              "figcaption",
              { class: "row hint" },
              h("span", {}, `${t("pj.pub.thumb.latest")} · ${formatBytes(record.bytes)}`),
              h("a", { class: "btn btn-small", href: api.mediaUrl(record.file), download: record.file.split("/").pop() ?? record.file, "data-testid": "pj-pub-thumb-download" }, t("pj.ex.download")),
            ),
          )
        : null,
    );
  }

  async function loadExports(): Promise<void> {
    const list = await api.exports();
    if (disposed) return;
    exports = list;
    renderStatus();
  }

  function update(next: ProjectState, isReady: boolean, hasPicture: boolean): void {
    state = next;
    ready = isReady;
    picture = hasPicture;
    noPicture.hidden = picture;
    controls.hidden = !picture;
    if (!initialised) {
      initialised = true;
      // the list is only needed for the picture of the latest thumbnail; a failed read leaves it empty
      void loadExports().catch(() => undefined);
    }
    startIfNeeded();
    if (framesKey() !== framesSignature) renderFrames();
    syncCreate();
    scheduleIdeas();
    // a thumbnail that has just finished: its file is in the list now
    const finished = next.jobs.filter((job) => job.kind === "thumbnail" && job.status === "done").sort(newestFirst)[0];
    if (finished && finished.id !== lastDone) {
      lastDone = finished.id;
      void loadExports().catch(() => undefined);
    }
    if (statusKey() !== statusSignature) renderStatus();
  }

  paintSpec();
  renderFrames();
  renderIdeas();
  renderStatus();

  return {
    el,
    update,
    refreshIdeas() {
      ideasKey = "";
      scheduleIdeas();
    },
    dispose() {
      disposed = true;
      window.clearTimeout(ideasTimer);
      el.replaceChildren();
    },
  };
}
