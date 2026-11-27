import { getLang, type Lang } from "../i18n/index.js";

export function formatNumber(value: number, digits: number, lang: Lang = getLang()): string {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false, signDisplay: "negative" }).format(value);
}
