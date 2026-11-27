import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import { makeSyntheticSession } from "../support/synthetic.js";

// The layout section on a prepared two-camera session: Ala talks first, Bob answers, and so on. The scenes follow the
// speakers, the layout / shape / background change the live preview, a manual scene survives a reload, the keys undo
// the layout when the focus is in its panel, and a heavy export can be cancelled from the page.
const SID = "layout-fixture-0001";
const HOST = "p1-ala";
const DURATION_SEC = 30;
/** [start, end) seconds of each speaker's tone. */
const SPEECH = { ala: [[2, 8], [14, 20]], bob: [[8, 14], [20, 26]] } as const;

let browser: Browser;
let scratch = "";

const dropFixtures = async (): Promise<void> => {
  await rm(path.join(E2E_DATA_DIR, "session", SID), { recursive: true, force: true });
  await rm(path.join(E2E_DATA_DIR, "post", SID), { recursive: true, force: true });
};

function tone(file: string, hz: number, windows: readonly (readonly [number, number])[]): void {
  const enable = windows.map(([s, e]) => `between(t,${s},${e})`).join("+");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${DURATION_SEC}`, "-af", `volume=0:enable='1-(${enable})'`, file]);
}

test.beforeAll(async () => {
  browser = process.env.E2E_CDP_URL ? await chromium.connectOverCDP(process.env.E2E_CDP_URL) : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined });
  await dropFixtures();
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-layout-"));
  const ala = path.join(scratch, "ala.wav");
  const bob = path.join(scratch, "bob.wav");
  tone(ala, 440, SPEECH.ala);
  tone(bob, 660, SPEECH.bob);
  await makeSyntheticSession({
    sessionId: SID,
    storageDir: E2E_DATA_DIR,
    durationSec: DURATION_SEC,
    participants: [
      { name: "Ala", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, audioFile: ala },
      { name: "Bob", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, audioFile: bob },
    ],
    eventsMs: [4000, 10_000, 16_000, 22_000],
    cameraSize: "640x360",
  });
});

test.afterAll(async () => {
  await browser?.close();
  await dropFixtures();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const visibleVideos = (page: Page) => page.locator('[data-testid="pj-lay-video"]:not([hidden])');
const sceneRows = (page: Page) => page.locator('[data-testid="pj-lay-scene"]');
const saved = (page: Page) => expect(page.getByTestId("pj-lay-save")).toHaveAttribute("data-status", "saved");
const box = async (locator: ReturnType<Page["locator"]>): Promise<Box> => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element has no box");
  return found;
};
/** Every scene row of the list shows `layout`. */
const allScenes = (page: Page, layout: string): Promise<boolean> => sceneRows(page).evaluateAll((rows, expected) => rows.length > 0 && rows.every((row) => (row as HTMLElement).dataset.layout === expected), layout);

test("layout of a two-camera program: scenes, live preview, manual scenes, undo, persistence, cancelling an export", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 1000 } });
  // an action that cannot be done fails with its call log instead of waiting for the end of the test
  context.setDefaultTimeout(30_000);
  const token = issueToken(E2E_SECRET, { sid: SID, role: "participant", pid: HOST, host: true, exp: Date.now() + 3_600_000 });
  await context.addInitScript(
    ([sid, credentials]) => {
      try {
        localStorage.setItem(`syncrecord.session.${sid}`, JSON.stringify(credentials));
        localStorage.setItem("syncrecord.lang", "en");
      } catch {
        // an opaque origin (about:blank) has no storage
      }
    },
    [SID, { participantId: HOST, participantToken: token, name: "Ala", host: true }] as const,
  );
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  const canvas = page.getByTestId("pj-lay-canvas");

  await test.step("prepare the media: the layout section and its preview appear", async () => {
    await page.goto(`/project/${SID}`);
    await page.getByTestId("pj-create").click();
    await expect(page.getByTestId("pj-layout")).toHaveCount(0);
    await page.getByTestId("pj-prepare").click();
    await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(page.getByTestId("pj-layout")).toBeVisible();
    await expect(page.getByTestId("pj-lay-video")).toHaveCount(2);
    await expect(canvas).toBeVisible();
    // the scenes follow the speakers: Ala, Bob, Ala, Bob
    await expect.poll(() => sceneRows(page).count()).toBeGreaterThanOrEqual(3);
    await expect(sceneRows(page).first()).toHaveAttribute("data-layout", "solo");
    await expect(visibleVideos(page)).toHaveCount(1);
    await expect(page.getByTestId("pj-ed-timeline")).toHaveAttribute("data-scenes", /\d+/);
  });

  await test.step("the featured picture follows the speaker", async () => {
    const featured = page.getByTestId("pj-lay-scene-source");
    const first = await featured.nth(0).inputValue();
    const lastIndex = (await featured.count()) - 1;
    // consecutive scenes alternate between the two cameras
    expect(await featured.nth(1).inputValue()).not.toBe(first);
    expect(lastIndex).toBeGreaterThanOrEqual(2);
  });

  await test.step("side by side shows both pictures next to each other, inside the canvas", async () => {
    await page.getByTestId("pj-lay-layout-side-by-side").click();
    await expect(page.getByTestId("pj-lay-layout-side-by-side")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => allScenes(page, "side-by-side"), { timeout: 15_000 }).toBe(true);
    await expect(visibleVideos(page)).toHaveCount(2);
    const area = await box(canvas);
    const [left, right] = await Promise.all([box(visibleVideos(page).nth(0)), box(visibleVideos(page).nth(1))]);
    const [a, b] = left.x <= right.x ? [left, right] : [right, left];
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
    for (const tile of [a, b]) {
      expect(tile.x).toBeGreaterThanOrEqual(area.x - 1);
      expect(tile.x + tile.width).toBeLessThanOrEqual(area.x + area.width + 1);
      expect(tile.width).toBeLessThan(area.width * 0.6);
    }
    await saved(page);
  });

  await test.step("a vertical shape changes the canvas; a blurred background adds the backdrop picture", async () => {
    const wide = await box(canvas);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 1);
    await page.getByTestId("pj-lay-aspect-9:16").click();
    await expect(page.getByTestId("pj-lay-aspect-9:16")).toHaveAttribute("aria-pressed", "true");
    const tall = await box(canvas);
    expect(tall.width / tall.height).toBeCloseTo(9 / 16, 1);

    await expect(page.getByTestId("pj-lay-bg-video")).toHaveCount(0);
    await page.getByTestId("pj-lay-bg-kind").selectOption("blur");
    await expect(page.getByTestId("pj-lay-bg-video")).toHaveCount(1);
    const blurPx = await canvas.evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue("--lay-blur")));
    expect(blurPx).toBeGreaterThan(0);
    await saved(page);
  });

  await test.step("a manual change of one scene is marked, can be reset, and Ctrl+Z in the panel undoes the layout, not the cuts", async () => {
    const first = sceneRows(page).first();
    await expect(first).toHaveAttribute("data-state", "auto");
    await first.getByTestId("pj-lay-scene-layout").selectOption("grid");
    await expect(first).toHaveAttribute("data-state", "manual");
    await expect(first).toHaveAttribute("data-layout", "grid");
    await expect(page.getByTestId("pj-lay-summary")).toContainText("changed by hand: 1");
    await saved(page);

    await page.getByTestId("pj-lay-summary").click(); // focus moves into the panel
    await page.keyboard.press("Control+z");
    await expect(sceneRows(page).first()).toHaveAttribute("data-layout", "side-by-side");
    await expect(sceneRows(page).first()).toHaveAttribute("data-state", "auto");
    await expect(page.getByTestId("pj-ed-undo")).toBeDisabled(); // the cut list was not touched
    await page.keyboard.press("Control+Shift+z");
    await expect(sceneRows(page).first()).toHaveAttribute("data-layout", "grid");

    await first.getByTestId("pj-lay-scene-reset").click();
    await expect(sceneRows(page).first()).toHaveAttribute("data-state", "auto");
    await expect(sceneRows(page).first()).toHaveAttribute("data-layout", "side-by-side");
    await saved(page);
  });

  await test.step("shape, background and layout are still there after a reload", async () => {
    await page.reload();
    await expect(page.getByTestId("pj-layout")).toBeVisible();
    await expect(page.getByTestId("pj-lay-layout-side-by-side")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pj-lay-aspect-9:16")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pj-lay-bg-kind")).toHaveValue("blur");
    await expect.poll(() => allScenes(page, "side-by-side")).toBe(true);
  });

  await test.step("the test hook seeks the preview to a frame and every visible picture is on it", async () => {
    await page.goto(`/project/${SID}?hooks=1`);
    await expect(page.getByTestId("pj-lay-canvas")).toBeVisible();
    await expect.poll(() => page.evaluate(() => "__syncPreview" in window)).toBe(true);
    await page.evaluate(async () => {
      const hook: { seekMs(ms: number): Promise<void> } = Reflect.get(window, "__syncPreview");
      await hook.seekMs(15_016.7);
    });
    const times = await page.evaluate(() => {
      const audio = document.querySelector<HTMLAudioElement>('[data-testid="pj-player"]');
      return {
        audio: audio?.currentTime ?? -1,
        videos: [...document.querySelectorAll<HTMLVideoElement>('[data-testid="pj-lay-video"]:not([hidden])')].map((video) => video.currentTime),
      };
    });
    expect(times.audio).toBeCloseTo(15.0167, 1);
    expect(times.videos).toHaveLength(2);
    for (const time of times.videos) expect(Math.abs(time - times.audio)).toBeLessThan(0.06);
  });

  await test.step("a heavy export can be cancelled", async () => {
    await page.getByTestId("pj-ex-preset").selectOption("youtube-2160p60");
    await page.getByTestId("pj-ex-render").click();
    await expect(page.getByTestId("pj-ex-progress")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pj-ex-render")).toBeDisabled();
    await page.getByTestId("pj-ex-cancel").click();
    await expect(page.getByTestId("pj-ex-canceled")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("pj-ex-render")).toBeEnabled();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(0);
  });

  await test.step("a vertical video export has the shape of the preview and is as long as the program", async () => {
    await page.getByTestId("pj-ex-preset").selectOption("vertical-1080p30");
    await page.getByTestId("pj-ex-render").click();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(1, { timeout: 180_000 });
    const href = (await page.getByTestId("pj-ex-download").getAttribute("href")) ?? "";
    const response = await context.request.get(href);
    expect(response.status()).toBe(200);
    const file = path.join(scratch, "export.mp4");
    await writeFile(file, await response.body());
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", file]).toString().trim().split(/\s+/);
    const [size, duration] = [probe[0] ?? "", Number(probe[1])];
    expect(size).toBe("1080,1920");
    expect(Math.abs(duration - DURATION_SEC)).toBeLessThan(1);
  });

  await context.close();
});
