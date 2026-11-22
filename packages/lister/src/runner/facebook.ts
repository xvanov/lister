/**
 * Facebook Marketplace adapter: "Item for sale" create, mark sold, delete,
 * session check — by driving the account's logged-in Chromium profile.
 *
 * Create flow (https://www.facebook.com/marketplace/create/item):
 *   page 1: photos (input[type=file][accept^="image/"]), Title, Price,
 *           Category drawer, Condition drawer, Description, (Location)
 *           → "Next"
 *   page 2: `?step=delivery` — Location, delivery method, meetup prefs → "Next"
 *   page 3: "List in more places" — Marketplace (always on), optional group
 *           checkboxes (we tick none) → "Publish" (LIVE ONLY) → lands on
 *           /marketplace/you/selling.
 * (Older versions had two pages, `step=audience` second; any number of
 * "Next" pages up to five is walked.) "Boost listing after publish" is kept OFF.
 * A dry run (account.liveMode=false) walks both pages and stops before Publish.
 *
 * Selectors are by role / label / aria-label, never generated class names.
 * Every click passes guardClick first.
 */
import type { BrowserContext, Locator, Page, Response } from "playwright";

import { launchAccount, pageText } from "./browser";
import {
  decideOnCard,
  extractSellingListings,
  FB_CONDITION,
  fbPrice,
  findNewListingId,
  itemUrl,
  jsonScriptBlocks,
  listingIdFromPublish,
  listingIdFromUrl,
  matchOption,
  parseJsonBlob,
  stopFromBody,
  stopFromUrl,
  type FbListing,
} from "./facebook-selling";
import { actOnCard } from "./facebook-card";
import { findMoneyStep, guardClick } from "./guard";
import {
  NeedsHumanError,
  type PlatformAdapter,
  type RunAccount,
  type RunContext,
  type RunResult,
  type SessionCheck,
} from "./types";

export const CREATE_URL = "https://www.facebook.com/marketplace/create/item";
export const SELLING_URL = "https://www.facebook.com/marketplace/you/selling/";
const FALLBACK_CATEGORIES = ["Miscellaneous", "Garage sale", "Household"];

async function withPage<T>(
  account: RunAccount,
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const ctx = await launchAccount(account);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(20_000);
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => undefined); // persists the profile
  }
}

/** Navigate without trusting load events (Facebook streams for a long time). */
async function go(page: Page, url: string) {
  await page.goto(url, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => undefined);
}

async function settle(page: Page, ms: number) {
  await page.waitForTimeout(ms);
}

async function assertNoStop(page: Page, where: string) {
  const byUrl = stopFromUrl(page.url(), await page.title().catch(() => ""));
  if (byUrl) throw new NeedsHumanError(`${byUrl} (${where})`);
  if ((await page.locator("input[type=password]:visible").count()) > 0)
    throw new NeedsHumanError(`Facebook shows a login form (${where})`);
  const body = stopFromBody(await pageText(page));
  if (body) {
    if (/captcha|two-factor/i.test(body)) throw new NeedsHumanError(`${body} (${where})`);
    throw new Error(`${body} (${where})`);
  }
}

async function guardedClick(
  el: Locator,
  label: string,
  opts: { live: boolean; finalStep?: RegExp },
) {
  const v = guardClick(label, opts);
  if (!v.allowed) throw new Error(`click refused: ${v.reason}`);
  await el.click();
}

/** The visible text controls on the page, for logs when something is not found. */
async function visibleControls(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=button],button,[role=option],[role=combobox],label,[role=checkbox],[role=switch]",
        ),
      )
        .filter((e) => e.offsetParent !== null)
        .map(
          (e) =>
            `${e.getAttribute("role") ?? e.tagName.toLowerCase()}:${(e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60)}`,
        )
        .filter((s) => !s.endsWith(":"))
        .slice(0, 120)
        .join(" | "),
    )
    .catch(() => "");
}

/** The input/textarea labelled `name` (Facebook wraps fields in <label> with a span of text). */
function field(page: Page, name: RegExp): Locator {
  return page.getByLabel(name).first();
}

async function fillField(page: Page, name: RegExp, value: string, what: string) {
  const el = field(page, name);
  if ((await el.count()) === 0) throw new Error(`field "${what}" not found`);
  await el.click();
  await el.fill(value);
}

/**
 * Open a drawer/dropdown (Category, Condition) and click the option whose text
 * matches `wanted`. Options may be [role=option] or [role=button] rows; the
 * page renders some lists twice, so the last visible match is clicked.
 * Returns the label that was chosen.
 */
async function chooseFromDrawer(
  page: Page,
  trigger: RegExp,
  wanted: string[],
  what: string,
  log: (m: string) => void,
): Promise<string> {
  const opener = page.getByRole("combobox", { name: trigger }).first();
  if ((await opener.count()) === 0) throw new Error(`"${what}" control not found`);
  await opener.click();
  await settle(page, 1200);

  for (let attempt = 0; attempt < 4; attempt++) {
    const texts: string[] = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=option],[role=menuitemradio],[role=radio],[role=listbox] [role=button],[role=dialog] [role=button],div[role=button]",
        ),
      )
        .filter((e) => e.offsetParent !== null)
        .map((e) => (e.innerText || "").trim())
        .filter((t) => t.length > 0 && t.length < 80),
    );
    for (const w of wanted) {
      const hit = matchOption(texts, w);
      if (!hit) continue;
      const clicked = await page.evaluate((target) => {
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[role=option],[role=menuitemradio],[role=radio],[role=listbox] [role=button],[role=dialog] [role=button],div[role=button]",
          ),
        ).filter((e) => e.offsetParent !== null && (e.innerText || "").trim() === target);
        const el = els[els.length - 1];
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      }, hit);
      if (clicked) {
        await settle(page, 900);
        log(`[facebook] ${what}: chose "${hit.split("\n")[0]}" (wanted "${wanted[0]}")`);
        return hit.split("\n")[0] ?? hit;
      }
    }
    await settle(page, 700);
  }
  log(`[facebook] ${what}: no option matched; visible: ${await visibleControls(page)}`);
  await page.keyboard.press("Escape").catch(() => undefined);
  throw new Error(`could not choose ${what} "${wanted[0]}"`);
}

/**
 * The "Boost listing after publish" switch (a paid promotion) must be OFF.
 * Returns true when it is off (or absent). Unchecking is the one click on a
 * "boost" control we make, and only in the direction that spends nothing.
 */
async function ensureBoostOff(page: Page, log: (m: string) => void): Promise<boolean> {
  const sw = page.getByRole("switch", { name: /boost/i });
  const n = await sw.count();
  for (let i = 0; i < n; i++) {
    const el = sw.nth(i);
    if (await el.isChecked().catch(() => false)) {
      log("[facebook] Boost switch was ON; turning it off");
      await el.click({ force: true }).catch(() => undefined);
      await settle(page, 800);
      if (await el.isChecked().catch(() => true)) return false;
    }
  }
  return true;
}

/** Set the pickup location (the Location typeahead), when the field is on this page. */
async function fillLocation(page: Page, location: string, log: (m: string) => void): Promise<boolean> {
  const loc = page.getByRole("combobox", { name: /location/i }).first();
  if ((await loc.count()) === 0) return false;
  const opt = page.getByRole("option").first();
  // Facebook's place search often finds nothing for "City, ST": try the full
  // text, then just the part before the first comma.
  const tries = [...new Set([location, location.split(",")[0]!.trim()])];
  for (const text of tries) {
    await loc.click();
    await loc.press("Control+A").catch(() => undefined);
    await loc.press("Backspace").catch(() => undefined);
    await loc.pressSequentially(text, { delay: 120 });
    await opt.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    if ((await opt.count()) > 0) break;
  }
  if ((await opt.count()) === 0) {
    const near = await page
      .evaluate((needle) => {
        const word = needle.split(/[ ,]/)[0]!.toLowerCase();
        return Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((e) => e.offsetParent !== null && e.children.length < 4 && (e.innerText || "").toLowerCase().includes(word))
          .map((e) => `${e.tagName.toLowerCase()}[role=${e.getAttribute("role")}][aria=${e.getAttribute("aria-label")}]:${(e.innerText || "").replace(/\s+/g, " ").slice(0, 60)}`)
          .slice(0, 40)
          .join(" | ");
      }, location)
      .catch(() => "");
    log(`[facebook] no Location suggestion for "${location}"; elements mentioning it: ${near}`);
    throw new Error(`Facebook offered no location matching "${location}"`);
  }
  const chosen = (await opt.innerText().catch(() => "")).split("\n")[0];
  await opt.click();
  await settle(page, 1000);
  log(`[facebook] Location: chose "${chosen}"`);
  return true;
}

/** Facebook may offer to continue an earlier unfinished listing. Start fresh. */
async function dismissDraftPrompt(page: Page, log: (m: string) => void) {
  const dlg = page.getByRole("dialog").last();
  if ((await dlg.count()) === 0) return;
  const text = await dlg.innerText().catch(() => "");
  if (!/draft|continue|unfinished|leave page/i.test(text)) return;
  for (const name of [/^start over$/i, /^discard( draft)?$/i, /^not now$/i, /^close$/i]) {
    const b = dlg.getByRole("button", { name }).first();
    if ((await b.count()) > 0) {
      log(`[facebook] draft prompt: clicking "${name.source}"`);
      await b.click();
      await settle(page, 1500);
      return;
    }
  }
}

/** Read every listing on Your listings (inline JSON + GraphQL on gentle scroll). */
async function readSelling(page: Page): Promise<FbListing[]> {
  const blobs: string[] = [];
  const onResponse = async (r: Response) => {
    if (!/\/api\/graphql\/?/.test(r.url())) return;
    try {
      blobs.push(await r.text());
    } catch {
      /* body gone */
    }
  };
  page.on("response", onResponse);
  try {
    await go(page, SELLING_URL);
    await settle(page, 6000);
    await assertNoStop(page, "Your listings");
    let last = -1;
    let still = 0;
    for (let i = 0; i < 8 && still < 2; i++) {
      await page.mouse.wheel(0, 2500);
      await settle(page, 2000);
      const h = await page.evaluate(() => document.body?.scrollHeight ?? 0).catch(() => 0);
      still = h === last ? still + 1 : 0;
      last = h;
    }
    await settle(page, 1500);
    blobs.push(...jsonScriptBlocks(await page.content().catch(() => "")));
  } finally {
    page.off("response", onResponse);
  }
  return extractSellingListings(blobs.flatMap(parseJsonBlob));
}

async function closeUpsells(page: Page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole("dialog").last();
    if ((await dlg.count()) === 0) return;
    const close = dlg.getByRole("button", { name: /^(close|not now|skip)$/i }).first();
    if ((await close.count()) === 0) return;
    await close.click().catch(() => undefined);
    await settle(page, 1000);
  }
}

// ── create ──────────────────────────────────────────────────────────────

async function create(ctx: RunContext): Promise<RunResult> {
  const { account, listing, photos, rec, log } = ctx;
  const live = account.liveMode;
  if (photos.length === 0) throw new Error("at least one photo is required");

  return withPage(account, async (page) => {
    // Ids already on Your listings, so the new one can be told apart after publish.
    let beforeIds = new Set<string>();
    if (live) {
      beforeIds = new Set((await readSelling(page)).map((l) => l.id));
      log(`[facebook] ${beforeIds.size} listing(s) on Your listings before publish`);
    }

    // The form renders a skeleton (sometimes only the splash logo) first.
    // Poll for the real photo input; a locator wait can return early when
    // Facebook swaps documents, and a stuck splash needs one reload.
    const photoInput = page.locator('input[type=file][accept^="image/"]');
    for (let attempt = 1; attempt <= 2; attempt++) {
      await go(page, CREATE_URL);
      for (let i = 0; i < 45 && (await photoInput.count().catch(() => 0)) === 0; i++) await settle(page, 1000);
      if ((await photoInput.count().catch(() => 0)) > 0) break;
      log(`[facebook] create form did not render (attempt ${attempt}); ${attempt < 2 ? "reloading" : "giving up"}`);
    }
    await settle(page, 2000);
    await rec.shot(page, "create-opened");
    await assertNoStop(page, "create form");
    await dismissDraftPrompt(page, log);

    // Photos first: Facebook keeps "Next" disabled without one.
    const input = page.locator('input[type=file][accept^="image/"]').first();
    if ((await input.count()) === 0) {
      log(`[facebook] no photo input; visible: ${await visibleControls(page)}`);
      throw new Error("photo upload input not found on the create form");
    }
    await input.setInputFiles(photos);
    await settle(page, 2500 + 1500 * photos.length);
    await rec.shot(page, "photos-added");

    await fillField(page, /^title$/i, listing.title, "Title");
    await fillField(page, /^price$/i, fbPrice(listing.priceCents), "Price");
    await chooseFromDrawer(
      page,
      /^category$/i,
      [listing.category, ...FALLBACK_CATEGORIES],
      "Category",
      log,
    );
    await rec.shot(page, "category-chosen");
    const cond = FB_CONDITION[listing.condition] ?? "Used - Good";
    await chooseFromDrawer(page, /^condition$/i, [cond], "Condition", log);

    // Description: sometimes behind "More details".
    let desc = field(page, /^description$/i);
    if ((await desc.count()) === 0) {
      const more = page.getByRole("button", { name: /^more details$/i }).first();
      if ((await more.count()) > 0) {
        await guardedClick(more, "More details", { live });
        await settle(page, 1000);
      }
      desc = field(page, /^description$/i);
    }
    if ((await desc.count()) > 0) {
      await desc.click();
      await desc.fill(listing.description);
    } else {
      log("[facebook] Description field not found; continuing without it");
    }

    if (!(await ensureBoostOff(page, log)))
      throw new Error('could not turn off "Boost listing after publish"; not continuing');

    await settle(page, 1000);
    await page.mouse.wheel(0, 2000).catch(() => undefined);
    await settle(page, 800);
    await rec.shot(page, "page1-filled");
    const p1 = await pageText(page);
    if (/please upload at least one photo/i.test(p1))
      throw new Error("Facebook says: Please upload at least one photo");
    await assertNoStop(page, "page 1 filled");

    // Next → page 2. Wait for it to enable.
    const next = page.getByRole("button", { name: /^next$/i }).last();
    if ((await next.count()) === 0) {
      log(`[facebook] no Next; visible: ${await visibleControls(page)}`);
      throw new Error('"Next" button not found');
    }
    for (let i = 0; i < 20 && (await next.getAttribute("aria-disabled")) === "true"; i++)
      await settle(page, 1000);
    if ((await next.getAttribute("aria-disabled")) === "true") {
      log(`[facebook] Next disabled; visible: ${await visibleControls(page)}`);
      throw new Error('"Next" stayed disabled after filling page 1 (a required field is missing)');
    }
    await guardedClick(next, "Next", { live });
    // Page 2 (step=delivery today; step=audience in older versions).
    for (let i = 0; i < 40 && !/[?&]step=/.test(page.url()); i++) await settle(page, 1500);
    await settle(page, 3000);
    await assertNoStop(page, "page 2");
    if (!/[?&]step=/.test(page.url())) log(`[facebook] page 2 URL has no step=: ${page.url()}`);
    let locationSet = false;
    if (listing.location) locationSet = await fillLocation(page, listing.location, log);
    await rec.shot(page, `page2-${new URL(page.url()).searchParams.get("step") ?? "next"}`);

    // The form may have more than two steps: keep pressing Next until Publish shows.
    for (let pageNo = 3; pageNo <= 5; pageNo++) {
      if ((await page.getByRole("button", { name: /^publish$/i }).count()) > 0) break;
      const more = page.getByRole("button", { name: /^next$/i }).last();
      if ((await more.count()) === 0) break;
      for (let i = 0; i < 15 && (await more.getAttribute("aria-disabled")) === "true"; i++)
        await settle(page, 1000);
      await guardedClick(more, "Next", { live });
      await settle(page, 4000);
      await assertNoStop(page, `page ${pageNo}`);
      if (listing.location && !locationSet) locationSet = await fillLocation(page, listing.location, log);
      await rec.shot(page, `page${pageNo}-${new URL(page.url()).searchParams.get("step") ?? "next"}`);
    }
    if (!(await ensureBoostOff(page, log)))
      throw new Error('could not turn off a Boost switch before Publish; not continuing');

    const publish = page.getByRole("button", { name: /^publish$/i }).last();
    if ((await publish.count()) === 0) {
      log(`[facebook] no Publish; visible: ${await visibleControls(page)}`);
      throw new Error('"Publish" button not found on the last page');
    }
    const p2 = await pageText(page);
    const money = findMoneyStep(p2);
    if (money) log(`[facebook] final page mentions money wording: "${money}"`);
    if (listing.location && !locationSet) log("[facebook] Location field not found; Facebook uses the profile's location");
    for (let i = 0; i < 15 && (await publish.getAttribute("aria-disabled")) === "true"; i++)
      await settle(page, 1000);
    const publishEnabled = (await publish.getAttribute("aria-disabled")) !== "true";

    if (!live) {
      await publish.scrollIntoViewIfNeeded().catch(() => undefined);
      await rec.shot(page, "dry-run-stopped-before-publish");
      log(`[facebook] dry run complete: Publish is ${publishEnabled ? "enabled" : "DISABLED"}; not clicked`);
      if (!publishEnabled) throw new Error('dry run reached the last page but "Publish" is disabled');
      return { status: "DRY_RUN_OK", lastError: null };
    }

    if (money) throw new Error(`the last page shows a money step ("${money}"); not publishing`);
    if (!publishEnabled) throw new Error('"Publish" is disabled');

    // PRIMARY id source: Facebook's own responses to Publish (the create
    // mutation's JSON) and any URL it navigates to. Collected from the click on.
    const publishBodies: string[] = [];
    const navUrls: string[] = [];
    const onPublishResponse = async (r: Response) => {
      if (!/\/api\/graphql\/?/.test(r.url()) || r.request().method() !== "POST") return;
      const post = r.request().postData() ?? "";
      if (!/mutation|create|publish/i.test(post)) return;
      try {
        publishBodies.push(await r.text());
      } catch {
        /* body gone */
      }
    };
    const onNav = (f: { url(): string }) => navUrls.push(f.url());
    page.on("response", onPublishResponse);
    page.on("framenavigated", onNav);
    const publishedAt = Math.floor(Date.now() / 1000);
    let landed = false;
    try {
      await guardedClick(publish, "Publish", { live, finalStep: /^publish$/i });
      for (let i = 0; i < 60; i++) {
        await settle(page, 2000);
        if (/marketplace\/you\/selling|marketplace\/item\//.test(page.url())) {
          landed = true;
          break;
        }
        const t = await pageText(page);
        if (/something isn't working/i.test(t))
          throw new Error("Facebook says: Something isn't working (after Publish)");
        const stop = stopFromBody(t);
        if (stop) throw new Error(`${stop} (after Publish)`);
      }
      await settle(page, 1500);
    } finally {
      page.off("response", onPublishResponse);
      page.off("framenavigated", onNav);
    }
    await rec.shot(page, "after-publish");
    const fromPublish =
      listingIdFromPublish(publishBodies.flatMap(parseJsonBlob), [account.externalAccountId]) ??
      navUrls.map(listingIdFromUrl).find((x) => x) ??
      null;
    if (fromPublish) log(`[facebook] new listing id ${fromPublish} (from Facebook's publish response)`);
    if (!landed && !fromPublish)
      throw new Error("Publish did not reach Your listings within 2 minutes; check the account before retrying");
    await closeUpsells(page);
    if (fromPublish) {
      return { status: "LIVE", platformListingId: fromPublish, url: itemUrl(fromPublish), lastError: null, postedAt: new Date() };
    }

    // FALLBACK: read Your listings back, match title + price, newest.
    const after = await readSelling(page);
    await rec.shot(page, "your-listings");
    const id = findNewListingId(after, listing.title, beforeIds, {
      priceCents: listing.priceCents,
      since: publishedAt,
    });
    if (!id) {
      return {
        status: "LIVE",
        lastError: "published, but the new listing id could not be read (publish response or Your listings)",
        postedAt: new Date(),
      };
    }
    log(`[facebook] new listing id ${id} (from Your listings read-back)`);
    return { status: "LIVE", platformListingId: id, url: itemUrl(id), lastError: null, postedAt: new Date() };
  });
}

// ── mark sold / remove ─────────────────────────────────────────────────

async function onCard(ctx: RunContext, action: "markSold" | "remove"): Promise<RunResult> {
  const { account, listing, rec, log } = ctx;
  const live = account.liveMode;
  const id = listing.platformListingId;
  const doneStatus = action === "markSold" ? "SOLD" : "REMOVED";
  if (!id) throw new Error("listing has no platformListingId; it was never published");

  return withPage(account, async (page) => {
    const listings = await readSelling(page);
    await rec.shot(page, `${action}-your-listings`);
    const d = decideOnCard(listings, id, action);
    if (d.kind === "already") {
      log(`[facebook] ${d.detail}`);
      return { status: doneStatus, lastError: null };
    }
    if (d.kind === "failed") throw new Error(d.detail);
    const dry = await actOnCard(page, { action, id, title: d.listing.title, live, rec, log });
    if (dry) return dry;
    await closeUpsells(page);

    const after = await readSelling(page);
    await rec.shot(page, `${action}-after`);
    const now = after.find((x) => x.id === id);
    if (action === "markSold" && (!now || now.status === "sold")) return { status: "SOLD", lastError: null };
    if (action === "remove" && !now) return { status: "REMOVED", lastError: null };
    throw new Error(`clicked, but listing ${id} still reads ${now?.status ?? "present"}`);
  });
}

// ── session ─────────────────────────────────────────────────────────────

async function checkSession(account: RunAccount): Promise<SessionCheck> {
  return withPage(account, async (page, ctx) => {
    await go(page, "https://www.facebook.com/marketplace/");
    await settle(page, 3000);
    const stop = stopFromUrl(page.url(), await page.title().catch(() => ""));
    if (stop) return { ok: false, reason: stop };
    if ((await page.locator("input[type=password]:visible").count()) > 0)
      return { ok: false, reason: "Facebook shows a login form" };
    const cookies = await ctx.cookies("https://www.facebook.com");
    const uid = cookies.find((c) => c.name === "c_user")?.value;
    if (!uid) return { ok: false, reason: "no Facebook session cookie" };
    if (uid !== account.externalAccountId)
      return { ok: false, reason: `profile is logged in as a different Facebook user (${uid})` };
    return { ok: true };
  });
}

async function renew(): Promise<RunResult> {
  throw new Error("Facebook listings are not renewed by lister (Facebook has no 48h renew); nothing done");
}

export const facebookAdapter: PlatformAdapter = {
  create,
  renew,
  markSold: (ctx) => onCard(ctx, "markSold"),
  remove: (ctx) => onCard(ctx, "remove"),
  checkSession,
};
