import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import { makeSyntheticSession } from "../support/synthetic.js";

// A participant who recorded only a microphone (Bob) next to one with a camera (Ala): the scenes follow Bob's voice too,
// the source list of a scene offers him, and the preview draws his name card.
const SID = "mic-only-fixture-0001";
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
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-mic-only-"));
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

test("a microphone-only participant is a scene source: automatic scenes, the source list and the preview card", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 1000 } });
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
  const sceneRows = page.locator('[data-testid="pj-lay-scene"]');
  const sources = page.getByTestId("pj-lay-scene-source");

  await page.goto(`/project/${SID}`);
  await page.getByTestId("pj-create").click();
  await page.getByTestId("pj-prepare").click();
  await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
  await expect(page.getByTestId("pj-layout")).toBeVisible();

  await test.step("the scenes switch to the card while Bob speaks", async () => {
    await expect.poll(() => sceneRows.count()).toBeGreaterThanOrEqual(3);
    const featured = await sources.evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""));
    expect(featured.slice(0, 3)).toEqual(["Ala", "Bob Builder · Microphone", "Ala"]);
    // no warning about missing proxies: a card needs none
    await expect(page.getByTestId("pj-lay-noproxies")).toHaveCount(0);
  });

  await test.step("the source list offers him, and the preview draws his name card", async () => {
    const options = await sources.nth(0).locator("option").allTextContents();
    expect(options).toEqual(["Ala", "Bob Builder · Microphone"]);
    await page.getByTestId("pj-lay-layout-side-by-side").click();
    await expect(page.locator('[data-testid="pj-lay-card"]:not([hidden])')).toHaveCount(1);
    await expect(page.locator('[data-testid="pj-lay-video"]:not([hidden])')).toHaveCount(1);
    await expect(page.locator('[data-testid="pj-lay-card"]:not([hidden]) .lay-card-avatar')).toHaveText("BB");
    await expect(page.locator('[data-testid="pj-lay-card"]:not([hidden]) .lay-card-name')).toHaveText("Bob Builder");
    await expect(page.getByTestId("pj-lay-save")).toHaveAttribute("data-status", "saved");
    await page.getByTestId("pj-lay-canvas").screenshot({ path: process.env.MIC_ONLY_SHOT ?? path.join(scratch, "preview.png") });
  });

  await context.close();
});
