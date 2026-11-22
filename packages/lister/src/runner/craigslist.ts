/**
 * Craigslist adapter: "for sale by owner" post, renew, delete (= mark sold /
 * remove), session check, by driving the account's Chromium profile.
 * The flow and page reading are documented in craigslist-plan.ts.
 *
 * Safety (same model as Facebook):
 *   - liveMode=false walks every step up to the preview page, screenshots each
 *     one, and stops before "publish". Renew / delete dry runs open the account
 *     home, find the posting's button, screenshot, and stop before it.
 *   - Every click passes guardClick; paid categories ("cars & trucks ($5)"...)
 *     are never chosen, and a page asking for payment stops the run.
 *   - Live runs need a logged-in profile (account READY); not logged in,
 *     Craigslist would only email a confirmation link.
 * Selectors are names, roles, labels and form field names (`name=`), never
 * generated class names.
 */
import type { BrowserContext, Locator, Page } from "playwright";

import { launchAccount, pageText } from "./browser";
import {
  ACCOUNT_HOME,
  accountEmail,
  CL_CONDITION,
  craigslistSettings,
  PAID_CATEGORIES,
  parseAccountHome,
  pickLabel,
  placement,
  POST_URL,
  readAfterPublish,
  renewDecision,
  stopFromCraigslist,
  type ClPosting,
  type CraigslistSettings,
} from "../craigslist-plan";
import { findMoneyStep, guardClick } from "./guard";
import {
  NeedsHumanError,
  type PlatformAdapter,
  type RunAccount,
  type RunContext,
  type RunResult,
  type SessionCheck,
} from "./types";

/** Used on the form only by DRY runs of a logged-out profile with no contactEmail: never published. */
export const DRY_RUN_EMAIL = "lister-dry-run@example.com";

async function withPage<T>(account: RunAccount, fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
  const ctx = await launchAccount(account);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(30_000);
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function go(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

const stepOf = (page: Page) => new URL(page.url()).searchParams.get("s") ?? "";

async function guarded(el: Locator, label: string, opts: { live: boolean; finalStep?: RegExp }) {
  const v = guardClick(label, opts);
  if (!v.allowed) throw new Error(`click refused: ${v.reason}`);
  await el.click();
}

async function assertNoStop(page: Page, where: string) {
  const stop = stopFromCraigslist(await pageText(page));
  if (!stop) return;
  if (/captcha/i.test(stop)) throw new NeedsHumanError(`${stop} (${where})`);
  throw new Error(`${stop} (${where})`);
}

/** Press the step's "continue" and wait for the next step to load. */
async function next(page: Page, live: boolean) {
  const from = page.url();
  const btn = page.getByRole("button", { name: /^continue$/i }).first();
  if ((await btn.count()) === 0) throw new Error(`no "continue" on step ${stepOf(page)}`);
  await guarded(btn, "continue", { live });
  await page.waitForURL((u) => u.toString() !== from, { timeout: 45_000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1200);
}

/** The visible radios of a step as label text → value. */
async function radios(page: Page): Promise<Array<{ label: string; value: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLInputElement>("input[type=radio]"))
      .filter((r) => r.offsetParent !== null)
      .map((r) => ({
        label: (r.closest("label")?.innerText ?? "").replace(/\s+/g, " ").trim(),
        value: r.value,
      })),
  );
}

async function chooseRadio(page: Page, wanted: string, what: string, log: (m: string) => void): Promise<string> {
  const opts = await radios(page);
  const hit = pickLabel(
    opts.map((o) => o.label),
    wanted,
  );
  if (!hit) throw new Error(`no ${what} "${wanted}" on Craigslist (choices: ${opts.map((o) => o.label).join(", ").slice(0, 400)})`);
  if (PAID_CATEGORIES.test(hit)) throw new Error(`${what} "${hit}" costs money to post; refused`);
  const value = opts.find((o) => o.label === hit)!.value;
  await page.locator(`input[type=radio][value="${value.replace(/"/g, '\\"')}"]`).first().check();
  log(`[craigslist] ${what}: "${hit}"`);
  return hit;
}

/**
 * Set a hidden <select> (Craigslist styles them with a widget) by option text.
 * The matching runs here, not in the page: no named helpers inside evaluate
 * (the worker's TS loader wraps them in a `__name` the page does not have).
 */
async function selectByText(page: Page, name: string, wanted: string): Promise<string | null> {
  const sel = page.locator(`select[name="${name}"]`).first();
  if ((await sel.count()) === 0) return null;
  const options = await sel.evaluate((el) =>
    Array.from((el as HTMLSelectElement).options).map((o) => ({ value: o.value, text: o.text })),
  );
  const hit = pickLabel(
    options.map((o) => o.text),
    wanted,
  );
  if (!hit) return null;
  const value = options.find((o) => o.text === hit)!.value;
  await sel.evaluate((el, v) => {
    (el as HTMLSelectElement).value = v;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  return hit;
}

async function fillIfPresent(page: Page, selector: string, value: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) return false;
  await el.fill(value);
  return true;
}

async function setCheckbox(page: Page, name: string, on: boolean) {
  const el = page.locator(`input[type=checkbox][name="${name}"]`).first();
  if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) return;
  if ((await el.isChecked()) !== on) await el.setChecked(on);
}

/** Validation messages Craigslist shows on a step that did not advance. */
async function formErrors(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[role=alert], .error, .err, .validation-error, .highlight"))
        .map((e) => (e.innerText || "").trim())
        .filter(Boolean)
        .join(" | ")
        .slice(0, 400),
    )
    .catch(() => "");
}

async function isLoggedIn(page: Page): Promise<boolean> {
  // The posting pages show "[ log in ]" to anonymous visitors only.
  const t = await pageText(page);
  return !/\[\s*log in\s*\]/i.test(t);
}

// ── create ──────────────────────────────────────────────────────────────

function fillPlan(settings: CraigslistSettings, ctx: RunContext) {
  return placement(settings, ctx.listing);
}

async function create(ctx: RunContext): Promise<RunResult> {
  const { account, listing, photos, rec, log } = ctx;
  const live = account.liveMode;
  const settings = craigslistSettings(account.settings);
  const plan = fillPlan(settings, ctx);
  if (photos.length === 0) throw new Error("at least one photo is required");
  if (PAID_CATEGORIES.test(plan.category)) throw new Error(`category "${plan.category}" costs money to post; refused`);

  return withPage(account, async (page) => {
    await go(page, POST_URL(plan.site));
    await page.waitForTimeout(1500);
    await rec.shot(page, "create-opened");
    const loggedIn = await isLoggedIn(page);
    log(`[craigslist] ${loggedIn ? "logged in" : "NOT logged in"}; area "${plan.areaText}", category "${plan.category}"`);
    if (live && !loggedIn)
      throw new NeedsHumanError("the Craigslist profile is not logged in (live posts need a logged-in account)");

    const counts: Record<string, number> = {};
    for (let i = 0; i < 16; i++) {
      await assertNoStop(page, `step ${stepOf(page) || "?"}`);
      const s = stepOf(page);
      counts[s] = (counts[s] ?? 0) + 1;
      if (counts[s] > 2) {
        await rec.shot(page, `stuck-${s}`);
        const errs = await formErrors(page);
        throw new Error(`Craigslist kept showing step "${s}"${errs ? `: ${errs}` : ""}`);
      }

      if (s === "area") {
        const chosen = await selectByText(page, "n", plan.areaText);
        if (!chosen) throw new Error(`no Craigslist area "${plan.areaText}"`);
        log(`[craigslist] area: "${chosen}"`);
      } else if (s === "subarea") {
        if (!plan.subarea) {
          const choices = (await radios(page)).map((o) => o.label).join(", ");
          throw new Error(`this area needs a subarea; set craigslist.subarea (choices: ${choices.slice(0, 300)})`);
        }
        await chooseRadio(page, plan.subarea, "subarea", log);
      } else if (s === "type") {
        await page.locator('input[type=radio][value="fso"]').check();
        log('[craigslist] type: "for sale by owner"');
      } else if (s === "cat") {
        await chooseRadio(page, plan.category, "category", log);
      } else if (s === "edit") {
        await fillIfPresent(page, "input[name=PostingTitle]", listing.title.slice(0, 70));
        await fillIfPresent(page, "input[name=price]", String(Math.round(listing.priceCents / 100)));
        await fillIfPresent(page, "input[name=geographic_area]", plan.city);
        await fillIfPresent(page, "input[name=postal]", settings.postal);
        await fillIfPresent(page, "textarea[name=PostingBody]", listing.description || listing.title);
        const cond = await selectByText(page, "condition", CL_CONDITION[listing.condition] ?? "good");
        if (!cond) log("[craigslist] condition select not found; left empty");
        const emailField = page.locator("input[name=FromEMail]").first();
        if ((await emailField.count()) > 0 && (await emailField.isVisible().catch(() => false))) {
          const email = settings.contactEmail ?? (live ? null : DRY_RUN_EMAIL);
          if (!email) throw new Error("the form asks for an email: set the account's contactEmail");
          await emailField.fill(email);
          const confirm = page.locator("input[name=ConfirmEMail]").first();
          if ((await confirm.count()) > 0) await confirm.fill(email).catch(() => undefined);
          if (email === DRY_RUN_EMAIL) log(`[craigslist] dry run: placeholder email ${DRY_RUN_EMAIL} (no contactEmail set)`);
        }
        // Replies via CL mail relay (Privacy=C is the form's default); chat + phone per settings.
        const privacy = await page.locator("input[name=Privacy]").first().inputValue().catch(() => "");
        if (privacy && privacy !== "C") log(`[craigslist] reply privacy is "${privacy}", expected C (mail relay)`);
        await setCheckbox(page, "contact_chat_ok", settings.chat);
        await setCheckbox(page, "show_phone_ok", !!settings.phone);
        if (settings.phone) {
          await setCheckbox(page, "contact_phone_ok", true);
          await setCheckbox(page, "contact_text_ok", true);
          await fillIfPresent(page, "input[name=contact_phone]", settings.phone);
        }
        await setCheckbox(page, "see_my_other", false);
        await setCheckbox(page, "show_address_ok", false);
        await rec.shot(page, "edit-filled");
      } else if (s === "geoverify") {
        await rec.shot(page, "map");
      } else if (s === "editimage") {
        const input = page.locator("input[type=file]").first();
        if ((await input.count()) === 0) throw new Error("image upload input not found");
        const files = photos.slice(0, 24);
        await input.setInputFiles(files);
        const want = new RegExp(`has ${files.length} images?`, "i");
        for (let k = 0; k < 60 && !want.test(await pageText(page)); k++) await page.waitForTimeout(1000);
        if (!want.test(await pageText(page))) log(`[craigslist] image count did not reach ${files.length}`);
        await rec.shot(page, "images-added");
        const done = page.getByRole("button", { name: /^done with images$/i }).first();
        const from = page.url();
        await guarded(done, "done with images", { live });
        await page.waitForURL((u) => u.toString() !== from, { timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        continue;
      } else if (s === "preview") {
        break;
      } else {
        await rec.shot(page, `unknown-step-${s || "none"}`);
        throw new Error(`unexpected Craigslist step "${s}" at ${page.url().replace(/\/k\/[^?]+/, "/k/…")}`);
      }
      await next(page, live);
    }

    if (stepOf(page) !== "preview") throw new Error(`did not reach the preview (at step "${stepOf(page)}")`);
    const text = await pageText(page);
    const publish = page.getByRole("button", { name: /^publish$/i }).first();
    if ((await publish.count()) === 0) throw new Error('"publish" button not found on the preview');
    const money = findMoneyStep(text) ?? (/\bfee\b|payment/i.test(text) ? "fee/payment" : null);

    if (!live) {
      await publish.scrollIntoViewIfNeeded().catch(() => undefined);
      await rec.shot(page, "dry-run-stopped-before-publish");
      log(`[craigslist] dry run complete at the preview${money ? ` (mentions "${money}")` : ""}; publish not clicked`);
      return { status: "DRY_RUN_OK", lastError: null };
    }
    if (money) throw new Error(`the preview shows a money step ("${money}"); not publishing`);
    const from = page.url();
    await guarded(publish, "publish", { live, finalStep: /^publish$/i });
    await page.waitForURL((u) => u.toString() !== from, { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await rec.shot(page, "after-publish");
    const links = await page
      .evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href))
      .catch(() => [] as string[]);
    const r = readAfterPublish(await pageText(page), [page.url(), ...links]);
    const postedAt = new Date();
    if (r.kind === "blocked") throw new Error(`${r.detail} (after publish)`);
    if (r.kind === "payment") throw new Error("Craigslist asked for payment after publish; nothing paid. Check the account.");
    if (r.kind === "emailConfirm")
      return {
        status: "FAILED",
        lastError:
          "needs a human: Craigslist emailed a confirmation link; the posting goes live only when it is clicked. Do NOT retry (it would post twice).",
      };
    let id = r.kind === "posted" ? r.postingId : null;
    let url = r.kind === "posted" ? r.url : null;
    if (!id) {
      // Fallback: the newest posting on the account home with our title.
      const rows = await readAccountHome(page);
      const mine = rows.filter((p) => p.title.toLowerCase().includes(listing.title.slice(0, 70).toLowerCase()));
      const newest = mine.sort((a, b) => b.id.localeCompare(a.id))[0];
      if (newest) id = newest.id;
    }
    if (!id) return { status: "LIVE", lastError: "published, but the posting id could not be read", postedAt };
    return { status: "LIVE", platformListingId: id, url: url ?? null, lastError: null, postedAt };
  });
}

// ── account home: renew / delete ───────────────────────────────────────

async function readAccountHome(page: Page): Promise<ClPosting[]> {
  await go(page, ACCOUNT_HOME);
  await page.waitForTimeout(1500);
  if (/\/login(\b|\?|$)/.test(new URL(page.url()).pathname) || (await page.locator("input[type=password]:visible").count()) > 0)
    throw new NeedsHumanError("Craigslist shows a login form (account home)");
  await assertNoStop(page, "account home");
  // Older postings are on further pages; the default view lists active ones first.
  return parseAccountHome(await page.content());
}

type Manage = "markSold" | "remove" | "renew";

async function manage(ctx: RunContext, action: Manage): Promise<RunResult> {
  const { account, listing, rec, log } = ctx;
  const live = account.liveMode;
  const id = listing.platformListingId;
  if (!id) throw new Error("listing has no platformListingId; it was never published");
  const settings = craigslistSettings(account.settings);
  if (action === "renew") {
    const d = renewDecision(new Date(), listing.renewedAt ?? listing.postedAt, settings.pacing.renewAfterHours);
    if (!d.ok) throw new Error(`too early to renew: allowed from ${d.notBefore.toISOString()}`);
  }

  return withPage(account, async (page) => {
    const rows = await readAccountHome(page);
    await rec.shot(page, `${action}-account-home`);
    const row = rows.find((r) => r.id === id);
    if (!row) {
      if (action === "renew") throw new Error(`posting ${id} is not on the account home (expired or deleted); not renewed`);
      log(`[craigslist] posting ${id} is not on the account home: already gone`);
      return { status: action === "markSold" ? "SOLD" : "REMOVED", lastError: null };
    }
    if (/deleted|removed|expired/.test(row.status) && action !== "renew") {
      return { status: action === "markSold" ? "SOLD" : "REMOVED", lastError: null };
    }
    const verb = action === "renew" ? "renew" : "delete";
    // The row's own form for that button: located by its action URL (posting id), not by title.
    const btn = page
      .locator(`form[action*="/manage/${id}"]`)
      .filter({ has: page.locator(`[value="${verb}" i], button:text-is("${verb}")`) })
      .locator(`input[type=submit], button`)
      .first();
    if ((await btn.count()) === 0) {
      if (action === "renew") throw new Error(`no "renew" button for posting ${id} (Craigslist allows it 48h after posting)`);
      throw new Error(`no "delete" button for posting ${id}; nothing clicked`);
    }
    await btn.scrollIntoViewIfNeeded().catch(() => undefined);
    if (!live) {
      await rec.shot(page, `dry-run-stopped-before-${verb}`);
      log(`[craigslist] dry run: found "${verb}" for posting ${id}; not clicked`);
      return { status: "LIVE", lastError: `dry run: stopped before "${verb}" (account is not live)` };
    }
    await guarded(btn, verb, { live, finalStep: new RegExp(`^${verb}$`, "i") });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(2500);
    // Some versions confirm on a manage page ("Delete this Posting" / "Renew this Posting").
    const confirm = page.getByRole("button", { name: new RegExp(`^${verb} this posting$`, "i") }).first();
    if ((await confirm.count()) > 0) {
      await guarded(confirm, verb, { live, finalStep: new RegExp(`^${verb}$`, "i") });
      await page.waitForTimeout(2500);
    }
    await rec.shot(page, `${action}-after`);
    const t = await pageText(page);
    await assertNoStop(page, `after ${verb}`);
    if (action === "renew") {
      if (/renewed|has been renewed/i.test(t)) return { status: "LIVE", lastError: null, renewedAt: new Date() };
      throw new Error(`clicked renew, but Craigslist did not confirm it: ${t.slice(0, 160)}`);
    }
    if (/deleted|removed/i.test(t)) return { status: action === "markSold" ? "SOLD" : "REMOVED", lastError: null };
    const again = (await readAccountHome(page)).find((r) => r.id === id);
    if (!again || /deleted|removed/.test(again.status))
      return { status: action === "markSold" ? "SOLD" : "REMOVED", lastError: null };
    throw new Error(`clicked delete, but posting ${id} still reads "${again.status}"`);
  });
}

// ── session ─────────────────────────────────────────────────────────────

async function checkSession(account: RunAccount): Promise<SessionCheck> {
  return withPage(account, async (page) => {
    await go(page, ACCOUNT_HOME);
    await page.waitForTimeout(1500);
    const path = new URL(page.url()).pathname;
    if (/\/login\/?$/.test(path) || (await page.locator("input[type=password]:visible").count()) > 0)
      return { ok: false, reason: "not logged in to Craigslist" };
    const stop = stopFromCraigslist(await pageText(page));
    if (stop) return { ok: false, reason: stop };
    const email = accountEmail(await pageText(page));
    if (account.externalAccountId.includes("@") && email && email !== account.externalAccountId.toLowerCase())
      return { ok: false, reason: `profile is logged in as a different Craigslist account (${email})` };
    return { ok: true, ...(email ? { identity: email } : {}) };
  });
}

export const craigslistAdapter: PlatformAdapter = {
  create,
  markSold: (ctx) => manage(ctx, "markSold"),
  remove: (ctx) => manage(ctx, "remove"),
  renew: (ctx) => manage(ctx, "renew"),
  checkSession,
};
