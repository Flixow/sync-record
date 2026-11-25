import { en, type MessageKey } from "./en.js";
import { pl } from "./pl.js";

export type Lang = "en" | "pl";
export type { MessageKey };

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, pl };
const STORAGE_KEY = "syncrecord.lang";

export function detectLang(stored: string | null, browserLanguages: readonly string[]): Lang {
  if (stored === "en" || stored === "pl") return stored;
  const first = browserLanguages[0]?.toLowerCase() ?? "en";
  return first.startsWith("pl") ? "pl" : "en";
}

let current: Lang = "en";
const listeners = new Set<() => void>();

export function initLang(): void {
  current = detectLang(localStorage.getItem(STORAGE_KEY), navigator.languages ?? [navigator.language]);
  document.documentElement.lang = current;
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  for (const listener of listeners) listener();
}

export function onLangChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replaces {name} placeholders. */
export function format(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return format(dictionaries[current][key], params);
}

export { dictionaries };
