import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import { makeSyntheticSession } from "../support/synthetic.js";

// A take in which the host shared the screen twice (two screen tracks) and had the camera in between: the Layout section
// features each share in its own stretch, and "Do not feature the screen" removes them from the whole project.
const SID = "screens-fixture-0001";
const HOST = "p1-ala";

let browser: Browser;

const dropFixtures = async (): Promise<void> => {
  await rm(path.join(E2E_DATA_DIR, "session", SID), { recursive: true, force: true });
  await rm(path.join(E2E_DATA_DIR, "post", SID), { recursive: true, force: true });
};

test.beforeAll(async () => {
  browser = process.env.E2E_CDP_URL ? await chromium.connectOverCDP(process.env.E2E_CDP_URL) : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined });
  await dropFixtures();
  await makeSyntheticSession({
    sessionId: SID,
    storageDir: E2E_DATA_DIR,
    durationSec: 30,
    participants: [{ name: "Ala", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, screens: [{ startMs: 4000, durationSec: 8 }, { startMs: 18_000, durationSec: 8 }] }],
    eventsMs: [4000, 10_000, 16_000, 22_000],
    cameraSize: "640x360",
  });
});

test.afterAll(async () => {
  await browser?.close();
  await dropFixtures();
});

const sceneRows = (page: Page) => page.locator('[data-testid="pj-lay-scene"]');
const layouts = (page: Page): Promise<string[]> => sceneRows(page).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.layout ?? ""));
const saved = (page: Page) => expect(page.getByTestId("pj-lay-save")).toHaveAttribute("data-status", "saved");

test("screen shares are featured where they were recorded, and one switch takes the screen out of the project", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 1100 } });
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

  await test.step("the screen is featured during each share only", async () => {
    await page.goto(`/project/${SID}`);
    await page.getByTestId("pj-create").click();
    await page.getByTestId("pj-prepare").click();
    await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(page.getByTestId("pj-layout")).toBeVisible();
    await expect(page.getByTestId("pj-lay-video")).toHaveCount(3); // the camera and the two screens
    await expect.poll(() => layouts(page)).toEqual(["solo", "screen-camera", "solo", "screen-camera", "solo"]);
    const featured = await page.getByTestId("pj-lay-scene-source").evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""));
    expect(featured[1]).toContain("Screen");
    expect(featured[3]).toContain("Screen #2");
    expect(featured[1]).not.toBe(featured[3]);
  });

  await test.step("the switch removes the screen everywhere and survives a reload", async () => {
    await expect(page.getByTestId("pj-lay-screen-off")).not.toBeChecked();
    await page.getByTestId("pj-lay-screen-off").check();
    await expect.poll(() => layouts(page), { timeout: 15_000 }).toEqual(["solo"]);
    await saved(page);
    await page.reload();
    await expect(page.getByTestId("pj-lay-screen-off")).toBeChecked();
    await expect.poll(() => layouts(page)).toEqual(["solo"]);
    await page.getByTestId("pj-layout").screenshot({ path: test.info().outputPath("layout-screen-off.png") });
  });

  await test.step("switching it off again brings the shares back", async () => {
    await page.getByTestId("pj-lay-screen-off").uncheck();
    await expect.poll(() => layouts(page), { timeout: 15_000 }).toEqual(["solo", "screen-camera", "solo", "screen-camera", "solo"]);
    await saved(page);
  });
});
