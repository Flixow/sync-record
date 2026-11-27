import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_DATA_DIR } from "../../playwright.config.js";

// The conversation next to a take: two browsers with fake devices join a LiveKit room, see each other, mute, switch the camera
// off, leave, and the recorded tracks of the muted participant are still complete. Needs LIVEKIT_E2E_BIN (see playwright.config.ts).
test.skip(!process.env.LIVEKIT_E2E_BIN, "set LIVEKIT_E2E_BIN to a livekit-server executable to run the conversation spec");

const FAKE_MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--auto-select-desktop-capture-source=Entire screen",
  "--autoplay-policy=no-user-gesture-required",
];

// Software-rendered Chromium with fake devices, four encoders and a LiveKit room at once is slow: every UI check gets a long timeout.
const check = expect.configure({ timeout: 30_000 });

let browser: Browser;

test.beforeAll(async () => {
  browser = process.env.E2E_CDP_URL
    ? await chromium.connectOverCDP(process.env.E2E_CDP_URL)
    : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined, args: FAKE_MEDIA_ARGS });
});

test.afterAll(async () => {
  await browser?.close();
  if (!process.env.E2E_KEEP_DATA) await rm(E2E_DATA_DIR, { recursive: true, force: true });
});

async function setUp(page: Page, options: { screen?: boolean } = {}): Promise<void> {
  const allow = page.getByTestId("allow-media");
  const mic = page.getByTestId("mic-select");
  await check(allow.or(mic)).toBeVisible();
  await allow.click({ timeout: 2000 }).catch(() => undefined);
  await check(mic).toBeVisible();
  await page.getByTestId("hp-skip").click(); // headphones skipped: the conversation is joined muted
  if (options.screen) await page.getByTestId("want-screen").check();
  await page.getByTestId("consent").check();
  await check(page.getByTestId("start-recording")).toBeEnabled();
}

const newContext = (): Promise<BrowserContext> => browser.newContext({ baseURL: test.info().project.use.baseURL ?? "", viewport: { width: 1280, height: 1100 } });
const cameraTiles = (page: Page) => page.locator('[data-testid^="call-tile-camera-"]');

/**
 * Brightest pixel of any frame in the last four seconds of a recorded camera track. The fake camera is a dark picture with a
 * bright moving mark, so a live picture reaches far above 100 and a black one (what a disabled track delivers) stays at 16.
 */
function brightestRecentPixel(file: string): number {
  const out = spawnSync("ffmpeg", ["-v", "quiet", "-sseof", "-4", "-i", file, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YHIGH:file=-", "-f", "null", "-"]);
  const values = [...out.stdout.toString().matchAll(/YHIGH=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(0, ...values);
}

/** Loudest sample of a recorded audio track, in dB. */
function maxVolumeDb(file: string): number {
  const out = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const match = /max_volume: (-?[\d.]+) dB/.exec(out.stderr.toString());
  if (!match) throw new Error(`no volume in ${file}`);
  return Number(match[1]);
}

test("two participants talk in the conversation next to the recording, which is unaffected by mute, camera off and leave", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const hostContext = await newContext();
  const guestContext = await newContext();
  await hostContext.addInitScript(() => localStorage.setItem("syncrecord.lang", "en"));
  await guestContext.addInitScript(() => localStorage.setItem("syncrecord.lang", "pl"));
  const accept = (page: Page) => page.on("dialog", (dialog) => void dialog.accept());

  const host = await hostContext.newPage();
  accept(host);
  await host.goto("/");
  await host.getByTestId("host-name").fill("Hanna");
  await host.getByTestId("create-session").click();
  await check(host.getByTestId("invite-link")).toHaveValue(/\/join\/[0-9a-f]{20}#/);
  const invite = await host.getByTestId("invite-link").inputValue();
  const sessionId = /\/join\/([0-9a-f]+)#/.exec(invite)?.[1] ?? "";

  const guest = await guestContext.newPage();
  accept(guest);
  await guest.goto(invite.replace(/^https?:\/\/[^/]+/, baseURL));
  await guest.getByTestId("join-name").fill("Bartek");
  await guest.getByTestId("join-submit").click();
  await check(guest.getByTestId("session-id")).toBeVisible();

  // ---- the card is there and cannot be joined before the microphone is allowed ----
  await check(host.getByTestId("call-join")).toBeVisible();
  await setUp(host);
  await setUp(guest, { screen: true });
  await check(host.getByTestId("call-join")).toBeEnabled();
  await check(guest.getByTestId("call-join")).toContainText("Dołącz do rozmowy"); // Polish interface

  // ---- both join: two tiles each, the other's camera is decoded video, sound arrives ----
  await host.getByTestId("call-join").click();
  await check(host.getByTestId("call-leave")).toBeVisible();
  await check(host.getByTestId("call-status")).toContainText(/Nobody else/);
  await check(host.getByTestId("call-joined-muted")).toBeVisible(); // headphones were skipped
  await guest.getByTestId("call-join").click();
  await check(guest.getByTestId("call-leave")).toBeVisible();
  for (const page of [host, guest]) {
    await check(cameraTiles(page)).toHaveCount(2);
    await check(cameraTiles(page).first()).toHaveAttribute("data-video", "true");
  }
  const remoteVideo = host.locator('[data-testid="call-tile-camera-p2-bartek"] video');
  await expect.poll(() => remoteVideo.evaluate((video) => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await check(host.locator("audio")).not.toHaveCount(0); // the guest's microphone is subscribed
  await check(host.getByTestId("call-tile-camera-p1-hanna")).toContainText("host");

  // ---- mute state shows on the other side ----
  await check(host.getByTestId("call-muted-p2-bartek")).toBeVisible(); // the guest joined muted
  await guest.getByTestId("call-mute").click();
  await check(guest.getByTestId("call-mute")).toContainText("Wycisz");
  await check(host.getByTestId("call-muted-p2-bartek")).toHaveCount(0);
  await host.locator("section.card", { has: host.getByTestId("call-grid") }).screenshot({ path: test.info().outputPath("call-grid.png") });

  // ---- a take starts: the conversation goes on, the guest's recorded screen shows up as a tile for the host ----
  await guest.getByTestId("start-recording").click();
  await host.getByTestId("start-recording").click();
  await check(host.getByTestId("rec-badge")).toBeVisible({ timeout: 60_000 });
  await check(guest.getByTestId("rec-badge")).toBeVisible({ timeout: 60_000 });
  await check(host.getByTestId("call-tile-screen-p2-bartek")).toBeVisible({ timeout: 30_000 });
  await check(guest.getByTestId("call-tile-screen-p2-bartek")).toHaveCount(0); // you do not see your own screen back
  await check(cameraTiles(host)).toHaveCount(2);
  await host.waitForTimeout(3000);
  await host.screenshot({ path: test.info().outputPath("call-during-take.png"), fullPage: true });

  // ---- the host mutes, switches the camera off and leaves the conversation: nothing happens to the recording ----
  await host.getByTestId("call-mute").click(); // unmute ...
  await check(host.getByTestId("call-muted-p1-hanna")).toHaveCount(0);
  await host.getByTestId("call-mute").click(); // ... and mute again: the whole take is recorded while muted in the call or not
  await check(guest.getByTestId("call-muted-p1-hanna")).toBeVisible();
  await host.getByTestId("call-camera").click();
  await check(host.getByTestId("call-camera")).toContainText("Camera on");
  await host.waitForTimeout(3000);
  await host.getByTestId("call-leave").click();
  await check(host.getByTestId("call-join")).toBeVisible();
  await check(host.getByTestId("rec-badge")).toBeVisible();
  await check(guest.getByTestId("call-tile-camera-p1-hanna")).toHaveCount(0);
  await check(guest.getByTestId("call-status")).toContainText(/Nikogo/);
  await host.waitForTimeout(2000);

  // ---- the host stops, ends the session: the guest's conversation ends with it ----
  await host.getByTestId("stop-recording").click();
  await check(host.getByTestId("finished-done")).toBeVisible({ timeout: 60_000 });
  await host.getByTestId("end-session").click();
  await check(guest.getByTestId("session-ended")).toBeVisible({ timeout: 30_000 });
  await check(guest.getByTestId("call-join")).toBeHidden();
  await check(guest.getByTestId("finished-done")).toBeVisible({ timeout: 60_000 });
  await check(host.locator('[data-testid="results"] [data-status="ok"]').first()).toBeVisible({ timeout: 90_000 });
  await check(host.locator('[data-testid="results"] [data-status="pending"], [data-testid="results"] [data-status="receiving"]')).toHaveCount(0, { timeout: 90_000 });

  // ---- the host's recorded tracks are complete and not silent or black although the call tracks were muted / off ----
  const manifest = JSON.parse(await readFile(path.join(E2E_DATA_DIR, "session", sessionId, "manifest.json"), "utf8")) as {
    participants: { participantId: string; displayName: string; tracks: { kind: string; file: string | null; status: string; endReason: string | null }[] }[];
  };
  const hostEntry = manifest.participants.find((participant) => participant.displayName === "Hanna");
  const guestEntry = manifest.participants.find((participant) => participant.displayName === "Bartek");
  expect(hostEntry?.tracks.map((track) => track.kind).sort()).toEqual(["audio", "camera"]);
  expect(guestEntry?.tracks.map((track) => track.kind).sort()).toEqual(["audio", "camera", "screen"]);
  for (const entry of [hostEntry, guestEntry]) {
    for (const track of entry?.tracks ?? []) {
      expect(track.status, `${entry?.displayName} ${track.kind}`).toBe("ok");
      const file = path.join(E2E_DATA_DIR, "session", sessionId, entry?.participantId ?? "", track.file ?? "missing");
      const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
      expect(duration, file).toBeGreaterThan(8); // the take ran about ten seconds from the first click to the stop
      if (track.kind === "audio") expect(maxVolumeDb(file), `${file} is not silent`).toBeGreaterThan(-50);
      if (track.kind === "camera") expect(brightestRecentPixel(file), `${file} is not black`).toBeGreaterThan(100);
    }
  }
  expect(hostEntry?.tracks.find((track) => track.kind === "audio")?.endReason).toBe("stopped");
});
