import { h } from "../lib/dom.js";
import { t, type MessageKey } from "../i18n/index.js";
import { banner } from "./layout.js";

const STAGE_KEYS: Record<string, MessageKey> = {
  mix: "pj.stage.mix",
  model: "pj.stage.model",
  frame: "pj.stage.frame",
  loudness: "pj.ex.stage.loudness",
  encode: "pj.ex.stage.encode",
  "resumed after a restart": "pj.stage.resumed",
  "paused for shutdown": "pj.stage.paused",
};

const TRACK_STAGE = /^(.+) (audio|camera|screen)$/;

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  const key = STAGE_KEYS[stage];
  if (key) return t(key);
  const track = TRACK_STAGE.exec(stage);
  if (track?.[1] && track[2]) return `${track[1]} · ${t(`rec.track.${track[2] as "audio" | "camera" | "screen"}`)}`;
  return stage;
}

export function progressBar(percent: number, name: string, stage: string | null | undefined): HTMLElement {
  const label = stageLabel(stage);
  return h(
    "div",
    { class: "bar", role: "progressbar", "aria-label": name, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent), "aria-valuetext": label ? `${percent}% · ${label}` : `${percent}%` },
    h("div", { class: "bar-fill", style: `width:${percent}%` }),
  );
}

export function failureBanner(summary: MessageKey, raw: string | null | undefined, testId: string): HTMLElement {
  const el = banner("error", t(summary), testId);
  if (raw) el.append(h("details", {}, h("summary", {}, t("pj.job.details")), h("pre", { class: "job-raw" }, raw)));
  return el;
}
