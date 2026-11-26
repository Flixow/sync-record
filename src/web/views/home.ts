import { ApiError, publicApi, saveCredentials } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { LocalRecording } from "../lib/opfs.js";
import { supported } from "../lib/support.js";
import { t } from "../i18n/index.js";
import { banner, card, page } from "./layout.js";
import { MAX_PARTICIPANTS } from "../../shared/protocol.js";

export async function homeView(navigate: (path: string) => void): Promise<HTMLElement> {
  const config = await publicApi.config().catch(() => null);
  const missing = supported();

  const name = h("input", { id: "host-name", type: "text", maxlength: "60", autocomplete: "name", placeholder: t("home.form.namePlaceholder"), "data-testid": "host-name" });
  const key = h("input", { id: "create-key", type: "password", autocomplete: "off", "data-testid": "create-key" });
  const error = h("div", { class: "form-error", role: "alert", "data-testid": "home-error" });
  const submit = h("button", { type: "submit", class: "btn btn-primary", "data-testid": "create-session" }, t("home.form.create"));

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (!name.value.trim()) {
          name.focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = t("home.form.creating");
        error.textContent = "";
        publicApi
          .createSession({ name: name.value.trim(), ...(key.value ? { createKey: key.value } : {}) })
          .then((created) => {
            saveCredentials(created.sessionId, {
              participantId: created.participantId,
              participantToken: created.participantToken,
              name: name.value.trim(),
              host: true,
              inviteToken: created.inviteToken,
            });
            navigate(`/join/${created.sessionId}`);
          })
          .catch((cause: unknown) => {
            submit.disabled = false;
            submit.textContent = t("home.form.create");
            error.textContent = cause instanceof ApiError && cause.code === "create_key_invalid" ? t("home.form.keyHint") : t("err.generic", { message: cause instanceof Error ? cause.message : "?" });
          });
      },
    },
    h("label", { for: "host-name" }, t("home.form.name")),
    name,
    config?.createKeyRequired ? h("label", { for: "create-key" }, t("home.form.key")) : null,
    config?.createKeyRequired ? key : null,
    config?.createKeyRequired ? h("p", { class: "hint" }, t("home.form.keyHint")) : null,
    error,
    submit,
  );

  const how = h(
    "ol",
    { class: "how" },
    ...[1, 2, 3].map((n) =>
      h(
        "li",
        {},
        h("span", { class: "how-n" }, String(n)),
        h("div", {}, h("strong", {}, t(`home.how${n as 1 | 2 | 3}.title`)), h("p", {}, t(`home.how${n as 1 | 2 | 3}.body`))),
      ),
    ),
  );

  const leftovers = await leftoverSessions();

  return page(
    h("section", { class: "hero" }, h("p", { class: "eyebrow" }, t("brand.tagline")), h("h1", {}, t("home.title")), h("p", { class: "lead" }, t("home.lead"))),
    h(
      "div",
      { class: "grid-2" },
      card(t("home.form.title"), missing.length > 0 ? banner("error", t("home.unsupported")) : form, h("p", { class: "hint" }, t("home.requirements", { max: config?.maxParticipants ?? MAX_PARTICIPANTS }))),
      h("section", { class: "how-card" }, how),
    ),
    leftovers.length > 0
      ? card(
          t("home.leftover.title"),
          h("p", { class: "hint" }, t("home.leftover.body")),
          h(
            "ul",
            { class: "plain-list", "data-testid": "leftovers" },
            ...leftovers.map(([sid, count]) =>
              h("li", {}, h("code", {}, sid), h("span", { class: "muted" }, ` ${t("home.leftover.count", { count })} `), h("a", { href: `/join/${sid}`, class: "btn btn-small" }, t("home.leftover.open"))),
            ),
          ),
        )
      : null,
  );
}

async function leftoverSessions(): Promise<[string, number][]> {
  try {
    const all = await LocalRecording.list();
    const counts = new Map<string, number>();
    for (const recording of all) counts.set(recording.meta.sessionId, (counts.get(recording.meta.sessionId) ?? 0) + 1);
    return [...counts.entries()];
  } catch {
    return [];
  }
}
