import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { E2E_DATA_DIR, E2E_SECRET } from "../../playwright.config.js";
import { issueToken } from "../../src/server/tokens.js";
import type { TranscriptFile } from "../../src/shared/transcript.js";
import { makeSyntheticSession } from "../support/synthetic.js";
import { openFold, openStep } from "../support/project-page.js";
import { script } from "../support/talk.js";

// Clips and publishing on a prepared one-camera session: clip suggestions with their reasons, in and out points that move by
// words, saving a clip and rendering it on its own (vertical, with captions), the captions and audio cleanup choices of the
// export reaching the render job, chapters, a title and description draft, and a thumbnail with a picture to download.
const SID = "clips-fixture-0001";
const PID = "p1-ala";
const DURATION_SEC = 40;

const STATEMENTS = [
  "The new model reads the whole file before it answers anything.",
  "Most of the time the slow part is the disk and not the network.",
  "We moved the cache next to the database and the latency dropped.",
  "Nobody on the team expected the migration to finish in one night.",
  "The report shows that three of the five regions are growing fast.",
  "She keeps every old version in a folder named after the release.",
  "Our biggest customer asked for a way to export everything at once.",
  "Reading the logs carefully usually shows the real cause of a crash.",
];

const SCRIPT_WORDS = script(STATEMENTS.map((text) => ({ pid: PID, text }))).words;
/** Start and end (seconds) of every statement: the recording is silent between them, as the speech detector expects. */
const SPOKEN_SEC: [number, number][] = [];
let sentenceStart = 0;
SCRIPT_WORDS.forEach((word, index) => {
  if (!word.t.endsWith(".")) return;
  SPOKEN_SEC.push([(SCRIPT_WORDS[sentenceStart]?.s ?? 0) / 1000, word.e / 1000]);
  sentenceStart = index + 1;
});

let browser: Browser;
let scratch = "";

const projectDir = path.join(E2E_DATA_DIR, "post", SID);
const dropFixtures = async (): Promise<void> => {
  await rm(path.join(E2E_DATA_DIR, "session", SID), { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
};

test.beforeAll(async () => {
  browser = process.env.E2E_CDP_URL ? await chromium.connectOverCDP(process.env.E2E_CDP_URL) : await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || undefined });
  await dropFixtures();
  scratch = await mkdtemp(path.join(tmpdir(), "syncrecord-clips-"));
  const speech = path.join(scratch, "speech.wav");
  const windows = SPOKEN_SEC.map(([from, to]) => `between(t,${from},${to})`).join("+");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${DURATION_SEC}`, "-af", `volume=0:enable='1-(${windows})'`, speech]);
  await makeSyntheticSession({
    sessionId: SID,
    storageDir: E2E_DATA_DIR,
    durationSec: DURATION_SEC,
    participants: [{ name: "Ala", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: true, audioFile: speech }],
    eventsMs: [4000, 15_000, 28_000],
    cameraSize: "640x360",
  });
});

test.afterAll(async () => {
  await browser?.close();
  await dropFixtures();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const probe = (file: string, entries: string, stream = "v:0"): string => execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

test("suggest, adjust, save and render a clip; captions and cleanup reach the render; chapters, a draft and a thumbnail", async () => {
  test.setTimeout(480_000);
  const baseURL = test.info().project.use.baseURL ?? "";
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(30_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
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
  const jobRequest = () => page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/project/jobs"));
  const card = page.getByTestId("pj-cl-card").first();

  await test.step("prepare and transcribe, then give the project a transcript long enough for clips", async () => {
    await page.goto(`/project/${SID}`);
    await page.getByTestId("pj-create").click();
    // the first step runs the whole chain; here the recordings come alone, so the clips step can be seen before a transcript exists
    await openStep(page, "details");
    await page.getByTestId("pj-prepare-again").click();
    await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(page.getByTestId("pj-player")).toHaveAttribute("src", /proxies\/mix/);
    // the stand-in speech engine answers two words; the real transcript of this recording is written over its file
    await openStep(page, "shorts");
    await expect(page.getByTestId("pj-cl-suggest")).toBeDisabled();
    await expect(page.getByTestId("pj-cl-need-transcript")).toBeVisible();
    await openStep(page, "details");
    await page.getByTestId("pj-tr-lang-again").selectOption("en");
    await page.getByTestId("pj-tr-start").click();
    await expect(page.getByTestId("pj-tr-status")).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    const file = path.join(projectDir, "transcript.json");
    const stub: TranscriptFile = JSON.parse(await readFile(file, "utf8"));
    const first = stub.words[0];
    if (!first) throw new Error("the stand-in transcript has no words");
    await writeFile(file, JSON.stringify({ ...stub, words: SCRIPT_WORDS.map((word) => ({ ...word, src: first.src, pid: first.pid })) }));
    await page.reload();
    await openStep(page, "shorts");
    await expect(page.getByTestId("pj-cl-suggest")).toBeEnabled();
  });

  await test.step("export defaults: captions and every cleanup option are off", async () => {
    await openStep(page, "episode");
    await openFold(page, "pj-ex-section");
    await expect(page.getByTestId("pj-ex-captions-block")).toBeVisible();
    await expect(page.getByTestId("pj-ex-captions")).not.toBeChecked();
    await expect(page.getByTestId("pj-ex-captions-style")).toBeDisabled();
    for (const id of ["pj-ex-clean-level", "pj-ex-clean-gate", "pj-ex-clean-denoise"]) await expect(page.getByTestId(id)).not.toBeChecked();
    await expect(page.getByTestId("pj-ex-clean-gate-db")).toHaveValue("-30");
    await expect(page.getByTestId("pj-ex-clean-gate-db")).toBeDisabled();
    await expect(page.getByTestId("pj-ex-clean-note")).toContainText("off by default");
    await page.getByTestId("pj-ex-captions").check();
    await expect(page.getByTestId("pj-ex-captions-style").locator("option")).toHaveText(["Clean", "Bold box", "Karaoke pop", "Minimal"]);
    await page.getByTestId("pj-ex-captions").uncheck();
  });

  await test.step("suggestions come with reasons, an excerpt and a range, and the model is only asked when ticked", async () => {
    await openStep(page, "shorts");
    await expect(page.getByTestId("pj-cl-llm")).not.toBeChecked();
    await page.getByTestId("pj-cl-suggest").click();
    await expect(card).toBeVisible();
    await expect(page.getByTestId("pj-cl-llm-note")).toHaveCount(0);
    await expect(card.locator("li[data-reason]").first()).toBeVisible();
    await expect(card.getByTestId("pj-cl-text")).toContainText("The new model reads the whole file");
    await expect(card.getByTestId("pj-cl-range")).toContainText("Ala");
    // ticking the box on a server without a model: a note, and the rule-based list stays
    await page.getByTestId("pj-cl-llm").check();
    await page.getByTestId("pj-cl-suggest").click();
    await expect(page.getByTestId("pj-cl-llm-note")).toHaveAttribute("data-state", "unavailable");
    await expect(card).toBeVisible();
    await page.getByTestId("pj-cl-llm").uncheck();
  });

  await test.step("the in and out points move one word at a time", async () => {
    const start = Number(await card.getAttribute("data-start"));
    const end = Number(await card.getAttribute("data-end"));
    await card.getByTestId("pj-cl-in-later").click();
    const later = Number(await card.getAttribute("data-start"));
    expect(later).toBeGreaterThan(start);
    expect(later - start).toBeLessThan(1000);
    await expect(card.getByTestId("pj-cl-in-later")).toBeFocused();
    await card.getByTestId("pj-cl-in-earlier").click();
    expect(Number(await card.getAttribute("data-start"))).toBe(start);
    await card.getByTestId("pj-cl-out-earlier").click();
    const shorter = Number(await card.getAttribute("data-end"));
    expect(shorter).toBeLessThan(end);
    await card.getByTestId("pj-cl-out-later").click();
    expect(Number(await card.getAttribute("data-end"))).toBe(end);
  });

  await test.step("play range: the player goes to the start and stops at the end", async () => {
    const start = Number(await card.getAttribute("data-start"));
    const end = Number(await card.getAttribute("data-end"));
    const audio = (): Promise<{ at: number; paused: boolean }> => page.evaluate(() => {
      const element = document.querySelector<HTMLAudioElement>('[data-testid="pj-player"]');
      return { at: element?.currentTime ?? -1, paused: element?.paused ?? true };
    });
    await card.getByTestId("pj-cl-play").click();
    await expect.poll(async () => (await audio()).at).toBeGreaterThanOrEqual(start / 1000 - 0.2);
    await expect.poll(async () => (await audio()).paused).toBe(false);
    await page.evaluate((target) => {
      const element = document.querySelector<HTMLAudioElement>('[data-testid="pj-player"]');
      if (element) element.currentTime = target;
    }, end / 1000 - 0.4);
    await expect.poll(async () => (await audio()).paused, { timeout: 10_000 }).toBe(true);
    expect((await audio()).at).toBeGreaterThanOrEqual(end / 1000 - 0.5);
  });

  await test.step("save the suggestion as a clip; it survives a reload with the vertical preset", async () => {
    await card.getByTestId("pj-cl-save").click();
    const row = page.getByTestId("pj-cl-row");
    await expect(row).toHaveCount(1);
    await expect(card.getByTestId("pj-cl-save")).toBeDisabled();
    await expect(row.getByTestId("pj-cl-preset")).toHaveValue("vertical-1080p30");
    await expect(row.getByTestId("pj-cl-captions")).toHaveValue("clean");
    await page.reload();
    await expect(page.getByTestId("pj-cl-row")).toHaveCount(1);
    await expect(page.getByTestId("pj-cl-saved-empty")).toHaveCount(0);
  });

  await test.step("audio cleanup and captions choices reach the render job; a missing denoise model offers its download", async () => {
    await openStep(page, "episode");
    await openFold(page, "pj-ex-section");
    await page.getByTestId("pj-ex-preset").selectOption("audio-mp3");
    await expect(page.getByTestId("pj-ex-captions-block")).toBeHidden();
    await page.getByTestId("pj-ex-clean-level").check();
    await page.getByTestId("pj-ex-clean-gate").check();
    await expect(page.getByTestId("pj-ex-clean-gate-db")).toBeEnabled();
    await page.getByTestId("pj-ex-clean-gate-db").fill("0");
    await page.getByTestId("pj-ex-render").click();
    await expect(page.getByTestId("pj-ex-invalid-gate")).toBeVisible();
    await page.getByTestId("pj-ex-clean-gate-db").fill("-40");
    await page.getByTestId("pj-ex-clean-denoise").check();

    const refused = jobRequest();
    await page.getByTestId("pj-ex-render").click();
    const refusedBody: { kind: string; params: Record<string, unknown> } = (await refused).postDataJSON();
    expect(refusedBody.kind).toBe("render");
    expect(refusedBody.params).toEqual({ preset: "audio-mp3", lufs: -16, truePeakDb: -1, clean: { level: true, bleedGate: true, bleedGateDb: -40, denoise: true } });
    await expect(page.getByTestId("pj-ex-denoise-missing")).toBeVisible();
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(0);
    await expect(page.getByTestId("pj-error")).toHaveCount(0);

    // the download is a network call: the test answers it and checks that the panel reacts
    await page.route("**/audio/denoise-model", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.getByTestId("pj-ex-denoise-download").click();
    await expect(page.getByTestId("pj-ex-denoise-ready")).toBeVisible();
    await page.unroute("**/audio/denoise-model");

    await page.getByTestId("pj-ex-clean-denoise").uncheck();
    const accepted = jobRequest();
    await page.getByTestId("pj-ex-render").click();
    const acceptedBody: { kind: string; params: Record<string, unknown> } = (await accepted).postDataJSON();
    expect(acceptedBody.params).toEqual({ preset: "audio-mp3", lufs: -16, truePeakDb: -1, clean: { level: true, bleedGate: true, bleedGateDb: -40, denoise: false } });
    await expect(page.getByTestId("pj-ex-row")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId("pj-ex-row")).toHaveAttribute("data-preset", "audio-mp3");
  });

  await test.step("a video export sends the captions style, or false when they are off", async () => {
    await page.getByTestId("pj-ex-preset").selectOption("youtube-1080p30");
    await expect(page.getByTestId("pj-ex-captions-block")).toBeVisible();
    await page.getByTestId("pj-ex-captions").check();
    await page.getByTestId("pj-ex-captions-style").selectOption("minimal");
    // nothing is rendered: the request is held back and answered by the test
    await page.route("**/project/jobs", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_field" }) }));
    const burned = jobRequest();
    await page.getByTestId("pj-ex-render").click();
    const burnedBody: { params: Record<string, unknown> } = (await burned).postDataJSON();
    expect(burnedBody.params).toMatchObject({ preset: "youtube-1080p30", captions: { style: "minimal" } });
    expect(burnedBody.params).toHaveProperty("clean");
    await page.getByTestId("pj-ex-captions").uncheck();
    const plain = jobRequest();
    await page.getByTestId("pj-ex-render").click();
    const plainBody: { params: Record<string, unknown> } = (await plain).postDataJSON();
    expect(plainBody.params).toMatchObject({ captions: false });
    await page.unroute("**/project/jobs");
    await page.getByTestId("pj-ex-clean-level").uncheck();
    await page.getByTestId("pj-ex-clean-gate").uncheck();
  });

  await test.step("render the saved clip: vertical, captions, its own range; the file is in the exports", async () => {
    await openStep(page, "shorts");
    const row = page.getByTestId("pj-cl-row");
    const id = (await row.getAttribute("data-id")) ?? "";
    expect(id).toMatch(/^clip-\d+-\d+$/);
    // the preview copies were removed after the first export (the default retention): the clip can no longer be played
    await expect(row.getByTestId("pj-cl-row-play")).toBeDisabled();
    await row.getByTestId("pj-cl-captions").selectOption("bold-box");
    const request = jobRequest();
    await row.getByTestId("pj-cl-render").click();
    const body: { kind: string; params: { preset: string; captions: { style: string }; range: { s: number; e: number }; clip: string } } = (await request).postDataJSON();
    expect(body.kind).toBe("render");
    expect(body.params.preset).toBe("vertical-1080p30");
    expect(body.params.captions).toEqual({ style: "bold-box" });
    expect(body.params.clip).toBe(id);
    expect(id).toBe(`clip-${body.params.range.s}-${body.params.range.e}`);

    await expect(row.getByTestId("pj-cl-done")).toBeVisible({ timeout: 240_000 });
    const exported = page.locator('[data-testid="pj-ex-row"][data-preset="vertical-1080p30"]');
    await expect(exported).toHaveCount(1);
    const href = (await exported.getByTestId("pj-ex-download").getAttribute("href")) ?? "";
    expect(await exported.getByTestId("pj-ex-download").getAttribute("download")).toContain(id);
    const response = await context.request.get(href);
    expect(response.status()).toBe(200);
    const file = path.join(scratch, "clip.mp4");
    await writeFile(file, await response.body());
    expect(probe(file, "stream=width,height")).toBe("1080,1920");
    expect(Math.abs(Number(probe(file, "format=duration", "v:0")) - (body.params.range.e - body.params.range.s) / 1000)).toBeLessThan(0.6);
    // the subtitle files sit next to the video
    const folder = path.join(projectDir, "exports", (await exported.getAttribute("data-id")) ?? "");
    await access(path.join(folder, `export-vertical-1080p30-${id}.srt`));
    await access(path.join(folder, `export-vertical-1080p30-${id}.vtt`));
  });

  await test.step("chapters follow YouTube's rules and can be copied", async () => {
    await openStep(page, "cover");
    const text = page.getByTestId("pj-pub-chapters-text");
    await expect(text).toBeVisible();
    const lines = (await text.inputValue()).split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatch(/^00:00 \S/);
    await expect(page.getByTestId("pj-pub-chapters-ok")).toBeVisible();
    await expect(page.getByTestId("pj-pub-chapters-issues")).toHaveCount(0);
    await page.getByTestId("pj-pub-chapters-copy").click();
    await expect(page.getByTestId("pj-pub-chapters-copy")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(lines.join("\n"));
  });

  await test.step("a title and description draft, copyable; the model is only asked when ticked", async () => {
    await expect(page.getByTestId("pj-pub-llm")).not.toBeChecked();
    await page.getByTestId("pj-pub-draft").click();
    await expect(page.getByTestId("pj-pub-title")).toHaveCount(3);
    await expect(page.getByTestId("pj-pub-description")).toHaveValue(/00:00/);
    await expect(page.getByTestId("pj-pub-llm-note")).toHaveCount(0);
    const title = await page.getByTestId("pj-pub-title").first().inputValue();
    expect(title.length).toBeGreaterThan(5);
    await page.getByTestId("pj-pub-title-copy").first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(title);
    await page.getByTestId("pj-pub-llm").check();
    await page.getByTestId("pj-pub-draft").click();
    await expect(page.getByTestId("pj-pub-llm-note")).toHaveAttribute("data-state", "unavailable");
    await expect(page.getByTestId("pj-pub-title")).toHaveCount(3);
  });

  await test.step("a thumbnail: moments, a shape, a text plate, then the picture and its download", async () => {
    await expect(page.getByTestId("pj-pub-moment").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("pj-pub-thumb-spec")).toContainText("3840×2160");
    await page.getByTestId("pj-pub-kind-short").click();
    await expect(page.getByTestId("pj-pub-thumb-spec")).toContainText("2160×3840");
    await page.getByTestId("pj-pub-kind-video").click();
    await expect(page.getByTestId("pj-pub-thumb-spec")).toContainText("3840×2160");
    await expect(page.getByTestId("pj-pub-moment").first()).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("pj-pub-thumb-text").fill("Why the cache moved");
    const request = jobRequest();
    await page.getByTestId("pj-pub-thumb-create").click();
    const body: { kind: string; params: { atMs: number; kind: string; text: string } } = (await request).postDataJSON();
    expect(body.kind).toBe("thumbnail");
    expect(body.params).toMatchObject({ kind: "video", text: "Why the cache moved" });

    await expect(page.getByTestId("pj-pub-thumb-img")).toBeVisible({ timeout: 180_000 });
    const href = (await page.getByTestId("pj-pub-thumb-download").getAttribute("href")) ?? "";
    expect(await page.getByTestId("pj-pub-thumb-download").getAttribute("download")).toBe("thumbnail-video.jpg");
    const response = await context.request.get(href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/jpeg");
    const file = path.join(scratch, "thumbnail.jpg");
    await writeFile(file, await response.body());
    expect(probe(file, "stream=width,height")).toBe("3840,2160");
    // the same file is in the exports list
    await expect(page.locator('[data-testid="pj-ex-row"][data-preset="thumbnail-video"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="pj-ex-row"][data-preset="thumbnail-video"]')).toContainText("Thumbnail 16:9");
  });

  await test.step("the screen follows the language", async () => {
    await page.getByTestId("lang-pl").click();
    await expect(page.getByTestId("pj-cl-suggest")).toHaveText("Zaproponuj klipy");
    await expect(page.getByTestId("pj-pub-draft")).toHaveText("Przygotuj tytuł i opis");
    await expect(page.getByTestId("pj-ex-clean-note")).toContainText("domyślnie wyłączone");
  });

  await context.close();
});
