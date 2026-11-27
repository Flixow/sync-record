import { describe, expect, it } from "vitest";
import {
  backgroundCss,
  backgroundFfmpeg,
  canvasFor,
  CANVASES,
  computeTiles,
  containSize,
  DEFAULT_BACKGROUND,
  effectiveLayout,
  LAYOUT_CAPACITY,
  LAYOUT_IDS,
  tileCss,
  tileFfmpeg,
  type Aspect,
  type Fit,
  type LayoutId,
  type LayoutInput,
  type LayoutSource,
  type Tile,
  type TileCss,
} from "../../src/shared/layout.js";
import { insideRect, safeArea, type Canvas, type Rect } from "../../src/shared/safe-area.js";

/** Small deterministic generator so a failing input can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];
const CAMERA_SIZES: [number, number][] = [[1920, 1080], [1280, 720], [640, 480], [1080, 1920], [854, 480], [1279, 719], [640, 360]];
const SCREEN_SIZES: [number, number][] = [[2560, 1440], [1920, 1080], [1366, 768], [1440, 900], [1281, 801]];
const pick = <T>(next: () => number, list: T[]): T => list[Math.floor(next() * list.length)] as T;

function randomSources(next: () => number, count: number, withScreen: boolean): LayoutSource[] {
  return Array.from({ length: count }, (_, index) => {
    const screen = withScreen && next() < 0.4;
    const [width, height] = pick(next, screen ? SCREEN_SIZES : CAMERA_SIZES);
    return { id: `s${index}`, kind: screen ? "screen" : "camera", width, height };
  });
}

const camera = (id: string, width = 1920, height = 1080): LayoutSource => ({ id, kind: "camera", width, height });
const screen = (id: string, width = 1920, height = 1080): LayoutSource => ({ id, kind: "screen", width, height });
const rect = (tile: Tile): Rect => ({ x: tile.x, y: tile.y, w: tile.w, h: tile.h });
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const even = (n: number): boolean => Number.isInteger(n) && n % 2 === 0;

function* randomInputs(seeds: number): Generator<{ input: LayoutInput; label: string }> {
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed);
    for (const layout of LAYOUT_IDS) {
      for (const aspect of ASPECTS) {
        const canvas = canvasFor(aspect, pick(next, [360, 640, 1280, 1920]));
        const count = 1 + Math.floor(next() * 4);
        const sources = randomSources(next, count, true);
        const fit: Fit | undefined = next() < 0.25 ? pick<Fit>(next, ["fill", "fit"]) : undefined;
        const focus = next() < 0.5 ? { s0: { x: next(), y: next() }, s1: { x: next(), y: next() } } : undefined;
        const gap = next() < 0.3 ? Math.floor(next() * 40) : undefined;
        yield { input: { layout, canvas, sources, fit, focus, gap }, label: `seed ${seed} ${layout} ${aspect} ${canvas.width}x${canvas.height} sources ${sources.map((source) => `${source.kind}:${source.width}x${source.height}`).join(",")}` };
      }
    }
  }
}

describe("canvases", () => {
  it("has the three output aspects at full size", () => {
    expect(CANVASES["16:9"]).toEqual({ width: 1920, height: 1080 });
    expect(CANVASES["9:16"]).toEqual({ width: 1080, height: 1920 });
    expect(CANVASES["1:1"]).toEqual({ width: 1080, height: 1080 });
    expect(canvasFor("16:9")).toEqual({ width: 1920, height: 1080 });
  });

  it("scales to a long edge keeping the aspect and even sizes", () => {
    expect(canvasFor("16:9", 640)).toEqual({ width: 640, height: 360 });
    expect(canvasFor("9:16", 640)).toEqual({ width: 360, height: 640 });
    expect(canvasFor("1:1", 640)).toEqual({ width: 640, height: 640 });
    for (const aspect of ASPECTS) {
      for (const edge of [100, 321, 479, 640, 777, 1280, 1920, 3840]) {
        const canvas = canvasFor(aspect, edge);
        expect(even(canvas.width) && even(canvas.height), `${aspect} ${edge}`).toBe(true);
        const full = CANVASES[aspect];
        expect(Math.abs(canvas.width / canvas.height - full.width / full.height) / (full.width / full.height)).toBeLessThan(0.03);
      }
    }
  });
});

describe("effective layout", () => {
  it("degrades a layout that wants more pictures than there are", () => {
    expect(effectiveLayout("grid", 4)).toBe("grid");
    expect(effectiveLayout("grid", 3)).toBe("grid");
    expect(effectiveLayout("grid", 2)).toBe("side-by-side");
    expect(effectiveLayout("grid", 1)).toBe("solo");
    expect(effectiveLayout("side-by-side", 2)).toBe("side-by-side");
    expect(effectiveLayout("side-by-side", 1)).toBe("solo");
    expect(effectiveLayout("speaker-thumbs", 3)).toBe("speaker-thumbs");
    expect(effectiveLayout("speaker-thumbs", 1)).toBe("solo");
    expect(effectiveLayout("screen-camera", 2)).toBe("screen-camera");
    expect(effectiveLayout("screen-camera", 1)).toBe("solo");
    expect(effectiveLayout("solo", 4)).toBe("solo");
    expect(effectiveLayout("grid", 0)).toBe("solo");
  });
});

describe("tile geometry invariants", () => {
  it("keeps every tile inside the canvas on even integers, with crops inside the source", () => {
    let checked = 0;
    for (const { input, label } of randomInputs(60)) {
      const { tiles } = computeTiles(input);
      expect(tiles.length, label).toBeGreaterThan(0);
      // without a screen to feature, screen-camera shows the cameras like a grid
      const capacity = input.layout === "screen-camera" && !input.sources.some((source) => source.kind === "screen") ? LAYOUT_CAPACITY.grid : LAYOUT_CAPACITY[input.layout];
      expect(tiles.length, label).toBeLessThanOrEqual(capacity);
      for (const tile of tiles) {
        checked++;
        const source = input.sources.find((candidate) => candidate.id === tile.sourceId) as LayoutSource;
        for (const value of [tile.x, tile.y, tile.w, tile.h, tile.crop.x, tile.crop.y, tile.crop.w, tile.crop.h]) expect(even(value), `${label}: ${JSON.stringify(tile)}`).toBe(true);
        expect(tile.w, label).toBeGreaterThanOrEqual(2);
        expect(tile.h, label).toBeGreaterThanOrEqual(2);
        expect(insideRect(rect(tile), { x: 0, y: 0, w: input.canvas.width, h: input.canvas.height }), `${label}: ${JSON.stringify(tile)}`).toBe(true);
        expect(tile.crop.x >= 0 && tile.crop.y >= 0 && tile.crop.x + tile.crop.w <= source.width && tile.crop.y + tile.crop.h <= source.height, `${label}: crop ${JSON.stringify(tile.crop)}`).toBe(true);
        expect(tile.sourceSize).toEqual({ w: source.width, h: source.height });
        if (tile.fit === "fill") {
          const cropAspect = tile.crop.w / tile.crop.h;
          const tileAspect = tile.w / tile.h;
          // the crop has the tile's aspect ratio to within the even-pixel rounding of its smaller side
          expect(Math.abs(cropAspect - tileAspect) / tileAspect, `${label}: ${JSON.stringify(tile)}`).toBeLessThanOrEqual(2 / Math.min(tile.crop.w, tile.crop.h) + 1e-9);
        } else {
          expect(tile.crop, label).toEqual({ x: 0, y: 0, w: source.width - (source.width % 2), h: source.height - (source.height % 2) });
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("does not overlap tiles except a picture-in-picture over the screen", () => {
    for (const { input, label } of randomInputs(60)) {
      const { tiles } = computeTiles(input);
      for (let a = 0; a < tiles.length; a++) {
        for (let b = a + 1; b < tiles.length; b++) {
          const first = tiles[a] as Tile;
          const second = tiles[b] as Tile;
          if (first.z !== second.z) {
            expect(input.layout, label).toBe("screen-camera");
            expect(input.canvas.height <= input.canvas.width, `${label}: a picture-in-picture only exists off vertical video`).toBe(true);
            continue;
          }
          expect(overlap(rect(first), rect(second)), `${label}: ${JSON.stringify(first)} ${JSON.stringify(second)}`).toBe(false);
        }
      }
    }
  });

  it("keeps every face tile inside the safe area of a 9:16 canvas, for every layout and 1 to 4 sources", () => {
    let faceTiles = 0;
    for (const canvas of [canvasFor("9:16"), canvasFor("9:16", 1280), canvasFor("9:16", 640), canvasFor("9:16", 360)]) {
      const safe = safeArea(canvas);
      for (const layout of LAYOUT_IDS) {
        for (let count = 1; count <= 4; count++) {
          for (const withScreen of [false, true]) {
            const sources: LayoutSource[] = Array.from({ length: count }, (_, index) => (withScreen && index === (count > 1 ? 1 : 0) ? screen(`s${index}`) : camera(`s${index}`, index % 2 === 0 ? 1920 : 1080, index % 2 === 0 ? 1080 : 1920)));
            for (const fit of [undefined, "fill", "fit"] as const) {
              const { tiles } = computeTiles({ layout, canvas, sources, fit });
              for (const tile of tiles) {
                const kind = sources.find((source) => source.id === tile.sourceId)?.kind;
                // a screen shows no face, but it carries text the platform's buttons would cover, so every tile stays clear
                expect(insideRect(rect(tile), safe), `${layout} ${canvas.width}x${canvas.height} n=${count} screen=${withScreen} fit=${fit} ${kind}: ${JSON.stringify(tile)} safe ${JSON.stringify(safe)}`).toBe(true);
                if (kind === "camera") faceTiles++;
              }
            }
          }
        }
      }
    }
    expect(faceTiles).toBeGreaterThan(200);
  });

  it("is the same picture on the preview canvas as on the render canvas", () => {
    for (const aspect of ASPECTS) {
      for (const layout of LAYOUT_IDS) {
        for (const count of [1, 2, 3, 4]) {
          const sources: LayoutSource[] = Array.from({ length: count }, (_, index) => (layout === "screen-camera" && index === 0 ? screen("s0", 1920, 1080) : camera(`s${index}`, 1920, 1080)));
          const big = computeTiles({ layout, canvas: canvasFor(aspect), sources });
          const small = computeTiles({ layout, canvas: canvasFor(aspect, 640), sources });
          expect(small.tiles.length).toBe(big.tiles.length);
          big.tiles.forEach((tile, index) => {
            const other = small.tiles[index] as Tile;
            const bigCanvas = canvasFor(aspect);
            const smallCanvas = canvasFor(aspect, 640);
            expect(other.sourceId).toBe(tile.sourceId);
            expect(Math.abs(other.x / smallCanvas.width - tile.x / bigCanvas.width), `${layout} ${aspect} x`).toBeLessThan(0.012);
            expect(Math.abs(other.y / smallCanvas.height - tile.y / bigCanvas.height), `${layout} ${aspect} y`).toBeLessThan(0.012);
            expect(Math.abs(other.w / smallCanvas.width - tile.w / bigCanvas.width), `${layout} ${aspect} w`).toBeLessThan(0.012);
            expect(Math.abs(other.h / smallCanvas.height - tile.h / bigCanvas.height), `${layout} ${aspect} h`).toBeLessThan(0.012);
            expect(Math.abs(other.crop.x / 1920 - tile.crop.x / 1920) + Math.abs(other.crop.w / 1920 - tile.crop.w / 1920), `${layout} ${aspect} crop`).toBeLessThan(0.02);
          });
        }
      }
    }
  });
});

describe("layouts", () => {
  const wide = canvasFor("16:9");
  const tall = canvasFor("9:16");
  const square = canvasFor("1:1");

  it("solo shows the first source over the whole canvas, cropped to fill", () => {
    const { tiles } = computeTiles({ layout: "solo", canvas: wide, sources: [camera("a"), camera("b")] });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ sourceId: "a", x: 0, y: 0, w: 1920, h: 1080, fit: "fill", z: 0 });
    expect(tiles[0]?.crop).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("solo on 9:16 crops the camera around the focus point, inside the safe area", () => {
    const safe = safeArea(tall);
    const centred = computeTiles({ layout: "solo", canvas: tall, sources: [camera("a")] }).tiles[0] as Tile;
    expect(insideRect(rect(centred), safe)).toBe(true);
    expect(centred.fit).toBe("fill");
    expect(centred.crop.h).toBe(1080);
    expect(centred.crop.w).toBeLessThan(1080 * 0.7);
    expect(Math.abs(centred.crop.x + centred.crop.w / 2 - 960)).toBeLessThanOrEqual(2);
    const left = computeTiles({ layout: "solo", canvas: tall, sources: [camera("a")], focus: { a: { x: 0.25, y: 0.4 } } }).tiles[0] as Tile;
    expect(Math.abs(left.crop.x + left.crop.w / 2 - 480)).toBeLessThanOrEqual(2);
    const edge = computeTiles({ layout: "solo", canvas: tall, sources: [camera("a")], focus: { a: { x: 0, y: 0 } } }).tiles[0] as Tile;
    expect(edge.crop.x).toBe(0);
    const far = computeTiles({ layout: "solo", canvas: tall, sources: [camera("a")], focus: { a: { x: 3, y: -2 } } }).tiles[0] as Tile;
    expect(far.crop.x + far.crop.w).toBe(1920);
  });

  it("biases a vertical crop of a camera towards the upper third, and not a screen", () => {
    const sources = [camera("a"), camera("b")];
    const featured = computeTiles({ layout: "speaker-thumbs", canvas: wide, sources }).tiles[0] as Tile;
    const centredCrop = computeTiles({ layout: "speaker-thumbs", canvas: wide, sources, focus: { a: { x: 0.5, y: 0.5 } } }).tiles[0] as Tile;
    expect(featured.crop.h).toBeLessThan(1080);
    expect(featured.crop.y).toBeLessThan(centredCrop.crop.y);
    const cropOfScreen = computeTiles({ layout: "speaker-thumbs", canvas: wide, sources: [screen("a"), camera("b")], fit: "fill" }).tiles[0] as Tile;
    expect(cropOfScreen.crop.y).toBe(centredCrop.crop.y);
  });

  it("side by side puts two equal tiles left and right on 16:9 and 1:1, stacked on 9:16", () => {
    for (const canvas of [wide, square]) {
      const [first, second] = computeTiles({ layout: "side-by-side", canvas, sources: [camera("a"), camera("b"), camera("c")] }).tiles as [Tile, Tile];
      expect(first.sourceId).toBe("a");
      expect(second.sourceId).toBe("b");
      expect([first.w, first.h]).toEqual([second.w, second.h]);
      expect(first.y).toBe(second.y);
      expect(second.x).toBeGreaterThanOrEqual(first.x + first.w);
      expect(first.x + first.w / 2).toBeLessThan(canvas.width / 2);
      expect(second.x + second.w / 2).toBeGreaterThan(canvas.width / 2);
    }
    const [top, bottom] = computeTiles({ layout: "side-by-side", canvas: tall, sources: [camera("a"), camera("b")] }).tiles as [Tile, Tile];
    expect(top.x).toBe(bottom.x);
    expect([top.w, top.h]).toEqual([bottom.w, bottom.h]);
    expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.h);
  });

  it("grid is 2x2, and three sources are two over one centred", () => {
    const four = computeTiles({ layout: "grid", canvas: wide, sources: ["a", "b", "c", "d"].map((id) => camera(id)) }).tiles;
    expect(four.map((tile) => tile.sourceId)).toEqual(["a", "b", "c", "d"]);
    expect(new Set(four.map((tile) => `${tile.w}x${tile.h}`)).size).toBe(1);
    expect(four[0]?.y).toBe(four[1]?.y);
    expect(four[2]?.y).toBe(four[3]?.y);
    expect(four[0]?.x).toBe(four[2]?.x);
    expect(four[1]?.x).toBe(four[3]?.x);
    const three = computeTiles({ layout: "grid", canvas: wide, sources: ["a", "b", "c"].map((id) => camera(id)) }).tiles;
    expect(three).toHaveLength(3);
    const [a, b, c] = three as [Tile, Tile, Tile];
    expect(c.y).toBeGreaterThan(a.y);
    expect(Math.abs(c.x + c.w / 2 - (a.x + b.x + b.w) / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.x + c.w / 2 - wide.width / 2)).toBeLessThanOrEqual(2);
    // two sources degrade to side by side, one to solo
    expect(computeTiles({ layout: "grid", canvas: wide, sources: [camera("a"), camera("b")] }).tiles.map((tile) => tile.w)).toEqual([954, 954]);
    expect(computeTiles({ layout: "grid", canvas: wide, sources: [camera("a")] }).tiles).toHaveLength(1);
  });

  it("speaker thumbs: a large featured tile and the others as a strip at the bottom", () => {
    for (const canvas of [wide, square, tall]) {
      const { tiles } = computeTiles({ layout: "speaker-thumbs", canvas, sources: ["a", "b", "c", "d"].map((id) => camera(id)) });
      const [featured, ...thumbs] = tiles as [Tile, ...Tile[]];
      expect(featured.sourceId).toBe("a");
      expect(thumbs.map((tile) => tile.sourceId)).toEqual(["b", "c", "d"]);
      for (const thumb of thumbs) {
        expect(thumb.y).toBeGreaterThanOrEqual(featured.y + featured.h);
        expect(thumb.w * thumb.h).toBeLessThan(featured.w * featured.h * 0.2);
        expect(thumb.y).toBe(thumbs[0]?.y);
      }
      expect(featured.w * featured.h).toBeGreaterThan(canvas.width * canvas.height * (canvas.height > canvas.width ? 0.45 : 0.6));
    }
    const bottom = computeTiles({ layout: "speaker-thumbs", canvas: tall, sources: [camera("a"), camera("b"), camera("c")] }).tiles;
    const safe = safeArea(tall);
    for (const tile of bottom) expect(tile.y + tile.h).toBeLessThanOrEqual(safe.y + safe.h);
  });

  it("screen-camera features the screen with the first camera as a corner picture-in-picture", () => {
    // the screen is found by its kind, not by its position
    const { tiles } = computeTiles({ layout: "screen-camera", canvas: wide, sources: [camera("cam"), camera("other"), screen("scr")] });
    expect(tiles.map((tile) => tile.sourceId)).toEqual(["scr", "cam"]);
    const [shared, pip] = tiles as [Tile, Tile];
    expect(shared).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080, fit: "fit", z: 0 });
    expect(pip.z).toBeGreaterThan(shared.z);
    expect(pip.fit).toBe("fill");
    expect(pip.x).toBeGreaterThan(wide.width / 2);
    expect(pip.y).toBeGreaterThan(wide.height / 2);
    expect(pip.x + pip.w).toBeLessThan(wide.width);
    expect(pip.y + pip.h).toBeLessThan(wide.height);
    expect(pip.w).toBeLessThan(wide.width * 0.4);
    // vertical video: the screen on top, the camera below, no overlap
    const stacked = computeTiles({ layout: "screen-camera", canvas: tall, sources: [screen("scr"), camera("cam")] }).tiles as [Tile, Tile];
    expect(stacked[0].sourceId).toBe("scr");
    expect(stacked[1].sourceId).toBe("cam");
    expect(stacked[1].y).toBeGreaterThanOrEqual(stacked[0].y + stacked[0].h);
    expect(stacked[0].w).toBe(stacked[1].w);
  });

  it("screen-camera features the first screen of the scene: with several shares in the list the scene's own wins", () => {
    // a scene of the second share lists its own screen first; the screen of another share is not drawn
    const { tiles } = computeTiles({ layout: "screen-camera", canvas: wide, sources: [screen("share-2"), camera("cam"), screen("share-1")] });
    expect(tiles.map((tile) => tile.sourceId).sort()).toEqual(["cam", "share-2"]);
  });

  it("screen-camera without a screen shows the cameras, without a camera shows the screen", () => {
    expect(computeTiles({ layout: "screen-camera", canvas: wide, sources: [camera("a"), camera("b")] }).tiles.map((tile) => tile.sourceId)).toEqual(["a", "b"]);
    expect(computeTiles({ layout: "screen-camera", canvas: wide, sources: [camera("a"), camera("b"), camera("c")] }).tiles).toHaveLength(3);
    const only = computeTiles({ layout: "screen-camera", canvas: wide, sources: [screen("scr")] }).tiles;
    expect(only.map((tile) => tile.sourceId)).toEqual(["scr"]);
    expect(computeTiles({ layout: "solo", canvas: wide, sources: [] }).tiles).toEqual([]);
  });

  it("fits screens and fills cameras by default, and obeys an explicit fit", () => {
    const sources = [camera("a"), screen("b")];
    expect(computeTiles({ layout: "side-by-side", canvas: wide, sources }).tiles.map((tile) => tile.fit)).toEqual(["fill", "fit"]);
    expect(computeTiles({ layout: "side-by-side", canvas: wide, sources, fit: "fit" }).tiles.map((tile) => tile.fit)).toEqual(["fit", "fit"]);
    expect(computeTiles({ layout: "side-by-side", canvas: wide, sources, fit: "fill" }).tiles.map((tile) => tile.fit)).toEqual(["fill", "fill"]);
  });

  it("returns the background, a colour unless asked otherwise", () => {
    expect(computeTiles({ layout: "solo", canvas: wide, sources: [camera("a")] }).background).toEqual(DEFAULT_BACKGROUND);
    const blur = { kind: "blur", sigma: 40 } as const;
    expect(computeTiles({ layout: "solo", canvas: wide, sources: [camera("a")], background: blur }).background).toEqual(blur);
  });

  it("rejects a source without a picture size", () => {
    expect(() => computeTiles({ layout: "solo", canvas: wide, sources: [camera("a", 0, 0)] })).toThrow(RangeError);
  });
});

// ---- preview and render describe the same picture ---------------------------------------------------------------------

const px = (value: string, total: number): number => (Number.parseFloat(value) / 100) * total;

/** The rectangle of the source that a browser shows for `object-fit: cover` and this `object-position`, in source pixels. */
function coverWindow(css: TileCss, tileW: number, tileH: number, sw: number, sh: number): Rect {
  const scale = Math.max(tileW / sw, tileH / sh);
  const w = tileW / scale;
  const h = tileH / scale;
  const [positionX, positionY] = css.objectPosition.split(" ").map((part) => Number.parseFloat(part)) as [number, number];
  return { x: (sw - w) * (positionX / 100), y: (sh - h) * (positionY / 100), w, h };
}

/** The rectangle `object-fit: contain` draws inside the element box, in element-relative pixels. */
function containRect(tileW: number, tileH: number, sw: number, sh: number): Rect {
  const scale = Math.min(tileW / sw, tileH / sh);
  return { x: (tileW - sw * scale) / 2, y: (tileH - sh * scale) / 2, w: sw * scale, h: sh * scale };
}

const near = (a: number, b: number, tolerance: number, message: string): void => expect(Math.abs(a - b), `${message}: ${a} vs ${b}`).toBeLessThanOrEqual(tolerance);

describe("preview and render describe the same picture", () => {
  it("tileCss and tileFfmpeg give the same rectangles and crops for random inputs", () => {
    let fills = 0;
    let fits = 0;
    for (const { input, label } of randomInputs(80)) {
      const { tiles } = computeTiles(input);
      for (const tile of tiles) {
        const css = tileCss(tile, input.canvas);
        const ffmpeg = tileFfmpeg(tile);
        const cssLeft = px(css.left, input.canvas.width);
        const cssTop = px(css.top, input.canvas.height);
        const cssW = px(css.width, input.canvas.width);
        const cssH = px(css.height, input.canvas.height);
        const scale = /^scale=(\d+):(\d+):flags=lanczos$/.exec(ffmpeg.scale);
        expect(scale, `${label}: ${ffmpeg.scale}`).not.toBeNull();
        const scaledW = Number(scale?.[1]);
        const scaledH = Number(scale?.[2]);
        const cropMatch = ffmpeg.crop === "" ? null : /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(ffmpeg.crop);
        if (ffmpeg.crop !== "") expect(cropMatch, `${label}: ${ffmpeg.crop}`).not.toBeNull();
        const cropped: Rect = cropMatch ? { w: Number(cropMatch[1]), h: Number(cropMatch[2]), x: Number(cropMatch[3]), y: Number(cropMatch[4]) } : { x: 0, y: 0, w: tile.sourceSize.w, h: tile.sourceSize.h };
        expect(ffmpeg.pad).toBe("");
        expect(even(ffmpeg.overlay.x) && even(ffmpeg.overlay.y) && even(scaledW) && even(scaledH), `${label}: even filter values`).toBe(true);
        if (tile.fit === "fill") {
          fills++;
          expect(css.objectFit).toBe("cover");
          // the element is the tile box
          near(cssW, tile.w, 0.001, `${label} width`);
          near(cssH, tile.h, 0.001, `${label} height`);
          near(cssLeft, tile.x, 0.001, `${label} left`);
          near(cssTop, tile.y, 0.001, `${label} top`);
          // ffmpeg scales the crop to exactly the tile and overlays at its corner
          expect([scaledW, scaledH]).toEqual([tile.w, tile.h]);
          expect(ffmpeg.overlay).toEqual({ x: tile.x, y: tile.y });
          // the window a browser shows equals the crop (within 3 source pixels: even-pixel rounding of the crop, and an odd source size's lost pixel)
          const window = coverWindow(css, cssW, cssH, tile.sourceSize.w, tile.sourceSize.h);
          near(window.w, cropped.w, 3, `${label} crop width`);
          near(window.h, cropped.h, 3, `${label} crop height`);
          near(window.x, cropped.x, 3, `${label} crop x`);
          near(window.y, cropped.y, 3, `${label} crop y`);
          // and the filter string is the tile's crop
          expect(cropped).toEqual(tile.crop);
        } else {
          fits++;
          expect(css.objectFit).toBe("contain");
          expect(css.objectPosition).toBe("50% 50%");
          // the preview element is the contained picture itself, where ffmpeg overlays the scaled picture
          near(cssW, scaledW, 0.001, `${label} contained width`);
          near(cssH, scaledH, 0.001, `${label} contained height`);
          near(cssLeft, ffmpeg.overlay.x, 0.001, `${label} contained x`);
          near(cssTop, ffmpeg.overlay.y, 0.001, `${label} contained y`);
          // and that picture is the exact contain of the whole source in the tile box, to the even-pixel rounding
          const exact = containRect(tile.w, tile.h, tile.crop.w, tile.crop.h);
          near(scaledW, exact.w, 1, `${label} contained width`);
          near(scaledH, exact.h, 1, `${label} contained height`);
          near(ffmpeg.overlay.x - tile.x, exact.x, 1.5, `${label} contained offset x`);
          near(ffmpeg.overlay.y - tile.y, exact.y, 1.5, `${label} contained offset y`);
          expect(scaledW).toBeLessThanOrEqual(tile.w);
          expect(scaledH).toBeLessThanOrEqual(tile.h);
          expect(scaledW === tile.w || scaledH === tile.h).toBe(true);
          expect(insideRect({ x: ffmpeg.overlay.x, y: ffmpeg.overlay.y, w: scaledW, h: scaledH }, rect(tile))).toBe(true);
          // the cropped picture is the whole picture (to the even size)
          near(cropped.w, tile.sourceSize.w, 1, `${label} whole picture width`);
          near(cropped.h, tile.sourceSize.h, 1, `${label} whole picture height`);
        }
      }
    }
    expect(fills).toBeGreaterThan(500);
    expect(fits).toBeGreaterThan(200);
  });

  it("pads a contained picture to an opaque tile box on request, at the same place", () => {
    const tile = computeTiles({ layout: "side-by-side", canvas: canvasFor("16:9"), sources: [screen("a", 1280, 1024), camera("b")] }).tiles[0] as Tile;
    expect(tile.fit).toBe("fit");
    const plain = tileFfmpeg(tile);
    const padded = tileFfmpeg(tile, "#112233");
    expect(padded.scale).toBe(plain.scale);
    expect(padded.overlay).toEqual({ x: tile.x, y: tile.y });
    const parsed = /^pad=(\d+):(\d+):(\d+):(\d+):color=0x112233$/.exec(padded.pad);
    expect(parsed).not.toBeNull();
    expect([Number(parsed?.[1]), Number(parsed?.[2])]).toEqual([tile.w, tile.h]);
    expect([tile.x + Number(parsed?.[3]), tile.y + Number(parsed?.[4])]).toEqual([plain.overlay.x, plain.overlay.y]);
  });

  it("contains a picture without distortion in the largest even size", () => {
    for (const [sw, sh, w, h] of [[1920, 1080, 954, 1080], [1080, 1920, 862, 646], [1280, 1024, 960, 540], [1279, 719, 640, 360]] as const) {
      const size = containSize(sw, sh, w, h);
      expect(size.w <= w && size.h <= h && even(size.w) && even(size.h)).toBe(true);
      expect(size.w === w || size.h === h).toBe(true);
      expect(Math.abs(size.w / size.h - sw / sh) / (sw / sh)).toBeLessThan(0.01);
    }
  });
});

describe("background", () => {
  const wide = canvasFor("16:9");

  it("makes a colour canvas of the output size", () => {
    expect(backgroundFfmpeg({ kind: "color", color: "#0D0F12" }, wide, "v0")).toEqual({ input: null, chain: "color=c=0x0d0f12:s=1920x1080" });
    expect(backgroundFfmpeg({ kind: "color", color: "#ffffff" }, canvasFor("9:16"), "v0", 30).chain).toBe("color=c=0xffffff:s=1080x1920:r=30");
  });

  it("blurs a scaled-to-cover copy of the source picture", () => {
    const strong = backgroundFfmpeg({ kind: "blur", sigma: 40 }, wide, "v0");
    expect(strong.input).toBe("v0");
    expect(strong.chain).toBe("scale=480:270:force_original_aspect_ratio=increase,crop=480:270,gblur=sigma=10.00:steps=2,scale=1920:1080:flags=bicubic");
    const weak = backgroundFfmpeg({ kind: "blur", sigma: 8 }, wide, "v0");
    expect(weak.chain).toBe("scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=8.00");
    // the same blur on the preview canvas is a third as strong: the sigma follows the canvas size
    const preview = canvasFor("16:9", 640);
    expect(backgroundFfmpeg({ kind: "blur", sigma: 40 }, preview, "v0").chain).toContain("gblur=sigma=3.33");
    expect(backgroundCss({ kind: "blur", sigma: 40 }, preview).blurPx).toBeCloseTo(40 / 3, 1);
    expect(backgroundCss({ kind: "blur", sigma: 40 }, wide).blurPx).toBe(40);
    expect(backgroundCss({ kind: "color", color: "#ABCDEF" }, wide)).toEqual({ backgroundColor: "#abcdef", blurPx: 0 });
  });

  it("is an even-sized picture for every canvas", () => {
    for (const aspect of ASPECTS) {
      const canvas: Canvas = canvasFor(aspect, 333);
      for (const background of [{ kind: "color", color: "#000000" }, { kind: "blur", sigma: 30 }] as const) {
        const chain = backgroundFfmpeg(background, canvas, "v0").chain;
        for (const match of chain.matchAll(/(?:s=|scale=|crop=)(\d+)[x:](\d+)/g)) expect(even(Number(match[1])) && even(Number(match[2])), chain).toBe(true);
      }
    }
  });
});

describe("layout ids", () => {
  it("lists the five layouts with a capacity each", () => {
    expect([...LAYOUT_IDS].sort()).toEqual(["grid", "screen-camera", "side-by-side", "solo", "speaker-thumbs"]);
    for (const layout of LAYOUT_IDS as readonly LayoutId[]) expect(LAYOUT_CAPACITY[layout]).toBeGreaterThanOrEqual(1);
  });
});
