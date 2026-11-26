import { PRESETS, type Preset } from "../../shared/presets.js";
import { h } from "../lib/dom.js";
import { t } from "../i18n/index.js";

const optionOf = (preset: Preset): HTMLOptionElement => h("option", { value: preset.id, "data-kind": preset.kind }, preset.label);

/** A select of the export formats, video and audio in their own groups; every option carries its kind in `data-kind`. */
export function formatSelect(testId: string, label: string): HTMLSelectElement {
  return h(
    "select",
    { "data-testid": testId, "aria-label": label },
    h("optgroup", { label: t("pj.ex.group.video") }, ...PRESETS.filter((preset) => preset.kind === "video").map(optionOf)),
    h("optgroup", { label: t("pj.ex.group.audio") }, ...PRESETS.filter((preset) => preset.kind === "audio").map(optionOf)),
  );
}
