// Steps through the post-production page (src/web/views/project-view.ts) for the e2e tests.

import { expect, type Locator, type Page } from "@playwright/test";

export type Step = "prepare" | "episode" | "shorts" | "cover" | "details";

/** Opens one step of the page (its tab) and waits until its panel is the visible one. */
export async function openStep(page: Page, step: Step): Promise<void> {
  const tab = page.getByTestId(`pj-step-${step}`);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId(`pj-panel-${step}`)).toBeVisible();
}

/** Opens a folded section (`<details data-testid=...>`) of the current step; stays open when it already is. */
export async function openFold(page: Page, testId: string): Promise<Locator> {
  const fold = page.getByTestId(testId);
  if ((await fold.getAttribute("open")) === null) await fold.locator("> summary").click();
  await expect(fold).toHaveAttribute("open", "");
  return fold;
}

/** The first step in one go: the recordings are prepared and the transcript is written (the stand-in speech engine). */
export async function prepareEpisode(page: Page, options: { lang?: "auto" | "en" | "pl"; timeout?: number } = {}): Promise<void> {
  const timeout = options.timeout ?? 120_000;
  await openStep(page, "prepare");
  await page.getByTestId("pj-tr-lang").selectOption(options.lang ?? "en");
  await page.getByTestId("pj-prepare").click();
  await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout });
  await expect(page.getByTestId("pj-tr-status")).toHaveAttribute("data-status", "done", { timeout });
  await expect(page.getByTestId("pj-step-prepare")).toHaveAttribute("data-mark", "done");
}

/** Only the recordings, no transcript: the technical route of the Details step, for tests that need no words. */
export async function prepareRecordings(page: Page, options: { timeout?: number } = {}): Promise<void> {
  await openStep(page, "details");
  await page.getByTestId("pj-prepare-again").click();
  await expect(page.getByTestId("pj-conform-status")).toHaveAttribute("data-status", "done", { timeout: options.timeout ?? 120_000 });
}
