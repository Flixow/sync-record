import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { openFold, openStep, prepareEpisode } from "../support/project-page.js";

// The export section on a prepared session: an audio export of an edited program (the cuts are in the file), the finished
// export in the list with a working download, the preview media removed after it (the default retention) while the
// transcript and the cuts stay, the media prepared again, a loudness the server would refuse, and deleting the export.
const SID = "export-fixture-0001";
const PID = "p1-ala";
const DURATION_SEC = 40;
const BURSTS_MS = [3000, 12_000, 21_000, 33_000];
const BURST_LENGTH_SEC = 1.2;

let browser: Browser;
let scratch = "";

const dropFixtures = async (): Promise<void> => {
  await rm(path.join(E2E_DATA_DIR, "session", SID), { recursive: true, force: true });
  await rm(path.join(E2E_DATA_DIR, "post", SID), { recursive: true, force: true });
};

test.beforeAll(async () => {
  browser = process.env.E2E_CDP_URL ? await chromium.connectOverCDP(process.env.E2E_CDP_URL) : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined });
  await dropFixtures();
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-export-"));
  const speech = path.join(scratch, "bursts.wav");
  const windows = BURSTS_MS.map((start) => `between(t,${start / 1000},${start / 1000 + BURST_LENGTH_SEC})`).join("+");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${DURATION_SEC}`, "-af", `volume=0:enable='1-(${windows})'`, speech]);
  await makeSyntheticSession({
    sessionId: SID,
    storageDir: E2E_DATA_DIR,
    durationSec: DURATION_SEC,
    participants: [{ name: "Ala", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: speech }],
    eventsMs: BURSTS_MS,
  });
});

test.afterAll(async () => {
  await browser?.close();
  await dropFixtures();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const keptMs = async (page: Page): Promise<number> => Number(await page.getByTestId("pj-ed-kept").getAttribute("data-kept-ms"));
const probeSeconds = (file: string): number => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

test("export an edited program, download it, keep working after the media were removed, delete it", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL });
  // an action that cannot be done fails with its call log instead of waiting for the end of the test
  context.setDefaultTimeout(30_000);
  const token = issueToken(E2E_SECRET, { sid: SID, role: "participant", pid: PID, host: true, exp: Date.now() + 3_600_000 });
  await context.addInitScript(
    ([sid, credentials]) => {
      try {
        localStorage.setItem(`syncrecord.session.${sid}`, JSON.stringify(credentials));
        localStorage.setItem("syncrecord.lang", "en");
      } catch {
        // an opaque origin (about:blank) has no storage
      }
    },
    [SID, { participantId: PID, participantToken: token, name: "Ala", host: true }] as const,
  );
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  const cutWords = page.locator('[data-testid="pj-transcript"] .w.cut');

  await test.step("prepare, transcribe and cut two words", async () => {
    await page.goto(`/project/${SID}`);
    await page.getByTestId("pj-create").click();
    await prepareEpisode(page);
    const words = page.locator('[data-testid="pj-transcript"] .w');
    await words.nth(0).click();
    await words.nth(1).click({ modifiers: ["Shift"] });
    await page.getByTestId("pj-ed-delete").click();
    await expect(cutWords).toHaveCount(2);
    await expect(page.getByTestId("pj-ed-save")).toHaveAttribute("data-status", "saved");
  });
  const total = Number(await page.getByTestId("pj-ed-kept").getAttribute("data-total-ms"));
  const kept = await keptMs(page);
  expect(kept).toBeLessThan(total);

  await test.step("an audio-only project offers the audio formats, with the loudness settings of the server in the advanced section", async () => {
    await openStep(page, "episode");
    await openFold(page, "pj-ex-section");
    await expect(page.getByTestId("pj-ex-preset")).toHaveValue("audio-mp3");
    await expect(page.getByTestId("pj-ex-preset").locator('option[data-kind="video"]').first()).toBeDisabled();
    await expect(page.getByTestId("pj-ex-source")).toBeHidden();
    await expect(page.getByTestId("pj-ex-empty")).toBeVisible();
    await expect(page.getByTestId("pj-ex-note")).toContainText("removed");
    await page.getByTestId("pj-ex-advanced").locator("summary").click();
    await expect(page.getByTestId("pj-ex-lufs")).toHaveValue("-16");
    await expect(page.getByTestId("pj-ex-peak")).toHaveValue("-1");
  });

  await test.step("a loudness the server would refuse is stopped in the form", async () => {
    await page.getByTestId("pj-ex-lufs").fill("0");
    await page.getByTestId("pj-ex-render").click();
    await expect(page.getByTestId("pj-ex-invalid")).toBeVisible();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(0);
    await page.getByTestId("pj-ex-lufs").fill("-16");
  });

  await test.step("render an MP3: progress, then a row with a working download", async () => {
    // the button of the step starts the render with the values of the form
    await expect(page.getByTestId("pj-ep-export")).toHaveText("Export audio");
    await page.getByTestId("pj-ep-export").click();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(1, { timeout: 120_000 });
    const row = page.getByTestId("pj-ex-row");
    await expect(row).toHaveAttribute("data-preset", "audio-mp3");
    await expect(row).toContainText("LUFS");
    await expect(page.getByTestId("pj-ex-progress")).toHaveCount(0);
    await expect(page.getByTestId("pj-ex-render")).toBeEnabled();
    await expect(page.getByTestId("pj-step-episode")).toHaveAttribute("data-mark", "done");

    const href = (await page.getByTestId("pj-ex-download").getAttribute("href")) ?? "";
    expect(await page.getByTestId("pj-ex-download").getAttribute("download")).toMatch(/\.mp3$/);
    const response = await context.request.get(href);
    expect(response.status()).toBe(200);
    const bytes = await response.body();
    expect(bytes.length).toBeGreaterThan(10_000);
    const file = path.join(scratch, "export.mp3");
    await writeFile(file, bytes);
    // the file is the edited program: as long as the kept part, not the 40 s recording
    expect(Math.abs(probeSeconds(file) - kept / 1000)).toBeLessThan(0.4);
  });

  await test.step("the preview media are removed after the export; the transcript, the cuts and the list stay", async () => {
    await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "none", { timeout: 30_000 });
    await expect(page.getByTestId("pj-ed-nomedia")).toBeVisible();
    await expect(page.getByTestId("pj-transcript")).toContainText("Hello,");
    await expect(cutWords).toHaveCount(2);
    expect(await keptMs(page)).toBe(kept);
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(1);
    // cutting still works without playback
    await page.getByTestId("pj-ed-undo").click();
    await expect(cutWords).toHaveCount(0);
    await page.getByTestId("pj-ed-redo").click();
    await expect(cutWords).toHaveCount(2);
    await expect(page.getByTestId("pj-ed-save")).toHaveAttribute("data-status", "saved");

    await page.reload();
    await expect(page.getByTestId("pj-ed-nomedia")).toBeVisible();
    await expect(cutWords).toHaveCount(2);
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(1);
  });

  await test.step("preparing the media again brings the player back", async () => {
    await openStep(page, "prepare");
    await page.getByTestId("pj-prepare").click();
    await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(page.getByTestId("pj-ed-nomedia")).toBeHidden();
    await expect(page.getByTestId("pj-player")).toHaveAttribute("src", /proxies\/mix/);
    await expect(cutWords).toHaveCount(2);
  });

  await test.step("delete the export", async () => {
    await openStep(page, "episode");
    const href = (await page.getByTestId("pj-ex-download").getAttribute("href")) ?? "";
    await page.getByTestId("pj-ex-delete").click();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(0);
    await expect(page.getByTestId("pj-ex-empty")).toBeVisible();
    expect((await context.request.get(href)).status()).toBe(404);
  });

  await context.close();
});
