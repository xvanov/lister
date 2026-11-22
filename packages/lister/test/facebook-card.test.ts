/**
 * Mark sold / delete click paths, run in Chromium against a saved "Your
 * listings" fixture: a dry run must stop before the state-changing click.
 * Skipped (with a note) when Playwright's Chromium is not installed.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actOnCard } from "../src/runner/facebook-card";

const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures/fb-selling-cards.html"), "utf8");
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.warn(`facebook-card tests skipped: Chromium not available (${(err as Error).message.split("\n")[0]})`);
  }
});
afterAll(async () => {
  await browser?.close();
});

async function fixturePage(): Promise<{ page: Page; shots: string[] }> {
  const page = await browser!.newPage();
  await page.setContent(html);
  const shots: string[] = [];
  return { page, shots };
}

const base = { log: () => undefined, pause: 10 };
const clicked = (page: Page) => page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked);

describe("Facebook card actions on a saved page", () => {
  it("remove, dry run: opens the menu and the confirmation, screenshots it, cancels, never confirms", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, shots } = await fixturePage();
    const rec = { shot: async (_p: Page, n: string) => void shots.push(n) };
    const r = await actOnCard(page, { ...base, rec, action: "remove", id: "1234567890123456", title: "TEST — do not buy", live: false });
    expect(r).toMatchObject({ status: "LIVE" });
    expect(r!.lastError).toMatch(/dry run: stopped at the "Delete" confirmation/);
    expect(shots).toEqual(["remove-menu-open", "dry-run-stopped-before-delete-confirm"]);
    expect(await clicked(page)).toEqual(["menu", "delete-item", "cancel"]);
    await page.close();
  });

  it("remove, live: clicks the dialog's Delete", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, shots } = await fixturePage();
    const rec = { shot: async (_p: Page, n: string) => void shots.push(n) };
    const r = await actOnCard(page, { ...base, rec, action: "remove", id: "1", title: "TEST — do not buy", live: true });
    expect(r).toBeNull();
    expect(await clicked(page)).toEqual(["menu", "delete-item", "delete-confirm"]);
    await page.close();
  });

  it("mark sold, dry run: finds the button and does not click it", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, shots } = await fixturePage();
    const rec = { shot: async (_p: Page, n: string) => void shots.push(n) };
    const r = await actOnCard(page, { ...base, rec, action: "markSold", id: "1", title: "TEST — do not buy", live: false });
    expect(r!.lastError).toMatch(/dry run: stopped before "Mark as sold"/);
    expect(shots).toEqual(["dry-run-stopped-before-mark-sold"]);
    expect(await clicked(page)).toEqual([]);
    await page.close();
  });

  it("mark sold, live: clicks exactly that card's button", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page } = await fixturePage();
    const rec = { shot: async () => undefined };
    await actOnCard(page, { ...base, rec, action: "markSold", id: "1", title: "TEST — do not buy", live: true });
    expect(await clicked(page)).toEqual(["mark-sold"]);
    await page.close();
  });

  it("a title with a guarded word (Post hole digger) still opens its menu on a dry run", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page } = await fixturePage();
    const rec = { shot: async () => undefined };
    const r = await actOnCard(page, { ...base, rec, action: "remove", id: "2", title: "Post hole digger", live: false });
    expect(r!.status).toBe("LIVE");
    expect(await clicked(page)).toEqual(["menu", "delete-item", "cancel"]);
    await page.close();
  });

  it("a missing card fails without clicking anything", async (ctx) => {
    if (!browser) return ctx.skip();
    const { page } = await fixturePage();
    const rec = { shot: async () => undefined };
    await expect(
      actOnCard(page, { ...base, rec, action: "remove", id: "9", title: "Not here", live: false }),
    ).rejects.toThrow(/expected one menu button/);
    expect(await clicked(page)).toEqual([]);
    await page.close();
  });
});
