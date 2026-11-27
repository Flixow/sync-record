import { h } from "../lib/dom.js";
import { getLang, setLang, t, type Lang } from "../i18n/index.js";

function langButton(lang: Lang): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: `lang-btn${getLang() === lang ? " active" : ""}`,
      "aria-pressed": String(getLang() === lang),
      "data-testid": `lang-${lang}`,
      onclick: () => setLang(lang),
    },
    lang.toUpperCase(),
  );
}

export function header(): HTMLElement {
  return h(
    "header",
    { class: "topbar" },
    h(
      "a",
      { class: "brand", href: "/" },
      h("img", { src: "/logo.svg", alt: "", width: "32", height: "32" }),
      h("span", { class: "brand-name" }, t("brand.name")),
    ),
    h("div", { class: "topbar-right" }, h("div", { class: "lang", role: "group", "aria-label": t("lang.label") }, langButton("en"), langButton("pl"))),
  );
}

export function page(...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "shell" }, header(), h("main", { class: "page" }, ...children));
}

export function card(title: string | null, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "card" }, title ? h("h2", {}, title) : null, ...children);
}

export function scrollable(table: HTMLElement): HTMLElement {
  return h("div", { class: "table-scroll" }, table);
}

export function srOnly(text: string): HTMLElement {
  return h("span", { class: "sr-only" }, text);
}

export function banner(kind: "info" | "warn" | "error" | "ok", text: string, testId?: string): HTMLElement {
  return h("div", { class: `banner banner-${kind}`, role: kind === "error" ? "alert" : "status", ...(testId ? { "data-testid": testId } : {}) }, text);
}
