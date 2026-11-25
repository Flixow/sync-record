// Prints the advance-width runs that src/shared/captions.ts embeds, read from the bundled font files. Run it again (and
// paste the output) when the font changes; tests/unit/captions.test.ts fails while the embedded table and the fonts differ.
//   tsx scripts/gen-caption-metrics.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFont } from "../tests/support/font.js";

export const METRIC_RANGES: [number, number][] = [
  [0x20, 0x7e],
  [0xa0, 0x17f],
  [0x2010, 0x2027],
  [0x2030, 0x2030],
  [0x2039, 0x203a],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2212, 0x2212],
];

export type Run = [start: number, widths: number[]];

/** Runs of consecutive code points that have a glyph, with their advance widths in font units. */
export function advanceRuns(file: string): Run[] {
  const font = readFont(file);
  const runs: Run[] = [];
  for (const [from, to] of METRIC_RANGES) {
    let run: Run | null = null;
    for (let cp = from; cp <= to; cp++) {
      if (font.glyphOf(cp) === 0) {
        run = null;
        continue;
      }
      if (!run) {
        run = [cp, []];
        runs.push(run);
      }
      run[1].push(font.advanceOf(cp));
    }
  }
  return runs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fonts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
  for (const [name, file] of [["REGULAR_RUNS", "NotoSans-Regular.ttf"], ["BOLD_RUNS", "NotoSans-Bold.ttf"]] as const) {
    console.log(`const ${name}: Run[] = [`);
    for (const [start, widths] of advanceRuns(path.join(fonts, file))) console.log(`  [${start}, [${widths.join(", ")}]],`);
    console.log("];");
  }
}
