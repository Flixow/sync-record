// Gate measurements of the burned-in captions (libass through the same ffmpeg filter the product uses). Prints JSON.
//   tsx scripts/bench-captions.ts [--dir <work dir>] [--en <transcript.json>] [--pl <transcript.json>] [--gates a,b,c,d] [--all-presets]
// (a) highlight on/off timing against the words' own times, measured on rendered 30 fps frames
// (b) Polish diacritics: font coverage, bundled font actually used by libass, glyphs against a second route and the notdef box
// (c) caption boxes and rendered ink inside the 9:16 safe area
// (d) encode time with captions against without
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPTION_STYLES, captionBoxes, captionFilter, layoutCaptions, prepareWords, toAss, type CaptionLine, type CaptionStyle, type CaptionWord } from "../src/shared/captions.js";
import { insideRect, safeArea, type Canvas, type Rect } from "../src/shared/safe-area.js";
import type { TranscriptWord } from "../src/shared/transcript.js";
import { FONTS_DIR, hasLibass, inkBox, renderFrames, rgbOf, sizeOf, type Ink } from "../tests/support/caption-render.js";
import { readFont } from "../tests/support/font.js";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const tmp = process.env.TMPDIR ?? os.tmpdir();
const dir = path.resolve(arg("dir", path.join(tmp, "bench-captions")));
const transcripts = {
  en: arg("en", path.join(tmp, "bench-asr3-en/post/bench-clean-en-0001/transcript.json")),
  pl: arg("pl", path.join(tmp, "bench-asr3-pl/post/bench-clean-pl-0001/transcript.json")),
};
const gates = new Set(arg("gates", "a,b,c,d").split(","));
mkdirSync(dir, { recursive: true });
if (!hasLibass()) throw new Error("this ffmpeg has no libass `ass` filter");

const V916: Canvas = { width: 1080, height: 1920 };
const style = (id: string): CaptionStyle => {
  const found = CAPTION_STYLES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no style ${id}`);
  return found;
};
const loadWords = (file: string): TranscriptWord[] => (JSON.parse(readFileSync(file, "utf8")) as { words: TranscriptWord[] }).words;
const round = (value: number, digits = 1): number => Number(value.toFixed(digits));
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? NaN : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);
};
const median = (values: number[]): number => percentile(values, 0.5);
const union = (rects: Rect[], pad: number): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x)) - pad;
  const y0 = Math.min(...rects.map((r) => r.y)) - pad;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad;
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad;
  return { x: Math.max(0, x0), y: Math.max(0, y0), w: x1 - Math.max(0, x0), h: y1 - Math.max(0, y0) };
};

const result: Record<string, unknown> = { ffmpeg: spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] };

// ---- (a) highlight timing ------------------------------------------------------------------------------------------------

const FPS = 30;
/** 32 well separated fully saturated colours. Every word of an event gets its own, and neighbouring events use different halves, so a frame says which word of which event is highlighted. */
const palette = (k: number): [number, number, number] => {
  const h = ((k % 32) / 32) * 6;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};
const tagColor = ([r, g, b]: [number, number, number]): string => `&H${[b, g, r].map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join("")}&`;

/** The ASS as the product writes it, except that the highlight colour of the k-th word of every event is palette k. */
function recolored(ass: string, s: CaptionStyle): string {
  const highlight = tagColor(rgbOf(s.highlight.replace("#", "")));
  let dialogue = -1;
  return ass
    .split("\n")
    .map((line) => {
      if (!line.startsWith("Dialogue:")) return line;
      dialogue += 1;
      let k = 16 * (dialogue % 2);
      if (s.highlightMode === "word") return line.replaceAll(`,\\1c${highlight})\\t(`, () => `,\\1c${tagColor(palette(k++))})\\t(`);
      return line.replace(/\{\\kf(\d+)\}/g, (_match, d: string) => `{\\1c${tagColor(palette(k++))}\\kf${d}}`);
    })
    .join("\n");
}

async function measureHighlights(label: string, words: TranscriptWord[], styleId: string): Promise<Record<string, unknown>> {
  const s = style(styleId);
  const mode = s.highlightMode === "karaoke" ? "karaoke" : "word";
  const events = layoutCaptions(words, V916, s);
  const boxes = captionBoxes(events, V916, s);
  const crop = union(boxes, 8);
  const assFile = path.join(dir, `a-${label}-${styleId}.ass`);
  writeFileSync(assFile, recolored(toAss(events, V916, s), s));
  const seconds = Math.ceil((events[events.length - 1] as CaptionLine).e / 1000) + 1;
  const frameCount = seconds * FPS;
  const present: Uint32Array[] = []; // per frame, pixels per palette colour
  const colours = Array.from({ length: 32 }, (_, k) => palette(k));
  await renderFrames({ assFile, width: V916.width, height: V916.height, fps: FPS, seconds, background: "202020", crop }, (_index, rgb) => {
    const counts = new Uint32Array(32);
    // pixels of each palette colour in this frame
    for (let at = 0; at < rgb.length; at += 3) {
      const r = rgb[at] as number;
      const g = rgb[at + 1] as number;
      const b = rgb[at + 2] as number;
      // palette colours have a channel at 255 and one at 0; skip the rest (white, black, background, edges) fast
      if ((r !== 255 && g !== 255 && b !== 255) || (r !== 0 && g !== 0 && b !== 0)) continue;
      for (let k = 0; k < 32; k++) {
        const c = colours[k] as [number, number, number];
        if (Math.abs(r - c[0]) <= 3 && Math.abs(g - c[1]) <= 3 && Math.abs(b - c[2]) <= 3) {
          counts[k] = (counts[k] as number) + 1;
          break;
        }
      }
    }
    present.push(counts);
  });
  const MIN_PIXELS = 12;
  const rawWords = words;
  const rawFor = (word: CaptionWord): TranscriptWord | null => {
    let best: TranscriptWord | null = null;
    let distance = 400;
    for (const raw of rawWords) {
      const d = Math.abs(raw.e - word.e);
      if (raw.t === word.text && d < distance) {
        best = raw;
        distance = d;
      }
    }
    return best;
  };
  const vsLaid: number[] = [];
  const vsRaw: number[] = [];
  const fullOnly: number[] = [];
  const repaired: unknown[] = [];
  const outliers: unknown[] = [];
  let wordsTotal = 0;
  let unobserved = 0;
  let unmatchedRaw = 0;
  for (const event of events) {
    const first = Math.max(0, Math.floor(event.s / 1000 * FPS) - 1);
    const last = Math.min(frameCount - 1, Math.ceil(event.e / 1000 * FPS) + 1);
    event.words.forEach((word, k) => {
      wordsTotal += 1;
      const counts: number[] = [];
      for (let f = first; f <= last; f++) counts.push(((present[f] as Uint32Array)[16 * (events.indexOf(event) % 2) + k] as number) ?? 0);
      const peak = Math.max(...counts);
      const frames = counts.map((c, i) => [c, first + i] as const).filter(([c]) => c >= MIN_PIXELS).map(([, f]) => f);
      if (frames.length === 0) {
        unobserved += 1;
        return;
      }
      const on = ((frames[0] as number) / FPS) * 1000;
      const raw = rawFor(word);
      if (!raw) unmatchedRaw += 1;
      if (mode === "word") {
        const off = (((frames[frames.length - 1] as number) + 1) / FPS) * 1000;
        // the word is on from the first frame it is seen to the frame after the last one
        vsLaid.push(on - word.s, off - word.e);
        if (Math.abs(on - word.s) > 100 || Math.abs(off - word.e) > 100) outliers.push({ event: events.indexOf(event), k, text: word.text, expected: [word.s, word.e], observed: [round(on), round(off)], pixelsByFrame: counts.join(",").slice(0, 300) });
        if (raw) vsRaw.push(on - raw.s, off - raw.e);
        if (raw && (Math.abs(raw.s - word.s) > 100 || Math.abs(raw.e - word.e) > 100)) repaired.push({ text: word.text, rawS: raw.s, rawE: raw.e, laidS: word.s, laidE: word.e });
      } else {
        // karaoke: only the start of the sweep and the moment it is complete exist
        const fullFrame = counts.findIndex((c) => c >= 0.97 * peak);
        const full = ((first + fullFrame) / FPS) * 1000;
        fullOnly.push(full - word.e);
        vsLaid.push(on - word.s);
        if (raw) vsRaw.push(on - raw.s);
        if (raw && Math.abs(raw.s - word.s) > 100) repaired.push({ text: word.text, rawS: raw.s, laidS: word.s });
      }
    });
  }
  const stat = (values: number[]): Record<string, number> => ({
    edges: values.length,
    within100ms: values.length === 0 ? NaN : round(values.filter((v) => Math.abs(v) <= 100).length / values.length, 4),
    maxAbsErrMs: round(Math.max(...values.map(Math.abs)), 1),
    p50Ms: round(percentile(values, 0.5), 1),
    p95AbsMs: round(percentile(values.map(Math.abs), 0.95), 1),
    minMs: round(Math.min(...values), 1),
    maxMs: round(Math.max(...values), 1),
  });
  return {
    style: styleId,
    mode,
    events: events.length,
    words: wordsTotal,
    wordsNeverSeen: unobserved,
    videoSec: seconds,
    vsLaidOutTimes: stat(vsLaid),
    vsRawTranscriptTimes: { ...stat(vsRaw), wordsWithoutRawMatch: unmatchedRaw },
    ...(mode === "karaoke" ? { fillCompleteVsWordEnd: stat(fullOnly) } : {}),
    repairedWords: repaired,
    outliers,
  };
}

if (gates.has("a")) {
  const out: Record<string, unknown> = {};
  for (const lang of ["en", "pl"] as const) {
    const window = loadWords(transcripts[lang]).filter((word) => word.s < 60_000);
    out[lang] = { transcriptWordsInWindow: window.length, preparedWords: prepareWords(window).length, word: await measureHighlights(lang, window, "bold-box"), karaoke: await measureHighlights(lang, window, "karaoke-pop") };
  }
  result.a = out;
}

// ---- (b) Polish diacritics ---------------------------------------------------------------------------------------------

const PANGRAM = "Zażółć gęślą jaźń. ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż";
const LETTERS = [..."ąćęłńóśźżĄĆĘŁŃÓŚŹŻ"];

const emptyFontconfig = path.join(dir, "empty-fonts.conf");
writeFileSync(emptyFontconfig, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><cachedir>${path.join(dir, "fc-cache")}</cachedir></fontconfig>\n`);
const NO_SYSTEM_FONTS = { FONTCONFIG_FILE: emptyFontconfig };

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex").slice(0, 16);
const mass = (rgb: Buffer): number => {
  let sum = 0;
  for (let at = 0; at < rgb.length; at += 3) sum += ((rgb[at] as number) + (rgb[at + 1] as number) + (rgb[at + 2] as number)) / 3;
  return sum / 255;
};

async function oneFrame(assFile: string, canvas: Canvas, atFrame: number, extra: { filter?: string; env?: NodeJS.ProcessEnv; logLevel?: string } = {}): Promise<{ rgb: Buffer; log: string }> {
  let kept: Buffer = Buffer.alloc(0);
  const { log } = await renderFrames({ assFile, width: canvas.width, height: canvas.height, fps: 2, seconds: 2, background: "000000", ...extra }, (index, rgb) => {
    if (index === atFrame) kept = Buffer.from(rgb);
  });
  return { rgb: kept, log };
}

if (gates.has("b")) {
  const out: Record<string, unknown> = {};
  const codePoints = [...new Set([...PANGRAM.replace(/ /g, "")].map((char) => char.codePointAt(0) as number))];
  const coverage: Record<string, unknown> = {};
  for (const file of ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"]) {
    const font = readFont(path.join(FONTS_DIR, file));
    const missing = codePoints.filter((cp) => font.glyphOf(cp) === 0).map((cp) => String.fromCodePoint(cp));
    coverage[file] = { checkedCodePoints: codePoints.length, missingFromCmap: missing };
  }
  out.cmapCoverage = coverage;

  const words: TranscriptWord[] = PANGRAM.split(" ").map((t, i) => ({ t, s: 200 + i * 220, e: 200 + i * 220 + 200, src: "x", pid: "p" }));
  const presets: Record<string, unknown> = {};
  for (const canvas of [V916, { width: 1920, height: 1080 }]) {
    for (const s of CAPTION_STYLES) {
      const events = layoutCaptions(words, canvas, s);
      const assFile = path.join(dir, `b-${s.id}-${canvas.width}.ass`);
      writeFileSync(assFile, toAss(events, canvas, s));
      const normal = await oneFrame(assFile, canvas, 2, { logLevel: "debug" });
      const isolated = await oneFrame(assFile, canvas, 2, { env: NO_SYSTEM_FONTS, logLevel: "debug" });
      const withoutFonts = await oneFrame(assFile, canvas, 2, { env: NO_SYSTEM_FONTS, filter: `ass=filename=${assFile}` });
      const select = (log: string): string[] => [...new Set(log.split("\n").filter((line) => line.includes("fontselect")).map((line) => line.replace(/^.*fontselect: /, "")))];
      const ink = inkBox(normal.rgb, canvas.width, canvas.height, [0, 0, 0], 0);
      presets[`${s.id}@${canvas.width}x${canvas.height}`] = {
        lines: events.map((event) => event.lines),
        fontselect: select(normal.log),
        fontselectWithoutSystemFonts: select(isolated.log),
        loadedFromFontsDir: normal.log.split("\n").filter((line) => line.includes("Loading font file")).map((line) => path.basename(line.replace(/^.*Loading font file '/, "").replace(/'.*$/, ""))).slice(0, 2),
        systemFontPathInLog: /\/usr\/share\/fonts/.test(normal.log.split("\n").filter((line) => line.includes("fontselect")).join("\n")),
        pixelsIdenticalWithAndWithoutSystemFonts: sha(normal.rgb) === sha(isolated.rgb),
        inkPixels: ink?.pixels ?? 0,
        withoutFontsdirDiffersFromBundled: sha(withoutFonts.rgb) !== sha(normal.rgb),
        withoutFontsdirInkPixels: inkBox(withoutFonts.rgb, canvas.width, canvas.height, [0, 0, 0], 0)?.pixels ?? 0,
      };
    }
  }
  out.presets = presets;

  // per glyph: libass against ffmpeg's drawtext with the same font file (both FreeType), and against the notdef box
  interface Probe {
    ink: Ink | null;
    mass: number;
  }
  interface GlyphResult {
    weight: string;
    char: string;
    notdef: boolean;
    libassBox: [number, number];
    drawtextBox: [number, number] | null;
    massRatioLibassOverDrawtext: number | null;
  }
  const glyphs: GlyphResult[] = [];
  const small: Canvas = { width: 640, height: 360 }; // style px = canvas px * 3, so a 216 px style font is 72 px here
  for (const bold of [false, true]) {
    const plain: CaptionStyle = { ...style("clean"), id: "plain", bold, fontSize: 216, outlineWidth: 0, shadow: 0, uppercase: false, highlightMode: "none" };
    const fontFile = path.join(FONTS_DIR, bold ? "NotoSans-Bold.ttf" : "NotoSans-Regular.ttf");
    const em = (plain.fontSize * small.height) / 1080;
    const probes = [...LETTERS, "\u0378"];
    const events: CaptionLine[] = probes.map((char, k) => ({ s: k * 1000 - 400, e: k * 1000 + 600, words: [{ text: char, s: k * 1000 - 400, e: k * 1000 + 600 }], lines: [char] }));
    const assFile = path.join(dir, `b-glyphs-${bold ? "bold" : "regular"}.ass`);
    writeFileSync(assFile, toAss(events, small, plain));
    const rendered: Probe[] = [];
    await renderFrames({ assFile, width: small.width, height: small.height, fps: 1, seconds: probes.length, background: "000000", env: NO_SYSTEM_FONTS }, (_index, rgb) => {
      rendered.push({ ink: inkBox(rgb, small.width, small.height, [0, 0, 0], 8), mass: mass(rgb) });
    });
    for (let k = 0; k < probes.length; k++) {
      const char = probes[k] as string;
      const textFile = path.join(dir, "glyph.txt");
      writeFileSync(textFile, char);
      let drawn: Probe | null = null;
      const proc = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${small.width}x${small.height}:r=1:d=1`, "-vf", `format=rgb24,drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${em}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 });
      if (proc.status === 0) drawn = { ink: inkBox(proc.stdout, small.width, small.height, [0, 0, 0], 8), mass: mass(proc.stdout) };
      const a = rendered[k] as Probe;
      glyphs.push({ weight: bold ? "bold" : "regular", char, notdef: char === "\u0378", libassBox: sizeOf(a.ink), drawtextBox: drawn ? sizeOf(drawn.ink) : null, massRatioLibassOverDrawtext: drawn && drawn.mass > 0 ? round(a.mass / drawn.mass, 3) : null });
    }
  }
  const real = glyphs.filter((g) => !g.notdef);
  const notdef = glyphs.filter((g) => g.notdef);
  out.glyphs = {
    em: 72,
    compared: real.length,
    maxBoxDiffPx: Math.max(...real.map((g) => Math.max(Math.abs(g.libassBox[0] - (g.drawtextBox?.[0] ?? 0)), Math.abs(g.libassBox[1] - (g.drawtextBox?.[1] ?? 0))))),
    massRatioRange: [Math.min(...real.map((g) => g.massRatioLibassOverDrawtext ?? 0)), Math.max(...real.map((g) => g.massRatioLibassOverDrawtext ?? 0))],
    notdefBox: notdef.map((g) => ({ weight: g.weight, box: g.libassBox, massRatioLibassOverDrawtext: g.massRatioLibassOverDrawtext })),
    lettersWithNotdefSizedBox: real.filter((g) => notdef.some((n) => n.weight === g.weight && n.libassBox[0] === g.libassBox[0] && n.libassBox[1] === g.libassBox[1])).length,
    detail: glyphs,
  };
  result.b = out;
}

// ---- (c) boxes inside the safe area ------------------------------------------------------------------------------------

if (gates.has("c")) {
  const area = safeArea(V916);
  const out: Record<string, unknown> = { safeArea: area };
  const pool = (["en", "pl"] as const).flatMap((lang) => loadWords(transcripts[lang]).length > 0 ? [loadWords(transcripts[lang])] : []);
  for (const s of CAPTION_STYLES) {
    // the 20 widest real events of both transcripts: the worst cases for this preset
    const candidates = pool.flatMap((words) => layoutCaptions(words, V916, s));
    const widest = candidates
      .map((event) => ({ event, rect: captionBoxes([event], V916, s)[0] as Rect }))
      .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
      .slice(0, 20);
    const events = widest.map(({ event }, k) => {
      const shift = k * 1000 - 200 - event.s;
      return { ...event, s: event.s + shift, e: event.s + shift + 1000, words: event.words.map((word: CaptionWord) => ({ ...word, s: word.s + shift, e: word.e + shift })) };
    });
    const boxes = captionBoxes(events, V916, s);
    const assFile = path.join(dir, `c-${s.id}.ass`);
    writeFileSync(assFile, toAss(events, V916, s));
    let boxesInside = 0;
    let inkInside = 0;
    let inkInsideBox = 0;
    let maxOvershootOfBox = 0;
    let minMargin = Infinity;
    const ink: unknown[] = [];
    await renderFrames({ assFile, width: V916.width, height: V916.height, fps: 1, seconds: events.length, background: "336699" }, (index, rgb) => {
      // the flat colour after the yuv -> rgb conversion: whatever the top-left pixel is, which lies outside any caption
      const box = inkBox(rgb, V916.width, V916.height, [rgb[0] as number, rgb[1] as number, rgb[2] as number], 0);
      const rect = boxes[index] as Rect;
      if (!box) {
        ink.push({ index, ink: null });
        return;
      }
      const inkRect: Rect = { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 };
      if (insideRect(inkRect, area)) inkInside += 1;
      if (insideRect(inkRect, rect)) inkInsideBox += 1;
      maxOvershootOfBox = Math.max(maxOvershootOfBox, rect.x - inkRect.x, rect.y - inkRect.y, inkRect.x + inkRect.w - (rect.x + rect.w), inkRect.y + inkRect.h - (rect.y + rect.h));
      minMargin = Math.min(minMargin, inkRect.x - area.x, inkRect.y - area.y, area.x + area.w - (inkRect.x + inkRect.w), area.y + area.h - (inkRect.y + inkRect.h));
    });
    for (const rect of boxes) if (insideRect(rect, area)) boxesInside += 1;
    out[s.id] = { events: events.length, boxesInsideSafeArea: boxesInside, renderedInkInsideSafeArea: inkInside, renderedInkInsideEstimatedBox: inkInsideBox, maxInkOvershootOfBoxPx: Math.max(0, maxOvershootOfBox), minInkMarginToSafeEdgePx: minMargin, sample: widest.slice(0, 3).map(({ event }) => event.lines) };
  }
  result.c = out;
}

// ---- (d) render time ---------------------------------------------------------------------------------------------------

if (gates.has("d")) {
  const reps = 3;
  const words = loadWords(transcripts.en).filter((word) => word.s < 60_000);
  interface Timing {
    wall: number;
    cpu: number;
  }
  /** Wall clock, and the user + system CPU time ffmpeg reports with -benchmark (far less sensitive to other load on the machine). */
  const encode = (filter: string | null, out: string): Timing => {
    const started = process.hrtime.bigint();
    const run = spawnSync("ffmpeg", ["-v", "info", "-benchmark", "-y", "-f", "lavfi", "-i", `testsrc2=s=${V916.width}x${V916.height}:r=30:d=60`, ...(filter ? ["-vf", filter] : []), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-threads", "4", out]);
    const wall = Number(process.hrtime.bigint() - started) / 1e9;
    if (run.status !== 0) throw new Error(`encode failed: ${String(run.stderr)}`);
    const match = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(String(run.stderr));
    if (!match) throw new Error("no -benchmark line in the ffmpeg output");
    return { wall, cpu: Number(match[1]) + Number(match[2]) };
  };
  const presets = arg("presets", process.argv.includes("--all-presets") ? "all" : "bold-box");
  const ids = presets === "all" ? CAPTION_STYLES.map((s) => s.id) : presets.split(",");
  const out: Record<string, unknown> = { videoSec: 60, resolution: "1080x1920", encoder: "libx264 -preset veryfast -threads 4, testsrc2 30 fps", repetitions: reps, loadAverageAtStart: os.loadavg()[0] };
  const base: Timing[] = [];
  const timed: Record<string, Timing[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (const id of ids) {
    const s = style(id);
    const assFile = path.join(dir, `d-${id}.ass`);
    writeFileSync(assFile, toAss(layoutCaptions(words, V916, s), V916, s));
  }
  encode(null, path.join(dir, "d-warmup.mp4")); // page cache and CPU frequency, not measured
  for (let rep = 0; rep < reps; rep++) {
    base.push(encode(null, path.join(dir, "d-plain.mp4")));
    for (const id of ids) (timed[id] as Timing[]).push(encode(captionFilter(path.join(dir, `d-${id}.ass`), FONTS_DIR), path.join(dir, `d-${id}.mp4`)));
  }
  out.withoutCaptions = { wallSec: base.map((v) => round(v.wall, 2)), cpuSec: base.map((v) => round(v.cpu, 2)) };
  out.presets = Object.fromEntries(ids.map((id) => {
    const values = timed[id] as Timing[];
    const wall = values.map((v) => v.wall);
    const cpu = values.map((v) => v.cpu);
    const baseWall = base.map((v) => v.wall);
    const baseCpu = base.map((v) => v.cpu);
    return [id, {
      withCaptions: { wallSec: wall.map((v) => round(v, 2)), cpuSec: cpu.map((v) => round(v, 2)) },
      wall: { medianRatio: round(median(wall) / median(baseWall), 4), medianOfPairedRatios: round(median(wall.map((v, i) => v / (baseWall[i] as number))), 4), overheadPct: round((median(wall) / median(baseWall) - 1) * 100, 1) },
      cpu: { medianRatio: round(median(cpu) / median(baseCpu), 4), medianOfPairedRatios: round(median(cpu.map((v, i) => v / (baseCpu[i] as number))), 4), overheadPct: round((median(cpu) / median(baseCpu) - 1) * 100, 1) },
    }];
  }));
  result.d = out;
}

console.log(JSON.stringify(result, null, 2));
