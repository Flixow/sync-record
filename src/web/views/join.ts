import { ApiError, publicApi, saveCredentials } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { t } from "../i18n/index.js";
import { MAX_PARTICIPANTS } from "../../shared/protocol.js";
import { card, page } from "./layout.js";

/** Name form for someone who opened an invite link. The token comes from the URL fragment and is never sent as a path. */
export function joinView(sid: string, inviteToken: string | null, navigate: (path: string) => void): HTMLElement {
  const error = h("div", { class: "form-error", role: "alert", "data-testid": "join-error" });
  const name = h("input", { id: "join-name", type: "text", required: true, pattern: ".*\\S.*", maxlength: "60", autocomplete: "name", "data-testid": "join-name" });
  const submit = h("button", { type: "submit", class: "btn btn-primary", "data-testid": "join-submit" }, t("join.button"));

  if (!inviteToken) error.textContent = t("join.missing");

  const messageFor = (cause: unknown): string => {
    if (cause instanceof ApiError) {
      if (cause.code === "session_full") return t("join.full", { max: MAX_PARTICIPANTS });
      if (cause.code === "session_ended") return t("join.ended");
      if (cause.code === "session_not_found") return t("join.notFound");
      if (cause.status === 401 || cause.status === 403) return t("join.invalid");
    }
    return t("err.generic", { message: cause instanceof Error ? cause.message : "?" });
  };

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (!inviteToken) return;
        submit.disabled = true;
        submit.textContent = t("join.joining");
        error.textContent = "";
        publicApi
          .join(sid, inviteToken, name.value.trim())
          .then((joined) => {
            saveCredentials(sid, { participantId: joined.participantId, participantToken: joined.participantToken, name: name.value.trim(), host: false });
            navigate(`/join/${sid}`);
          })
          .catch((cause: unknown) => {
            submit.disabled = false;
            submit.textContent = t("join.button");
            error.textContent = messageFor(cause);
          });
      },
    },
    h("label", { for: "join-name" }, t("join.name")),
    name,
    error,
    submit,
  );
  submit.disabled = !inviteToken;

  return page(h("section", { class: "hero narrow" }, h("h1", {}, t("join.title")), h("p", { class: "lead" }, t("join.lead"))), card(null, form));
}
