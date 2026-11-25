import { describe, expect, it } from "vitest";
import { en } from "../../src/web/i18n/en.js";
import { detectLang, format } from "../../src/web/i18n/index.js";
import { pl } from "../../src/web/i18n/pl.js";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

describe("translations", () => {
  it("Polish has exactly the English keys", () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });

  it("every translation keeps the placeholders of the English text", () => {
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders((pl as Record<string, string>)[key] ?? ""), key).toEqual(placeholders(text));
    }
  });

  it("no translation is empty", () => {
    for (const text of [...Object.values(en), ...Object.values(pl)]) expect(text.trim().length).toBeGreaterThan(0);
  });

  it("picks the language from storage first, then the browser", () => {
    expect(detectLang("en", ["pl-PL"])).toBe("en");
    expect(detectLang(null, ["pl-PL", "en"])).toBe("pl");
    expect(detectLang(null, ["de-DE"])).toBe("en");
    expect(detectLang("xx", [])).toBe("en");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(format("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
  });
});
