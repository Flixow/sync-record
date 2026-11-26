// A minimal TrueType reader (head, hhea, OS/2, maxp, hmtx, cmap formats 4 and 12): enough to check glyph coverage and to
// generate or verify the advance-width table that src/shared/captions.ts embeds. Test and script helper only.
import { readFileSync } from "node:fs";

export interface FontInfo {
  unitsPerEm: number;
  /** OS/2 usWinAscent + usWinDescent: libass sizes a font so that this sum equals the ASS font size. */
  winAscent: number;
  winDescent: number;
  hheaAscent: number;
  hheaDescent: number;
  hheaLineGap: number;
  capHeight: number;
  xHeight: number;
  glyphCount: number;
  /** Glyph id of a code point; 0 (the notdef box) when the font has no glyph for it. */
  glyphOf(codePoint: number): number;
  /** Advance width in font units; the notdef advance when the code point is missing. */
  advanceOf(codePoint: number): number;
  /** Every code point the cmap maps to a real glyph. */
  codePoints(): number[];
}

export function readFont(file: string): FontInfo {
  const data = readFileSync(file);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables = new Map<string, { offset: number; length: number }>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    tables.set(data.toString("latin1", at, at + 4), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  const table = (tag: string): number => {
    const found = tables.get(tag);
    if (!found) throw new Error(`${file}: no ${tag} table`);
    return found.offset;
  };
  const head = table("head");
  const hhea = table("hhea");
  const os2 = table("OS/2");
  const maxp = table("maxp");
  const hmtx = table("hmtx");
  const unitsPerEm = view.getUint16(head + 18);
  const glyphCount = view.getUint16(maxp + 4);
  const metricCount = view.getUint16(hhea + 34);
  const os2Version = view.getUint16(os2);

  const cmapOffset = table("cmap");
  const cmapCount = view.getUint16(cmapOffset + 2);
  const map = new Map<number, number>();
  const wanted: number[] = [];
  for (let i = 0; i < cmapCount; i++) {
    const record = cmapOffset + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    // Unicode BMP (0/3, 3/1) and full repertoire (0/4, 3/10)
    if ((platform === 0 && [3, 4].includes(encoding)) || (platform === 3 && [1, 10].includes(encoding))) wanted.push(cmapOffset + view.getUint32(record + 4));
  }
  for (const sub of wanted) {
    const format = view.getUint16(sub);
    if (format === 4) {
      const segments = view.getUint16(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getInt16(deltas + s * 2);
        const rangeOffset = view.getUint16(ranges + s * 2);
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (cp + delta) & 0xffff;
          else {
            const at = ranges + s * 2 + rangeOffset + (cp - start) * 2;
            glyph = view.getUint16(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) map.set(cp, glyph);
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const at = sub + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const glyph = view.getUint32(at + 8);
        for (let cp = start; cp <= end; cp++) map.set(cp, glyph + (cp - start));
      }
    }
  }
  const advanceOfGlyph = (glyph: number): number => view.getUint16(hmtx + Math.min(glyph, metricCount - 1) * 4);
  return {
    unitsPerEm,
    winAscent: view.getUint16(os2 + 74),
    winDescent: view.getUint16(os2 + 76),
    hheaAscent: view.getInt16(hhea + 4),
    hheaDescent: -view.getInt16(hhea + 6),
    hheaLineGap: view.getInt16(hhea + 8),
    capHeight: os2Version >= 2 ? view.getInt16(os2 + 88) : 0,
    xHeight: os2Version >= 2 ? view.getInt16(os2 + 86) : 0,
    glyphCount,
    glyphOf: (codePoint) => map.get(codePoint) ?? 0,
    advanceOf: (codePoint) => advanceOfGlyph(map.get(codePoint) ?? 0),
    codePoints: () => [...map.keys()].sort((a, b) => a - b),
  };
}
