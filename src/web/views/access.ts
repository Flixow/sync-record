import { ApiError, publicApi, saveCredentials, type SessionApi } from "../lib/api.js";
import { copyField } from "../lib/clipboard.js";
import { CLAIM_MINUTES } from "../../shared/protocol.js";
import { h } from "../lib/dom.js";
import { t } from "../i18n/index.js";
import { banner, card, page } from "./layout.js";

export function noAccessView(): HTMLElement {
  return page(
    h("section", { class: "hero narrow" }, h("h1", { "data-testid": "access-title" }, t("access.title")), h("p", { class: "lead", "data-testid": "access-body" }, t("access.body"))),
    card(null, h("p", { class: "hint", "data-testid": "access-other" }, t("access.other")), h("a", { class: "btn", href: "/" }, t("access.home"))),
  );
}

const redeeming = new Map<string, Promise<void>>();

export function claimView(sid: string, claimToken: string | null, navigate: (path: string) => void): HTMLElement {
  const status = h("div", { "data-testid": "claim-status" });
  const show = (kind: "info" | "error", text: string): void => status.replaceChildren(banner(kind, text, kind === "error" ? "claim-error" : undefined));

  let pending = redeeming.get(sid);
  if (!claimToken && !pending) {
    show("error", t("claim.missing"));
  } else {
    show("info", t("claim.working"));
    if (claimToken && !pending) {
      history.replaceState(null, "", location.pathname);
      pending = publicApi.claim(sid, claimToken).then((claimed) => {
        saveCredentials(sid, { participantId: claimed.participantId, participantToken: claimed.participantToken, name: claimed.name, host: true });
      });
      redeeming.set(sid, pending);
    }
    pending
      ?.then(() => {
        redeeming.delete(sid);
        navigate(`/project/${sid}`);
      })
      .catch((cause: unknown) => {
        redeeming.delete(sid);
        show("error", cause instanceof ApiError && cause.code === "session_not_found" ? t("claim.notFound") : t("claim.invalid"));
      });
  }

  return page(h("section", { class: "hero narrow" }, h("h1", {}, t("claim.title"))), card(null, status, h("a", { class: "btn", href: "/" }, t("access.home"))));
}

export function claimLinkPanel(api: SessionApi): HTMLElement {
  const out = h("div", { class: "stack" });
  const button = h("button", {
    type: "button",
    class: "btn btn-small",
    "data-testid": "pj-claim-button",
    onclick: () => {
      button.disabled = true;
      api
        .claimLink()
        .then((issued) => {
          const field = h("input", { type: "text", readonly: "", value: `${location.origin}/claim/${api.sid}#${issued.claimToken}`, "aria-label": t("pj.claim.label"), "data-testid": "pj-claim-link" });
          const copied = h("span", { class: "hint", role: "status" });
          out.replaceChildren(
            h("div", { class: "row" }, field, h("button", { type: "button", class: "btn btn-small", onclick: () => void copyField(field).then((ok) => { copied.textContent = ok ? t("pj.claim.copied") : ""; }) }, t("pj.claim.copy")), copied),
            h("p", { class: "hint" }, t("pj.claim.hint", { minutes: CLAIM_MINUTES })),
          );
          field.select();
        })
        .catch((cause: unknown) => out.replaceChildren(banner("error", t("err.generic", { message: cause instanceof Error ? cause.message : "?" }), "pj-claim-error")))
        .finally(() => {
          button.disabled = false;
        });
    },
  }, t("pj.claim.button"));
  return h("div", { class: "stack" }, button, out);
}
