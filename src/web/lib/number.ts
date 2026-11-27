import { getLang, type Lang } from "../i18n/index.js";

export function formatNumber(value: number, digits: number, lang: Lang = getLang()): string {
  const rounded = Number(value.toFixed(digits));
  const withoutNegativeZero = Object.is(rounded, -0) ? 0 : rounded;
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(withoutNegativeZero);
}
