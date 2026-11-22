/**
 * @repo/lister/runner — the worker side: run one listing action on its
 * account's platform, record screenshots, return the outcome. Loaded only by
 * the worker (it imports Playwright). The caller (packages/jobs) holds the
 * per-account lock and applies the outcome with `transition`.
 */
import { db } from "@repo/db";
import { env } from "@repo/env";

import type { ListingAction, Outcome } from "../service";
import { materializePhotos, StepRecorder } from "./browser";
import { facebookAdapter } from "./facebook";
import { fakeAdapter } from "./fake";
import { NeedsHumanError, type PlatformAdapter, type RunAccount, type SessionCheck } from "./types";

export { guardClick, findMoneyStep } from "./guard";
export { launchAccount, profileDir, profilesRoot, REPO_ROOT } from "./browser";
export * from "./facebook-selling";
export type { RunAccount } from "./types";

export function adapterFor(platform: string): PlatformAdapter {
  if (env().LISTER_BROWSER_DRIVER === "fake") return fakeAdapter;
  if (platform === "FACEBOOK") return facebookAdapter;
  throw new Error(`platform ${platform} is not supported yet`);
}

const accountSelect = {
  id: true,
  platform: true,
  externalAccountId: true,
  headless: true,
  profileName: true,
  liveMode: true,
  status: true,
} as const;

function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (m.split("\n").find((l) => l.trim()) ?? m).trim().slice(0, 500);
}

export interface RunReport extends Outcome {
  localScreenshots: string[];
}

/** Run `action` for a listing. Never throws for a platform failure: it returns FAILED. */
export async function runListingAction(
  organizationId: string,
  listingId: string,
  action: ListingAction,
  log: (msg: string) => void = console.log,
): Promise<RunReport> {
  const listing = await db.listing.findFirst({
    where: { id: listingId, organizationId },
    select: {
      id: true,
      organizationId: true,
      title: true,
      description: true,
      priceCents: true,
      category: true,
      condition: true,
      location: true,
      photoIds: true,
      status: true,
      platformListingId: true,
      url: true,
      account: { select: accountSelect },
    },
  });
  if (!listing) throw new Error(`listing ${listingId} not found`);
  const account: RunAccount = listing.account;
  const rec = new StepRecorder(organizationId, listingId, log);

  // Never published on the platform: sold / removed is only our record.
  if (action !== "create" && !listing.platformListingId) {
    return {
      status: action === "markSold" ? "SOLD" : "REMOVED",
      lastError: null,
      done: true,
      localScreenshots: [],
    };
  }
  if (listing.account.status === "PAUSED") {
    return { status: "FAILED", lastError: "account is PAUSED", done: false, localScreenshots: [] };
  }

  const adapter = adapterFor(account.platform);
  const photos = action === "create" ? await materializePhotos(organizationId, listing.photoIds) : null;
  try {
    const r = await adapter[action]({
      account,
      listing,
      photos: photos?.paths ?? [],
      rec,
      log,
    });
    if (r.needsLogin) await setAccountStatus(account.id, "NEEDS_LOGIN", r.lastError ?? null);
    return {
      status: r.status,
      ...(r.platformListingId !== undefined ? { platformListingId: r.platformListingId } : {}),
      ...(r.url !== undefined ? { url: r.url } : {}),
      lastError: r.lastError ?? null,
      screenshotKeys: rec.keys,
      done: true,
      localScreenshots: rec.localPaths,
    };
  } catch (err) {
    const msg = firstLine(err);
    log(`[runner] ${action} ${listingId} failed: ${msg}`);
    if (err instanceof NeedsHumanError) await setAccountStatus(account.id, "NEEDS_LOGIN", msg);
    return {
      // A failed markSold/remove leaves the listing as it was on the platform.
      status: action === "create" ? "FAILED" : (listing.status as Outcome["status"]),
      lastError: err instanceof NeedsHumanError ? `needs a human: ${msg}` : msg,
      screenshotKeys: rec.keys,
      done: action !== "create" ? false : true,
      localScreenshots: rec.localPaths,
    };
  } finally {
    photos?.cleanup();
  }
}

async function setAccountStatus(
  accountId: string,
  status: "NEEDS_LOGIN" | "READY",
  lastError: string | null,
) {
  await db.sellerAccount.updateMany({
    where: { id: accountId, status: { not: "PAUSED" } },
    data: { status, lastError, lastCheckedAt: new Date() },
  });
}

/** Open the profile, check the session, set READY / NEEDS_LOGIN. */
export async function checkAccount(
  organizationId: string,
  accountId: string,
): Promise<SessionCheck> {
  const account = await db.sellerAccount.findFirst({
    where: { id: accountId, organizationId },
    select: accountSelect,
  });
  if (!account) throw new Error(`account ${accountId} not found`);
  let r: SessionCheck;
  try {
    r = await adapterFor(account.platform).checkSession(account);
  } catch (err) {
    r = { ok: false, reason: `session check failed: ${firstLine(err)}` };
  }
  await setAccountStatus(account.id, r.ok ? "READY" : "NEEDS_LOGIN", r.ok ? null : (r.reason ?? null));
  return r;
}
