import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { openStep, prepareEpisode } from "../support/project-page.js";

// Ala (camera and microphone) and Bob (microphone only) take turns for 30 s: the episode timeline shows both, the program lanes
// follow who speaks, a click, the scrubber and the transcript move the playhead, and a stretch can be given to another source.
const SID = "timeline-fixture-0001";
const HOST = "p1-ala";
const DURATION_SEC = 30;
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
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-timeline-"));
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
      { name: "Bob Builder", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: bob },
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

/** Clicks the lane at the position of `ms` on the project timeline. */
async function clickAt(page: Page, lane: Locator, ms: number): Promise<void> {
  const content = page.getByTestId("pj-tl-content");
  await lane.scrollIntoViewIfNeeded();
  const pps = Number(await content.getAttribute("data-pps"));
  const box = await content.boundingBox();
  const laneBox = await lane.boundingBox();
  if (!box || !laneBox) throw new Error("the timeline is not on screen");
  await page.mouse.click(box.x + (ms / 1000) * pps, laneBox.y + laneBox.height / 2);
}

const playheadMs = async (page: Page): Promise<number> => Number(await page.getByTestId("pj-tl-playhead").getAttribute("data-ms"));

test("the episode timeline shows every participant, moves the playhead and edits what is on the canvas", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL, viewport: { width: 1400, height: 1100 } });
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
  const scenes = page.getByTestId("pj-tl-scene");
  const picture = page.getByTestId("pj-tl-picture");
  const manualScenes = page.locator('[data-testid="pj-tl-scene"][data-state="manual"]');

  await page.goto(`/project/${SID}`);
  await page.getByTestId("pj-create").click();
  await prepareEpisode(page);
  await openStep(page, "episode");
  await expect(page.getByTestId("pj-tl")).toBeVisible();

  await test.step("lanes per participant and the program lanes follow who speaks", async () => {
    await expect(page.locator('[data-lane="audio"]')).toHaveCount(2);
    await expect(page.locator('[data-lane="camera"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="screen"]')).toHaveCount(0);
    await expect(page.getByTestId("pj-tl-sound")).toHaveAttribute("data-speakers", "Ala|Bob Builder");
    await expect.poll(() => scenes.count()).toBeGreaterThanOrEqual(3);
    const mains = await scenes.evaluateAll((blocks) => blocks.map((block) => (block as HTMLElement).dataset.main ?? ""));
    expect(mains[0]).not.toMatch(/^card-/);
    expect(mains[1]).toMatch(/^card-/);
    expect(mains[2]).toBe(mains[0]);
  });

  let cardId = "";
  await test.step("a click, the scrubber, the keys and the transcript move the playhead", async () => {
    await clickAt(page, picture, 11_000);
    await expect.poll(() => playheadMs(page)).toBeGreaterThan(10_000);
    expect(await playheadMs(page)).toBeLessThan(12_000);
    await page.getByTestId("pj-tl-scrub").fill("20000");
    await expect.poll(() => playheadMs(page)).toBe(20_000);
    await page.getByTestId("pj-tl-lanes").focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => playheadMs(page)).toBe(19_000);
    await page.locator('[data-testid="pj-transcript"] .turn-head').first().click();
    await expect.poll(() => playheadMs(page)).toBeLessThan(3000);
    cardId = (await scenes.nth(1).getAttribute("data-main")) ?? "";
  });

  await test.step("a selected stretch can show another source, and goes back to automatic", async () => {
    await clickAt(page, picture, 11_000);
    await expect(page.getByTestId("pj-tl-editor")).toBeVisible();
    await expect(page.getByTestId("pj-tl-sel-source")).toHaveValue(cardId);
    await expect(page.getByTestId("pj-tl-sel-auto")).toBeDisabled();
    const camera = (await scenes.nth(0).getAttribute("data-main")) ?? "";
    await page.getByTestId("pj-tl-sel-source").selectOption(camera);
    await expect(manualScenes.first()).toHaveAttribute("data-main", camera);
    await expect(page.getByTestId("pj-tl-save")).toHaveAttribute("data-status", "saved");
    await expect(page.getByTestId("pj-lay-save")).toHaveAttribute("data-status", "saved");

    await page.reload();
    await openStep(page, "episode");
    await expect(manualScenes.first()).toHaveAttribute("data-main", camera);

    await clickAt(page, picture, 11_000);
    await page.getByTestId("pj-tl-sel-auto").click();
    await expect(manualScenes).toHaveCount(0);
    await page.getByTestId("pj-tl-undo").click();
    await expect(manualScenes.first()).toHaveAttribute("data-main", camera);
    await page.getByTestId("pj-tl-all-auto").click();
    await expect(manualScenes).toHaveCount(0);
    await expect(scenes.nth(1)).toHaveAttribute("data-main", cardId);
  });

  await test.step("a dragged stretch is selected, and the view zooms", async () => {
    const content = page.getByTestId("pj-tl-content");
    const before = Number(await content.getAttribute("data-pps"));
    await page.getByTestId("pj-tl-zoom-in").click();
    expect(Number(await content.getAttribute("data-pps"))).toBeGreaterThan(before);
    await page.getByTestId("pj-tl-zoom-fit").click();
    await expect.poll(async () => Number(await content.getAttribute("data-pps"))).toBeCloseTo(before, 2);
    const pps = before;
    await page.getByTestId("pj-tl-sound").scrollIntoViewIfNeeded();
    const box = await content.boundingBox();
    const laneBox = await page.getByTestId("pj-tl-sound").boundingBox();
    if (!box || !laneBox) throw new Error("the timeline is not on screen");
    await page.mouse.move(box.x + 3 * pps, laneBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 7 * pps, laneBox.y + 8, { steps: 6 });
    await page.mouse.up();
    const selection = page.getByTestId("pj-tl-selection");
    await expect(selection).toBeVisible();
    expect(Number(await selection.getAttribute("data-start"))).toBeGreaterThan(2000);
    expect(Number(await selection.getAttribute("data-end"))).toBeLessThan(8000);
    await page.getByTestId("pj-tl").screenshot({ path: process.env.TIMELINE_SHOT ?? path.join(scratch, "timeline.png") });
  });

  await context.close();
});
