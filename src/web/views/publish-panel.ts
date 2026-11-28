import { formatChapters, MIN_CHAPTERS, type ChapterIssue } from "../../shared/chapters.js";
import { copyField } from "../lib/clipboard.js";
import { h, setChildren } from "../lib/dom.js";
import type { ChaptersReport, ProjectApi, ProjectState, PublishDraftReport } from "../lib/project-api.js";
import { t } from "../i18n/index.js";
import { banner } from "./layout.js";
import { thumbnailSection } from "./thumbnail-section.js";

export interface PublishPanelHooks {
  /** Runs a call that changes the project or reads from it: shows its error and refreshes the page's state. */
  run: (action: () => Promise<unknown>) => Promise<void>;
}

export interface PublishPanel {
  el: HTMLElement;
  /** The page's latest state: the transcript status, the thumbnail jobs and whether there is a picture. */
  update(state: ProjectState): void;
  dispose(): void;
}

function issueText(issue: ChapterIssue): string {
  switch (issue.code) {
    case "too-few":
      return t("pj.pub.issue.tooFew", { min: MIN_CHAPTERS, count: issue.count });
    case "bad-start":
      return t("pj.pub.issue.badStart", { n: issue.chapter });
    case "no-title":
      return t("pj.pub.issue.noTitle", { n: issue.chapter });
    case "first-not-zero":
      return t("pj.pub.issue.firstNotZero");
    case "not-ascending":
      return t("pj.pub.issue.notAscending", { n: issue.chapter, prev: issue.chapter - 1 });
    case "too-close":
      return t("pj.pub.issue.tooClose", { n: issue.chapter, prev: issue.chapter - 1 });
    case "last-too-short":
      return t("pj.pub.issue.lastTooShort");
  }
}

function readonlyInput(value: string, testId: string, label: string): HTMLInputElement {
  const input = h("input", { type: "text", readonly: true, "data-testid": testId, "aria-label": label });
  input.value = value;
  return input;
}

function readonlyArea(value: string, rows: number, testId: string, label: string): HTMLTextAreaElement {
  const area = h("textarea", { class: "pub-text", readonly: true, rows: String(rows), "data-testid": testId, "aria-label": label });
  area.value = value;
  return area;
}

/** A button that copies a read-only field and says so for a moment. */
function copyButton(field: HTMLInputElement | HTMLTextAreaElement, testId: string, label: string): HTMLButtonElement {
  const button = h(
    "button",
    {
      type: "button",
      class: "btn btn-small",
      "data-testid": testId,
      onclick: () =>
        void copyField(field).then((copied) => {
          if (!copied) return;
          button.textContent = t("pj.pub.copied");
          window.setTimeout(() => {
            button.textContent = label;
          }, 1500);
        }),
    },
    label,
  );
  return button;
}

/**
 * Publishing helpers: the chapters of the edited program as YouTube wants them, a draft title and description, and the
 * thumbnail (thumbnail-section.ts). Everything is made on the server from the transcript and the recording; the local
 * language model is only asked when the user ticks the box.
 */
export function publishPanel(api: ProjectApi, hooks: PublishPanelHooks): PublishPanel {
  let ready = false;
  let picture = false;
  let chapters: ChaptersReport | null = null;
  let chaptersKey = "";
  let draft: PublishDraftReport | null = null;
  let drafting = false;
  let draftWithModel = false;
  let initialised = false;
  let disposed = false;

  const needTranscript = h("p", { class: "hint", "data-testid": "pj-pub-need-transcript", hidden: true }, t("pj.pub.needTranscript"));

  // chapters
  const chaptersHost = h("div", { class: "stack", "data-testid": "pj-pub-chapters" });
  const refreshButton = h("button", { type: "button", class: "btn btn-small", "data-testid": "pj-pub-chapters-refresh", disabled: true, onclick: () => void hooks.run(loadChapters) }, t("pj.pub.chapters.refresh"));

  async function loadChapters(): Promise<void> {
    chapters = await api.chapters();
    if (!disposed) renderChapters();
  }

  function renderChapters(): void {
    const report = chapters;
    if (!report) {
      setChildren(chaptersHost);
      return;
    }
    const text = readonlyArea(report.text, Math.min(12, Math.max(3, report.chapters.length)), "pj-pub-chapters-text", t("pj.pub.chapters"));
    setChildren(
      chaptersHost,
      report.chapters.length === 0 ? h("p", { class: "hint", "data-testid": "pj-pub-chapters-none" }, t("pj.pub.chapters.none")) : text,
      report.validation.ok
        ? banner("ok", t("pj.pub.chapters.ok"), "pj-pub-chapters-ok")
        : h("div", { class: "banner banner-warn", role: "status", "data-testid": "pj-pub-chapters-issues" }, h("p", {}, t("pj.pub.chapters.bad")), h("ul", {}, ...report.validation.issues.map((issue) => h("li", { "data-code": issue.code }, issueText(issue))))),
      report.chapters.length === 0 ? null : h("div", { class: "row" }, copyButton(text, "pj-pub-chapters-copy", t("pj.pub.chapters.copy"))),
    );
  }

  // title and description
  const llmToggle = h("input", { type: "checkbox", "data-testid": "pj-pub-llm" });
  const draftButton = h("button", { type: "button", class: "btn btn-primary", "data-testid": "pj-pub-draft", disabled: true, onclick: () => makeDraft() }, t("pj.pub.draft.make"));
  const draftHost = h("div", { class: "stack", "data-testid": "pj-pub-draft-result" });
  const llmHint = h("span", { class: "hint ex-hint", "data-testid": "pj-pub-llm-hint" }, t("pj.pub.llm.hint"));

  function makeDraft(): void {
    drafting = true;
    draftButton.disabled = true;
    renderDraft();
    void hooks.run(async () => {
      try {
        draftWithModel = llmToggle.checked;
        draft = await api.publishDraft(draftWithModel);
        // chapters the model retitled replace the list shown above, so the list and the description agree
        if (draft.llmUsed && chapters) chapters = { chapters: draft.chapters, validation: draft.validation, text: formatChapters(draft.chapters), llmUsed: draft.llmUsed, llmAvailable: draft.llmAvailable };
      } finally {
        drafting = false;
        if (!disposed) {
          renderChapters();
          draftButton.disabled = !ready;
          renderDraft();
        }
      }
    });
  }

  function renderDraft(): void {
    if (drafting) {
      setChildren(draftHost, h("p", { class: "hint", "data-testid": "pj-pub-drafting" }, t("pj.pub.draft.working")));
      return;
    }
    const result = draft;
    if (!result) {
      setChildren(draftHost);
      return;
    }
    const llm = result.llmUsed ? "used" : result.llmAvailable ? "failed" : "unavailable";
    const description = readonlyArea(result.draft.description, 10, "pj-pub-description", t("pj.pub.description"));
    const tags = readonlyInput(result.draft.tags.join(", "), "pj-pub-tags", t("pj.pub.tags"));
    const note = draftWithModel ? banner(llm === "used" ? "info" : "warn", t(`pj.pub.llm.${llm}`), "pj-pub-llm-note") : null;
    note?.setAttribute("data-state", llm);
    setChildren(
      draftHost,
      note,
      h("h5", {}, t("pj.pub.titles")),
      ...result.draft.titles.map((title) => {
        const input = readonlyInput(title, "pj-pub-title", t("pj.pub.titles"));
        return h("div", { class: "row pub-row" }, input, copyButton(input, "pj-pub-title-copy", t("pj.pub.copy")));
      }),
      h("h5", {}, t("pj.pub.description")),
      description,
      h("div", { class: "row" }, copyButton(description, "pj-pub-description-copy", t("pj.pub.copy"))),
      result.draft.tags.length === 0 ? null : h("h5", {}, t("pj.pub.tags")),
      result.draft.tags.length === 0 ? null : h("div", { class: "row pub-row" }, tags, copyButton(tags, "pj-pub-tags-copy", t("pj.pub.tags.copy"))),
    );
  }

  // thumbnail
  const thumbnail = thumbnailSection(api, { run: hooks.run, useModel: () => llmToggle.checked, title: () => draft?.draft.titles[0] });
  llmToggle.addEventListener("change", () => thumbnail.refreshIdeas());

  function update(next: ProjectState): void {
    ready = next.project.transcript.status === "done";
    picture = next.project.sources.some((source) => source.hasVideo && (source.kind === "camera" || source.kind === "screen"));
    needTranscript.hidden = ready;
    refreshButton.disabled = !ready;
    draftButton.disabled = !ready || drafting;
    if (!initialised) {
      llmToggle.checked = next.settings.llm;
      llmHint.textContent = t(next.settings.llmRemote ? "pj.pub.llm.hint.remote" : "pj.pub.llm.hint");
      initialised = true;
    }
    if (ready) {
      const at = String(next.project.transcript.atMs);
      if (at !== chaptersKey) {
        chaptersKey = at;
        void hooks.run(loadChapters);
      }
    }
    thumbnail.update(next, ready, picture);
  }

  renderChapters();
  renderDraft();

  const el = h(
    "div",
    { class: "stack", "data-testid": "pj-publish" },
    h("p", { class: "hint" }, t("pj.pub.lead")),
    needTranscript,
    h("div", { class: "ex-block", "data-testid": "pj-pub-chapters-block" }, h("div", { class: "row" }, h("h4", {}, t("pj.pub.chapters")), refreshButton), h("p", { class: "hint" }, t("pj.pub.chapters.hint")), chaptersHost),
    h(
      "div",
      { class: "ex-block", "data-testid": "pj-pub-draft-block" },
      h("h4", {}, t("pj.pub.draft")),
      h("div", { class: "row" }, draftButton, h("label", { class: "check" }, llmToggle, h("span", {}, t("pj.pub.llm"), llmHint))),
      draftHost,
    ),
    thumbnail.el,
  );

  return {
    el,
    update,
    dispose() {
      disposed = true;
      thumbnail.dispose();
      el.replaceChildren();
    },
  };
}
