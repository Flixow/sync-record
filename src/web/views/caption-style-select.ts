import { CAPTION_STYLES } from "../../shared/captions.js";
import { h } from "../lib/dom.js";
import { t, type MessageKey } from "../i18n/index.js";

const STYLE_LABEL: Record<string, MessageKey> = {
  clean: "pj.cap.clean",
  "bold-box": "pj.cap.boldBox",
  "karaoke-pop": "pj.cap.karaokePop",
  minimal: "pj.cap.minimal",
};

/** A select of the caption styles of the renderer, by style id. `off` puts a first option, "off", for no captions at all. */
export function captionStyleSelect(testId: string, label: string, off?: string): HTMLSelectElement {
  return h(
    "select",
    { "data-testid": testId, "aria-label": label },
    off === undefined ? null : h("option", { value: "off" }, off),
    ...CAPTION_STYLES.map((style) => {
      const key = STYLE_LABEL[style.id];
      return h("option", { value: style.id }, key ? t(key) : style.label);
    }),
  );
}
