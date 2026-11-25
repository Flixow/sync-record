// The ASS captions through real libass (the ffmpeg `ass` filter the export uses): highlight timing on decoded frames,
// escaping, the bundled font, awkward paths and the safe area. Skipped when this ffmpeg has no libass.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTION_STYLES, captionBoxes, captionFilter, captionStyleById, layoutCaptions, textUnits, toAss, type CaptionLine, type CaptionStyle } from "../../src/shared/captions.js";
import { insideRect, safeArea, type Canvas } from "../../src/shared/safe-area.js";
import type { TranscriptWord } from "../../src/shared/transcript.js";
import { FONTS_DIR, hasLibass, inkBox, renderFrames, sizeOf } from "../support/caption-render.js";

const word = (t: string, s: number, e: number): TranscriptWord => ({ t, s, e, src: "p1-audio", pid: "p1" });
const FPS = 30;
let dir = "";

/** Number of pixels of `rgb` within 3 of the colour on every channel, and their mean x. */
function colourPixels(rgb: Buffer, width: number, colour: [number, number, number]): { count: number; meanX: number } {
  let count = 0;
  let sumX = 0;
  for (let at = 0, pixel = 0; at < rgb.length; at += 3, pixel++) {
    if (Math.abs((rgb[at] as number) - colour[0]) <= 3 && Math.abs((rgb[at + 1] as number) - colour[1]) <= 3 && Math.abs((rgb[at + 2] as number) - colour[2]) <= 3) {
      count += 1;
      sumX += pixel % width;
    }
  }
  return { count, meanX: count === 0 ? 0 : sumX / count };
}

const plain = (fontSize: number, bold = true): CaptionStyle => ({ ...(captionStyleById("clean") as CaptionStyle), id: "plain", bold, fontSize, outlineWidth: 0, shadow: 0, uppercase: false, highlightMode: "none" });
const emptyFontconfig = (): string => {
  const file = path.join(dir, "empty-fonts.conf");
  writeFileSync(file, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><cachedir>${path.join(dir, "fc-cache")}</cachedir></fontconfig>\n`);
  return file;
};

async function frames(ass: string, canvas: Canvas, seconds: number, fps: number, extra: { background?: string; env?: NodeJS.ProcessEnv; filter?: string; logLevel?: string } = {}): Promise<{ rgb: Buffer[]; log: string }> {
  const file = path.join(dir, `t-${Math.abs(hash(ass + JSON.stringify(extra)))}.ass`);
  writeFileSync(file, ass);
  const rgb: Buffer[] = [];
  const { log } = await renderFrames({ assFile: file, width: canvas.width, height: canvas.height, fps, seconds, background: extra.background ?? "000000", ...(extra.env ? { env: extra.env } : {}), ...(extra.filter ? { filter: extra.filter.replace("%FILE%", file) } : {}), ...(extra.logLevel ? { logLevel: extra.logLevel } : {}) }, (_index, frame) => rgb.push(Buffer.from(frame)));
  return { rgb, log };
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + (char.codePointAt(0) as number)) | 0;
  return value;
}

describe.runIf(hasLibass())("captions rendered by libass", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "syncrecord-captions-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("switches a word highlight on at the word start and off at its end, within one frame", { timeout: 60_000 }, async () => {
    const style = captionStyleById("bold-box") as CaptionStyle;
    const canvas: Canvas = { width: 640, height: 360 };
    const words = [word("alpha", 300, 800), word("bravo", 1000, 1500), word("charlie", 1700, 2300)];
    const [event] = layoutCaptions(words, canvas, style) as [CaptionLine];
    expect(event.words).toHaveLength(3);
    const { rgb } = await frames(toAss([event], canvas, style), canvas, 3, FPS, { background: "101010" });
    const highlight: [number, number, number] = [0xff, 0xd2, 0x3f];
    const present = rgb.map((frame) => colourPixels(frame, canvas.width, highlight).count >= 20);
    // runs of frames with the highlight on
    const runs: [number, number][] = [];
    present.forEach((on, f) => {
      if (on && !present[f - 1]) runs.push([f, f]);
      if (on) (runs[runs.length - 1] as [number, number])[1] = f;
    });
    expect(runs).toHaveLength(3);
    event.words.forEach((w, k) => {
      const [first, last] = runs[k] as [number, number];
      const onMs = (first / FPS) * 1000;
      const offMs = ((last + 1) / FPS) * 1000;
      expect(onMs - w.s, `word ${k} on`).toBeGreaterThanOrEqual(-1);
      expect(onMs - w.s, `word ${k} on`).toBeLessThanOrEqual(1000 / FPS + 6);
      expect(offMs - w.e, `word ${k} off`).toBeGreaterThanOrEqual(-1);
      expect(offMs - w.e, `word ${k} off`).toBeLessThanOrEqual(1000 / FPS + 6);
    });
    // before the event and after it nothing is drawn
    expect(inkBox(rgb[0] as Buffer, canvas.width, canvas.height, [16, 16, 16], 0)).toBeNull();
    expect(inkBox(rgb[rgb.length - 1] as Buffer, canvas.width, canvas.height, [16, 16, 16], 0)).toBeNull();
  });

  it("sweeps the karaoke fill across a word while it is spoken", { timeout: 60_000 }, async () => {
    const style = captionStyleById("karaoke-pop") as CaptionStyle;
    const canvas: Canvas = { width: 640, height: 360 };
    const [event] = layoutCaptions([word("sweeping", 500, 1700)], canvas, style) as [CaptionLine];
    const { rgb } = await frames(toAss([event], canvas, style), canvas, 3, FPS, { background: "101010" });
    const filled = rgb.map((frame) => colourPixels(frame, canvas.width, [0xff, 0xe1, 0x4d]).count);
    const firstFrame = filled.findIndex((count) => count > 0);
    expect((firstFrame / FPS) * 1000 - 500).toBeLessThanOrEqual(100);
    expect((firstFrame / FPS) * 1000 - 500).toBeGreaterThanOrEqual(-1);
    const lastFrame = Math.ceil((event.e / 1000) * FPS) - 1; // the last frame the event is on screen
    const during = filled.slice(firstFrame, lastFrame + 1);
    for (let i = 1; i < during.length; i++) expect(during[i] as number).toBeGreaterThanOrEqual(during[i - 1] as number);
    const peak = Math.max(...filled);
    expect(during[0]).toBeLessThan(peak * 0.2); // the fill starts empty
    expect(filled[lastFrame] as number).toBeGreaterThan(peak * 0.95); // and is complete when the word ends
    expect(filled[lastFrame + 1]).toBe(0); // nothing after the event
  });

  it("shows braces and backslashes as text, and never as tags or line breaks", { timeout: 60_000 }, async () => {
    const style = plain(120);
    const canvas: Canvas = { width: 1280, height: 720 };
    const em = (120 * 720) / 1080;
    const draw = async (text: string): Promise<[number, number]> => {
      const event: CaptionLine = { s: 0, e: 2000, words: [{ text, s: 0, e: 2000 }], lines: [text] };
      const { rgb } = await frames(toAss([event], canvas, style), canvas, 1, 1);
      return sizeOf(inkBox(rgb[0] as Buffer, canvas.width, canvas.height, [0, 0, 0], 8));
    };
    const [braceWidth] = await draw("{x}");
    const [plainWidth] = await draw("x");
    expect(braceWidth).toBeGreaterThan(plainWidth * 2);
    expect(braceWidth).toBeLessThanOrEqual((textUnits("{x}", true) / 1000) * em * 1.05);
    const [, slashHeight] = await draw("a\\Nb");
    expect(slashHeight).toBeLessThan(em * 1.4); // one line
    const [slashWidth] = await draw("a\\Nb");
    expect(slashWidth).toBeGreaterThan((textUnits("a", true) / 1000) * em * 2);
    const [, tagHeight] = await draw("{\\fs300}big");
    expect(tagHeight).toBeLessThan(em * 1.4); // the text is not an override block
  });

  it("renders every Polish letter in every preset's font, with no notdef box", { timeout: 120_000 }, async () => {
    const env = { FONTCONFIG_FILE: emptyFontconfig() }; // no system fonts: only the bundled ones can draw anything
    const canvas: Canvas = { width: 640, height: 360 };
    for (const bold of [false, true]) {
      const style = plain(216, bold);
      const probes = [..."ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "\u0378"];
      const events: CaptionLine[] = probes.map((char, k) => ({ s: k * 1000 - 400, e: k * 1000 + 600, words: [{ text: char, s: k * 1000 - 400, e: k * 1000 + 600 }], lines: [char] }));
      const { rgb } = await frames(toAss(events, canvas, style), canvas, probes.length, 1, { env });
      const sizes = rgb.map((frame) => sizeOf(inkBox(frame, canvas.width, canvas.height, [0, 0, 0], 8)));
      const notdef = sizes[sizes.length - 1] as [number, number];
      expect(notdef[0]).toBeGreaterThan(0); // the font's own box, so a missing glyph would be visible
      sizes.slice(0, -1).forEach((size, k) => {
        expect(size[0], probes[k]).toBeGreaterThan(0);
        expect(size[1], probes[k]).toBeGreaterThan(0);
        expect(size[0] === notdef[0] && size[1] === notdef[1], `${probes[k]} drawn as the notdef box`).toBe(false);
      });
    }
  });

  it("selects the bundled fonts, with and without the system fonts, and draws nothing without them", { timeout: 120_000 }, async () => {
    const canvas: Canvas = { width: 1080, height: 1920 };
    const bold = captionStyleById("bold-box") as CaptionStyle;
    const regular = captionStyleById("minimal") as CaptionStyle;
    for (const [style, face] of [[bold, "NotoSans-Bold"], [regular, "NotoSans-Regular"]] as const) {
      const events = layoutCaptions([word("Zażółć", 0, 500), word("gęślą", 500, 1000), word("jaźń", 1000, 1500)], canvas, style);
      const ass = toAss(events, canvas, style);
      const normal = await frames(ass, canvas, 2, 2, { logLevel: "debug" });
      const isolated = await frames(ass, canvas, 2, 2, { logLevel: "debug", env: { FONTCONFIG_FILE: emptyFontconfig() } });
      const selected = (log: string): string[] => log.split("\n").filter((line) => line.includes("fontselect"));
      expect(selected(normal.log).join("\n")).toContain(`-> ${face}, 0, ${face}`);
      expect(selected(normal.log).join("\n")).not.toMatch(/\/usr\/share\/fonts|\/usr\/local\/share\/fonts/);
      expect(selected(isolated.log).join("\n")).toContain(`-> ${face}, 0, ${face}`);
      expect(Buffer.compare(normal.rgb[1] as Buffer, isolated.rgb[1] as Buffer)).toBe(0);
      expect(inkBox(normal.rgb[1] as Buffer, canvas.width, canvas.height, [0, 0, 0], 0)).not.toBeNull();
      // the same file with no fonts directory and no system fonts has no font to draw with
      const without = await frames(ass, canvas, 2, 2, { env: { FONTCONFIG_FILE: emptyFontconfig() }, filter: "ass=filename=%FILE%" });
      expect(inkBox(without.rgb[1] as Buffer, canvas.width, canvas.height, [0, 0, 0], 0)).toBeNull();
    }
  });

  it("renders from a path and a fonts directory full of characters that need filter escaping", { timeout: 120_000 }, async () => {
    const awkward = path.join(dir, "it's: a [test];b=c,d\\e %x");
    const fonts = path.join(awkward, "fonts, with: stuff");
    mkdirSync(fonts, { recursive: true });
    for (const file of readdirSync(FONTS_DIR).filter((name) => name.endsWith(".ttf"))) copyFileSync(path.join(FONTS_DIR, file), path.join(fonts, file));
    const style = captionStyleById("clean") as CaptionStyle;
    const canvas: Canvas = { width: 640, height: 360 };
    const events = layoutCaptions([word("path", 0, 800), word("escaping", 800, 1600)], canvas, style);
    const assFile = path.join(awkward, "cap'tions: 1,2;3.ass");
    writeFileSync(assFile, toAss(events, canvas, style));
    const rgb: Buffer[] = [];
    await renderFrames({ assFile, fontsDir: fonts, width: canvas.width, height: canvas.height, fps: 2, seconds: 2, background: "000000" }, (_index, frame) => rgb.push(Buffer.from(frame)));
    expect(inkBox(rgb[1] as Buffer, canvas.width, canvas.height, [0, 0, 0], 0)).not.toBeNull();
    expect(captionFilter(assFile, fonts)).toContain("ass=filename=");
  });

  it("keeps rendered captions inside the safe area of a 9:16 canvas, in every preset, on the longest lines", { timeout: 180_000 }, async () => {
    const canvas: Canvas = { width: 1080, height: 1920 };
    const area = safeArea(canvas);
    const speech = "Nieprzewidywalność zachowań konsumentów wpływa na decyzje; the international organisation announced extraordinary measures yesterday".split(" ");
    const input = speech.map((t, i) => word(t, i * 330, i * 330 + 320));
    const extremes = ["WWWWWWWWWW MMMMMMMMMM", "Zażółć gęślą jaźń, ĄĆĘŁŃÓŚŹŻ", "Nieprzewidywalnościamiwszechświata", "mmmmmmmmm WWWWWWWW iiiiiiiiiiiiii"];
    for (const style of CAPTION_STYLES) {
      const events = [...layoutCaptions(input, canvas, style), ...extremes.flatMap((text, i) => layoutCaptions(text.split(" ").map((t, k) => word(t, 100_000 + i * 5000 + k * 300, 100_000 + i * 5000 + k * 300 + 280)), canvas, style))];
      // one event per second, long enough to be on screen at its frame
      const slots = events.map((event, k) => {
        const shift = k * 1000 - 200 - event.s;
        return { ...event, s: event.s + shift, e: event.s + shift + 1000, words: event.words.map((w) => ({ ...w, s: w.s + shift, e: w.e + shift })) };
      });
      const boxes = captionBoxes(slots, canvas, style);
      const { rgb } = await frames(toAss(slots, canvas, style), canvas, slots.length, 1, { background: "336699" });
      expect(rgb).toHaveLength(slots.length);
      rgb.forEach((frame, k) => {
        const ink = inkBox(frame, canvas.width, canvas.height, [frame[0] as number, frame[1] as number, frame[2] as number], 0);
        expect(ink, `${style.id} #${k} ${JSON.stringify(slots[k]?.lines)}`).not.toBeNull();
        const rect = { x: (ink as NonNullable<typeof ink>).x0, y: (ink as NonNullable<typeof ink>).y0, w: (ink as NonNullable<typeof ink>).x1 - (ink as NonNullable<typeof ink>).x0 + 1, h: (ink as NonNullable<typeof ink>).y1 - (ink as NonNullable<typeof ink>).y0 + 1 };
        expect(insideRect(boxes[k] as NonNullable<(typeof boxes)[number]>, area), `${style.id} #${k} box`).toBe(true);
        expect(insideRect(rect, area), `${style.id} #${k} ink ${JSON.stringify(rect)} in ${JSON.stringify(area)}: ${JSON.stringify(slots[k]?.lines)}`).toBe(true);
        expect(insideRect(rect, boxes[k] as NonNullable<(typeof boxes)[number]>), `${style.id} #${k} ink ${JSON.stringify(rect)} in box ${JSON.stringify(boxes[k])}`).toBe(true);
      });
    }
  });
});
