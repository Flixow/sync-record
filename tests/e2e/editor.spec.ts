import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import type { Range } from "../../src/shared/edl.js";
import type { Silence } from "../../src/shared/silence.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { openFold, prepareEpisode } from "../support/project-page.js";

// The editor on a prepared session: a synthetic recording (tone bursts long enough to count as speech, silence between
// them) is written to the collector's storage, the host's credentials are put in the browser, and the project page is
// driven end to end: prepare, transcribe (stand-in engine), cut words, undo/redo, reload, silences, preview render.
const SID = "editor-fixture-0001";
const PID = "p1-ala";
const DURATION_SEC = 40;
const BURSTS_MS = [3000, 12_000, 21_000, 33_000];
const BURST_LENGTH_SEC = 1.2;

let browser: Browser;
let context: BrowserContext;

let scratch = "";

const dropFixtures = async (): Promise<void> => {
  await rm(path.join(E2E_DATA_DIR, "session", SID), { recursive: true, force: true });
  await rm(path.join(E2E_DATA_DIR, "post", SID), { recursive: true, force: true });
};

test.beforeAll(async () => {
  // E2E_CDP_URL attaches to an already running Chromium; otherwise one is launched (E2E_BROWSER_CHANNEL=chrome picks an installed Chrome).
  browser = process.env.E2E_CDP_URL ? await chromium.connectOverCDP(process.env.E2E_CDP_URL) : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined });
  await dropFixtures();
  // The synthetic helper's own bursts are 0.12 s, shorter than any speech the detector keeps: use 1.2 s tone bursts instead.
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-editor-"));
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
  // a highlight flagged by the participant at 12.5 s of the recording
  const manifestFile = path.join(E2E_DATA_DIR, "session", SID, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { participants: { tracks: { startServerMsEstimated: number; markers: unknown[] }[] }[] };
  for (const track of manifest.participants[0]?.tracks ?? []) {
    track.markers.push({ id: "highlight-1", kind: "highlight", atClientMs: 0, outputLatencyMs: null, atServerMsEstimated: track.startServerMsEstimated + 12_500 });
  }
  await writeFile(manifestFile, JSON.stringify(manifest));
});

test.afterAll(async () => {
  await browser?.close();
  await dropFixtures();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const audioMs = (page: Page): Promise<number> => page.getByTestId("pj-player").evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000);
const keptMs = async (page: Page): Promise<number> => Number(await page.getByTestId("pj-ed-kept").getAttribute("data-kept-ms"));
const saved = (page: Page) => expect(page.getByTestId("pj-ed-save")).toHaveAttribute("data-status", "saved");

/** Largest vertical extent (device pixels) of drawn pixels in the columns around `fraction` of the strip's width. */
const waveformHeightAt = (page: Page, fraction: number): Promise<number> =>
  page.getByTestId("pj-ed-timeline").evaluate((canvas: HTMLCanvasElement, at: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const centre = Math.round(canvas.width * at);
    let best = 0;
    for (let x = Math.max(0, centre - 4); x < Math.min(canvas.width, centre + 5); x++) {
      const column = ctx.getImageData(x, 0, 1, canvas.height).data;
      let first = -1;
      let last = -1;
      for (let y = 0; y < canvas.height; y++) {
        if ((column[y * 4 + 3] as number) > 0) {
          if (first < 0) first = y;
          last = y;
        }
      }
      if (first >= 0) best = Math.max(best, last - first + 1);
    }
    return best;
  }, fraction);

test("cut words and silences on the project page, undo, persistence and a rendered preview", async () => {
  test.setTimeout(240_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  context = await browser.newContext({ baseURL });
  const token = issueToken(E2E_SECRET, { sid: SID, role: "participant", pid: PID, host: true, exp: Date.now() + 3_600_000 });
  const authorization = { authorization: `Bearer ${token}` };
  // the browser already holds the host's credentials for this session, as after creating it
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

  await test.step("create the project, prepare the media and transcribe", async () => {
    await page.goto(`/project/${SID}`);
    await page.getByTestId("pj-create").click();
    await prepareEpisode(page);
    await expect(page.getByTestId("pj-transcript")).toContainText("Hello,");
    await expect(page.getByTestId("pj-ed-timeline")).toBeVisible();
  });

  const words = page.locator('[data-testid="pj-transcript"] .w');
  const total = Number(await page.getByTestId("pj-ed-kept").getAttribute("data-total-ms"));
  expect(total).toBeGreaterThan(30_000);
  expect(await keptMs(page)).toBe(total);
  expect(await words.count()).toBeGreaterThanOrEqual(2);

  await test.step("the timeline draws the waveform of the tracks", async () => {
    // a tone burst at 12 s of 40 s: the strip is much taller there than on the flat baseline next to it
    await expect.poll(() => waveformHeightAt(page, 12_050 / (DURATION_SEC * 1000)), { timeout: 15_000 }).toBeGreaterThan(8);
    expect(await waveformHeightAt(page, 8000 / (DURATION_SEC * 1000))).toBeLessThan(8);
  });

  await test.step("search, highlight chips and subtitle exports keep working", async () => {
    const search = page.getByTestId("pj-search");
    await search.fill("world");
    await expect(page.getByTestId("pj-search-count")).toContainText(/found/);
    await search.fill("");
    await expect(page.getByTestId("pj-highlight")).toHaveCount(1);
    await page.getByTestId("pj-highlight").click();
    await expect.poll(() => audioMs(page)).toBeGreaterThan(12_000);
    expect(await audioMs(page)).toBeLessThan(13_000);
    const href = (await page.getByTestId("pj-export-srt").getAttribute("href")) ?? "";
    const srt = await context.request.get(href);
    expect(srt.status()).toBe(200);
    expect(await srt.text()).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> /);
  });

  let afterDelete = total;
  await test.step("select two words and delete them, undo and redo", async () => {
    await words.nth(0).click();
    await words.nth(1).click({ modifiers: ["Shift"] });
    await expect(page.locator('[data-testid="pj-transcript"] .w.sel')).toHaveCount(2);
    await expect(page.getByTestId("pj-ed-selinfo")).toContainText("Words selected: 2");
    await expect(page.getByTestId("pj-ed-delete")).toBeEnabled();
    await page.getByTestId("pj-ed-delete").click();
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(2);
    await expect(words.nth(0)).toHaveClass(/cut/);
    afterDelete = await keptMs(page);
    expect(afterDelete).toBeLessThan(total);
    await expect(page.getByTestId("pj-ed-kept")).toContainText("Kept");

    await page.getByTestId("pj-ed-undo").click();
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(0);
    expect(await keptMs(page)).toBe(total);
    await expect(page.getByTestId("pj-ed-undo")).toBeDisabled();
    await page.getByTestId("pj-ed-redo").click();
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(2);
    expect(await keptMs(page)).toBe(afterDelete);

    // keyboard: Ctrl+Z undoes, Ctrl+Shift+Z redoes, but not while typing in the search field
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(0);
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(2);
    await page.getByTestId("pj-search").focus();
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(2);
    await page.getByTestId("pj-search").blur();
    await saved(page);
  });

  await test.step("the edit is saved and is still there after a reload", async () => {
    const response = await context.request.get(`/api/sessions/${SID}/project/edl`, { headers: authorization });
    const edl = (await response.json()) as { rev: number; removed: Range[] };
    expect(edl.removed).toHaveLength(1);
    await page.reload();
    await expect(page.getByTestId("pj-ed-timeline")).toBeVisible();
    await expect(page.locator('[data-testid="pj-transcript"] .w.cut')).toHaveCount(2);
    expect(await keptMs(page)).toBe(afterDelete);
  });

  const removed = (await ((await context.request.get(`/api/sessions/${SID}/project/edl`, { headers: authorization })).json()) as { removed: Range[] }).removed[0] as Range;

  await test.step("drag selects words; restore, keep only and the Delete key act on the selection; undo walks back", async () => {
    const selected = page.locator('[data-testid="pj-transcript"] .w.sel');
    const struck = page.locator('[data-testid="pj-transcript"] .w.cut');
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await words.nth(0).scrollIntoViewIfNeeded(); // the mouse API does not scroll
    const from = await words.nth(0).boundingBox();
    const to = await words.nth(1).boundingBox();
    expect(from && to).toBeTruthy();
    await page.mouse.move((from?.x ?? 0) + (from?.width ?? 0) / 2, (from?.y ?? 0) + (from?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((to?.x ?? 0) + (to?.width ?? 0) / 2, (to?.y ?? 0) + (to?.height ?? 0) / 2, { steps: 5 });
    await page.mouse.up();
    await expect(selected).toHaveCount(2);

    await page.getByTestId("pj-ed-restore").click();
    await expect(struck).toHaveCount(0);
    expect(await keptMs(page)).toBe(total);

    await page.getByTestId("pj-ed-keep").click(); // everything but the selection goes
    expect(await keptMs(page)).toBeLessThan(2500);
    await expect(struck).toHaveCount(0);

    await page.keyboard.press("Delete");
    await expect(struck).toHaveCount(2);
    expect(await keptMs(page)).toBe(0);

    for (let step = 0; step < 3; step++) await page.getByTestId("pj-ed-undo").click();
    await expect(struck).toHaveCount(2);
    expect(await keptMs(page)).toBe(afterDelete);
    await expect(page.getByTestId("pj-ed-undo")).toBeDisabled();
    await saved(page);
  });

  await test.step("playing skips the removed part and a seek into it lands after it", async () => {
    await words.nth(0).click(); // inside the cut: the player lands after it
    await expect.poll(() => audioMs(page)).toBeGreaterThanOrEqual(removed.e);
    expect(await audioMs(page)).toBeLessThan(removed.e + 500);
    await expect(page.getByTestId("pj-ed-pos")).toContainText("edited");

    // play from before the cut: the removed audio is never heard for more than a few frames
    const heard = await page.getByTestId("pj-player").evaluate(async (audio: HTMLAudioElement, cut: { s: number; e: number }) => {
      audio.currentTime = Math.max(0, cut.s - 400) / 1000;
      await audio.play();
      let worst = 0;
      const startedAt = performance.now();
      while (performance.now() - startedAt < 1200) {
        const ms = audio.currentTime * 1000;
        if (ms >= cut.s && ms < cut.e) worst = Math.max(worst, ms - cut.s);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const end = audio.currentTime * 1000;
      audio.pause();
      return { worst, end };
    }, removed);
    expect(heard.worst).toBeLessThan(100);
    expect(heard.end).toBeGreaterThan(removed.e);

    // click on the timeline: the playhead goes there
    const box = await page.getByTestId("pj-ed-timeline").boundingBox();
    expect(box).not.toBeNull();
    await page.getByTestId("pj-ed-timeline").click({ position: { x: (box?.width ?? 0) * 0.5, y: 30 } });
    await expect.poll(() => audioMs(page)).toBeGreaterThan(18_000);
    expect(await audioMs(page)).toBeLessThan(22_000);
  });

  await test.step("find silences, review them and apply some", async () => {
    await openFold(page, "pj-tr-tools"); // pauses and the listening copy sit in the folded tools of the transcript
    await page.getByTestId("pj-ed-si-find").click();
    const rows = page.getByTestId("pj-ed-si-row");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const totalBefore = Number(await page.getByTestId("pj-ed-si-total").getAttribute("data-ms"));
    expect(totalBefore).toBeGreaterThan(1000);

    // unchecking a row takes its time off the total, and the row stays when the rest is applied
    const last = rows.nth(count - 1);
    await last.getByTestId("pj-ed-si-check").uncheck();
    expect(Number(await page.getByTestId("pj-ed-si-total").getAttribute("data-ms"))).toBeLessThan(totalBefore);

    // the preview plays 1.5 s before the cut, jumps over it and plays 1.5 s after it
    const report = (await (await context.request.get(`/api/sessions/${SID}/project/silences?minSilenceMs=700&keepMs=300`, { headers: authorization })).json()) as { silences: Silence[] };
    const middle = report.silences.findIndex((silence) => silence.cut.s > 5000 && silence.cut.e < 30_000);
    expect(middle).toBeGreaterThanOrEqual(0);
    const cut = (report.silences[middle] as Silence).cut;
    await rows.nth(middle).getByTestId("pj-ed-si-preview").click();
    await expect.poll(() => audioMs(page), { timeout: 8000 }).toBeGreaterThan(cut.e);
    await expect.poll(() => page.getByTestId("pj-player").evaluate((audio: HTMLAudioElement) => audio.paused), { timeout: 8000 }).toBe(true);
    expect(await audioMs(page)).toBeLessThan(cut.e + 1700);
    expect(await keptMs(page)).toBe(afterDelete); // the preview changed nothing

    await page.getByTestId("pj-ed-si-apply").click();
    await expect(page.locator('[data-testid="pj-ed-si-row"][data-state="removed"]').first()).toBeVisible();
    expect(await keptMs(page)).toBeLessThan(afterDelete);
    await expect(last).toHaveAttribute("data-state", "open");
    await expect(last.getByTestId("pj-ed-si-check")).not.toBeChecked();

    // one history entry: a single undo puts every silence back
    const afterApply = await keptMs(page);
    await page.getByTestId("pj-ed-undo").click();
    expect(await keptMs(page)).toBe(afterDelete);
    await expect(page.locator('[data-testid="pj-ed-si-row"][data-state="removed"]')).toHaveCount(0);
    await page.getByTestId("pj-ed-redo").click();
    expect(await keptMs(page)).toBe(afterApply);
    await saved(page);

    // the rest, selected again, is applied too
    await page.getByTestId("pj-ed-si-all").click();
    await page.getByTestId("pj-ed-si-apply").click();
    await expect(page.locator('[data-testid="pj-ed-si-row"][data-state="removed"]')).toHaveCount(count);
    expect(await keptMs(page)).toBeLessThan(afterApply);
    await expect(page.getByTestId("pj-ed-si-apply")).toBeDisabled();
    await saved(page);
    await page.screenshot({ path: test.info().outputPath("editor.png"), fullPage: true });
  });

  await test.step("render the preview and hear the joins", async () => {
    await openFold(page, "pj-tr-tools");
    const edited = await keptMs(page);
    // the player is created once: a flag set on it survives the page's status refreshes while the job runs
    await page.getByTestId("pj-player").evaluate((audio: HTMLAudioElement & { kept?: boolean }) => {
      audio.kept = true;
    });
    await page.getByTestId("pj-ed-render").click();
    await expect(page.getByTestId("pj-ed-cut-audio")).toBeAttached({ timeout: 90_000 });
    await expect(page.getByTestId("pj-ed-cut-stale")).toBeHidden();
    expect(await page.getByTestId("pj-player").evaluate((audio: HTMLAudioElement & { kept?: boolean }) => audio.kept === true)).toBe(true);
    const href = (await page.getByTestId("pj-ed-cut-link").getAttribute("href")) ?? "";
    expect(href).toContain("mix-cut.m4a");
    const file = await context.request.get(href);
    expect(file.status()).toBe(200);
    const target = path.join(test.info().outputDir, "mix-cut.m4a");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await file.body());
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]).toString().trim());
    expect(Math.abs(seconds - edited / 1000)).toBeLessThan(0.3);

    // an edit made after the render makes the preview stale
    await page.getByTestId("pj-ed-undo").click();
    await expect(page.getByTestId("pj-ed-cut-stale")).toBeVisible();
    await saved(page);
  });

  await context.close();
});
