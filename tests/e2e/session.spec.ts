import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_DATA_DIR } from "../../playwright.config.js";

// Chromium flags that replace the camera, microphone and the screen picker with synthetic sources.
export const FAKE_MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--auto-select-desktop-capture-source=Entire screen",
  "--autoplay-policy=no-user-gesture-required",
];

interface ManifestTrack {
  kind: string;
  segment: number;
  file: string | null;
  status: string;
  endReason: string | null;
  durationSec: number | null;
  startClientMs: number;
  startServerMsEstimated: number;
  bytesReceived: number;
  clock: { offsetMs: number; uncertaintyMs: number | null; samples: unknown[] };
  markers: { kind: string }[];
}
interface Manifest {
  schemaVersion: number;
  sessionId: string;
  participants: { participantId: string; displayName: string; host: boolean; consent: { version: string } | null; tracks: ManifestTrack[] }[];
}

let browser: Browser;

test.beforeAll(async () => {
  // E2E_CDP_URL attaches to an already running Chromium (it must have been started with FAKE_MEDIA_ARGS).
  browser = process.env.E2E_CDP_URL
    ? await chromium.connectOverCDP(process.env.E2E_CDP_URL)
    : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined, args: FAKE_MEDIA_ARGS });
});

test.afterAll(async () => {
  await browser?.close();
  await rm(E2E_DATA_DIR, { recursive: true, force: true });
});

const ffprobe = (file: string): { duration: number; codecs: string[] } => {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "json", file]).toString();
  const parsed = JSON.parse(out) as { format: { duration: string }; streams: { codec_name: string }[] };
  return { duration: Number(parsed.format.duration), codecs: parsed.streams.map((s) => s.codec_name) };
};

/** True when a Cues element sits before the first Cluster, which is what makes a WebM seekable without scanning. */
async function cuesBeforeClusters(file: string): Promise<boolean> {
  const head = (await readFile(file)).subarray(0, 512 * 1024);
  const cues = head.indexOf(Buffer.from("1c53bb6b", "hex"));
  const cluster = head.indexOf(Buffer.from("1f43b675", "hex"));
  return cues !== -1 && cluster !== -1 && cues < cluster;
}

async function setUp(page: Page, options: { screen?: boolean } = {}): Promise<void> {
  // Either the permission button shows up, or the browser already granted access and the devices are listed.
  const allow = page.getByTestId("allow-media");
  const mic = page.getByTestId("mic-select");
  await expect(allow.or(mic)).toBeVisible();
  // The button disappears by itself when the browser had already granted access.
  await allow.click({ timeout: 2000 }).catch(() => undefined);
  await expect(mic).toBeVisible();
  await expect(page.getByTestId("start-recording")).toBeDisabled();
  await expect(page.getByTestId("start-missing")).toContainText(/consent/i);
  // Headphones: one click skips the step.
  await page.getByTestId("hp-skip").click();
  await expect(page.getByTestId("hp-skipped")).toBeVisible();
  if (options.screen) await page.getByTestId("want-screen").check();
  await page.getByTestId("consent").check();
  await expect(page.getByTestId("start-recording")).toBeEnabled();
}

async function newParticipantContext(): Promise<BrowserContext> {
  return browser.newContext({ baseURL: test.info().project.use.baseURL ?? "" });
}

test("two participants record, one tab is killed and resumes, the collector outputs remuxed tracks and a manifest", async () => {
  const baseURL = test.info().project.use.baseURL ?? "";
  const hostContext = await newParticipantContext();
  const guestContext = await newParticipantContext();
  const dialogs = (page: Page) => page.on("dialog", (dialog) => void dialog.accept());

  // ---- host creates the session and shares the invite link ----
  let host = await hostContext.newPage();
  dialogs(host);
  await host.goto("/");
  await host.getByTestId("host-name").fill("Hanna");
  await host.getByTestId("create-session").click();
  await expect(host.getByTestId("session-id")).toBeVisible();
  await expect(host.getByTestId("invite-link")).toHaveValue(/\/join\/[0-9a-f]{20}#/);
  const invite = await host.getByTestId("invite-link").inputValue();
  const sessionId = /\/join\/([0-9a-f]+)#/.exec(invite)?.[1] ?? "";

  // ---- guest joins through the invite link ----
  const guest = await guestContext.newPage();
  dialogs(guest);
  await guest.goto(invite.replace(/^https?:\/\/[^/]+/, baseURL));
  await guest.getByTestId("join-name").fill("Bartek");
  await guest.getByTestId("join-submit").click();
  await expect(guest.getByTestId("session-id")).toBeVisible();
  await expect(guest).not.toHaveURL(/#/); // the invite token is removed from the address bar

  // ---- both set up; nothing records before the click ----
  await setUp(host);
  await setUp(guest, { screen: process.env.E2E_SCREEN !== "0" });
  await expect(host.getByTestId("roster")).toContainText("Bartek");
  await expect(host.getByTestId("roster")).not.toContainText("recording");

  await guest.getByTestId("start-recording").click();
  await host.getByTestId("start-recording").click();
  await expect(host.getByTestId("rec-badge")).toBeVisible();
  await expect(guest.getByTestId("rec-badge")).toBeVisible();
  await expect(host.getByTestId("clap-prompt")).toBeVisible();

  // everybody sees who is recording
  await expect(guest.getByTestId("roster")).toContainText("Hanna");
  await expect(guest.locator('[data-state="recording"]')).toHaveCount(2);

  // upload is running in the background while recording
  await expect(host.getByTestId("track-audio")).toHaveAttribute("data-upload", /uploading|waiting/);
  await host.waitForTimeout(6000);

  // ---- the guest loses the network for a while: uploads retry, then resume where they stopped ----
  await guestContext.setOffline(true);
  await expect(guest.getByTestId("track-audio")).toHaveAttribute("data-upload", "retrying", { timeout: 30_000 });
  await guestContext.setOffline(false);
  await expect(guest.getByTestId("track-audio")).toHaveAttribute("data-upload", /uploading|waiting/, { timeout: 60_000 });

  // ---- the host renderer crashes mid-recording (not a clean close) ----
  const crashed = new Promise<void>((resolve) => host.once("crash", () => resolve()));
  await host.goto("chrome://crash").catch(() => undefined); // kills the renderer process: no unload handlers, no final flush
  await Promise.race([crashed, host.waitForTimeout(5000)]);
  await host.close().catch(() => undefined);
  await guest.waitForTimeout(2000);
  await expect(guest.locator('[data-state="recording"]')).toHaveCount(2); // the roster still shows it, flagged as lost
  await expect(guest.getByTestId("roster")).toContainText(/connection lost/i);

  // ---- rejoin: the unfinished recordings are found in OPFS and upload resumes ----
  host = await hostContext.newPage();
  dialogs(host);
  await host.goto(`/join/${sessionId}`);
  // (the "recovered" banner may already be gone: it hides itself once the uploads are complete)
  await expect(host.getByTestId("local-audio")).toHaveAttribute("data-complete", "true", { timeout: 60_000 });
  await expect(host.getByTestId("local-camera")).toHaveAttribute("data-complete", "true", { timeout: 60_000 });
  // the local copy is still there after the upload
  await expect(host.getByTestId("delete-audio")).toBeVisible();

  // ---- the host records a second take after the crash ----
  await setUp(host);
  await host.getByTestId("start-recording").click();
  await expect(host.getByTestId("rec-badge")).toBeVisible();
  await host.waitForTimeout(3000);

  // ---- the host stops and ends the session while the guest is still recording ----
  await host.getByTestId("stop-recording").click();
  await expect(host.getByTestId("finished-done")).toBeVisible({ timeout: 60_000 });
  await host.getByTestId("end-session").click();
  await expect(guest.getByTestId("session-ended")).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByTestId("finished-done")).toBeVisible({ timeout: 60_000 });
  await expect(host.getByTestId("results")).toBeVisible();
  await expect(host.locator('[data-testid="results"] [data-status="ok"]').first()).toBeVisible({ timeout: 90_000 });
  await expect(host.locator('[data-testid="results"] [data-status="pending"], [data-testid="results"] [data-status="receiving"], [data-testid="results"] [data-status="failed"]')).toHaveCount(0, { timeout: 90_000 });

  // ---- what the collector wrote ----
  const sessionDir = path.join(E2E_DATA_DIR, "session", sessionId);
  const manifest = JSON.parse(await readFile(path.join(sessionDir, "manifest.json"), "utf8")) as Manifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.sessionId).toBe(sessionId);
  expect(manifest.participants.map((p) => p.displayName)).toEqual(["Hanna", "Bartek"]);
  expect(manifest.participants.every((p) => p.consent?.version)).toBe(true);

  const hostEntry = manifest.participants[0];
  const guestEntry = manifest.participants[1];
  if (!hostEntry || !guestEntry) throw new Error("participants missing");

  // host: first take (killed) and second take are separate segments of each kind
  const hostAudio = hostEntry.tracks.filter((track) => track.kind === "audio");
  expect(hostAudio.map((track) => track.segment)).toEqual([1, 2]);
  expect(hostAudio[0]?.endReason).toBe("crash");
  expect(hostAudio[1]?.endReason).toBe("stopped");
  // the guest was still recording when the host ended the session
  expect(guestEntry.tracks.find((track) => track.kind === "audio")?.endReason).toBe("sessionEnded");
  expect(hostEntry.tracks.some((track) => track.kind === "camera" && track.segment === 2)).toBe(true);

  for (const participant of manifest.participants) {
    for (const track of participant.tracks) {
      expect(track.status, `${participant.displayName} ${track.kind}`).toBe("ok");
      expect(track.file).toMatch(/^(audio|camera|screen)(-\d+)?\.webm$/);
      expect(track.bytesReceived).toBeGreaterThan(0);
      expect(track.clock.samples.length).toBeGreaterThan(0);
      expect(track.markers.some((marker) => marker.kind === "start-beep")).toBe(true);
      // Both browsers run on this machine as the collector does, so the handshake must find almost no offset.
      expect(Math.abs(track.clock.offsetMs)).toBeLessThan(1000);
      expect(track.clock.uncertaintyMs ?? Infinity).toBeLessThan(250);
      expect(Math.abs(track.startServerMsEstimated - Date.now())).toBeLessThan(10 * 60_000);

      const file = path.join(sessionDir, participant.participantId, track.file ?? "missing");
      const probe = ffprobe(file);
      expect(probe.duration, file).toBeGreaterThan(1.5);
      expect(probe.codecs).toContain(track.kind === "audio" ? "opus" : "vp9");
      expect(await cuesBeforeClusters(file), `${file} has Cues before the first Cluster`).toBe(true);
      // seeking into the middle decodes: a file without an index would fail or restart
      execFileSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0.5, probe.duration / 2)), "-i", file, "-t", "0.5", "-f", "null", "-"]);
    }
  }
  // The guest also shared a (fake) screen: it is a third, separate track.
  if (process.env.E2E_SCREEN !== "0") expect(guestEntry.tracks.map((track) => track.kind).sort()).toEqual(["audio", "camera", "screen"]);

  // Both participants started within a plausible window of each other on the server clock.
  const starts = [hostAudio[0], guestEntry.tracks.find((track) => track.kind === "audio")].map((track) => track?.startServerMsEstimated ?? 0);
  expect(Math.abs((starts[0] ?? 0) - (starts[1] ?? 0))).toBeLessThan(15_000);

  await mkdir(path.join(sessionDir), { recursive: true });
  await hostContext.close();
  await guestContext.close();
});
