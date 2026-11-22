/**
 * A simulated adapter (LISTER_BROWSER_DRIVER=fake): no browser, same steps and
 * outcomes. The smoke gate drives the real API → worker → webhook path with it.
 * A title containing "[fail]" fails, to exercise the FAILED path.
 */
import type { PlatformAdapter, RunContext, RunResult } from "./types";

/** A 1x1 PNG: the "screenshot" of a simulated step. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

async function steps(ctx: RunContext, names: string[]) {
  for (const n of names) await ctx.rec.save(PNG, `fake-${n}`);
}

export const fakeAdapter: PlatformAdapter = {
  async create(ctx): Promise<RunResult> {
    if (ctx.photos.length === 0) throw new Error("at least one photo is required");
    await steps(ctx, ["create-opened", "page1-filled", "page2-audience"]);
    if (/\[fail\]/i.test(ctx.listing.title)) throw new Error("simulated failure");
    if (!ctx.account.liveMode) {
      await steps(ctx, ["dry-run-stopped-before-publish"]);
      return { status: "DRY_RUN_OK", lastError: null };
    }
    await steps(ctx, ["after-publish"]);
    const id = `9${Date.now()}`;
    return {
      status: "LIVE",
      platformListingId: id,
      url: `https://www.facebook.com/marketplace/item/${id}/`,
      lastError: null,
      postedAt: new Date(),
    };
  },
  async markSold(ctx) {
    await steps(ctx, ["mark-sold"]);
    if (!ctx.account.liveMode) return { status: "LIVE", lastError: "dry run: stopped before marking sold" };
    return { status: "SOLD", lastError: null };
  },
  async remove(ctx) {
    await steps(ctx, ["remove"]);
    if (!ctx.account.liveMode) return { status: "LIVE", lastError: "dry run: stopped before deleting" };
    return { status: "REMOVED", lastError: null };
  },
  async renew(ctx) {
    await steps(ctx, ["renew"]);
    if (!ctx.account.liveMode) return { status: "LIVE", lastError: "dry run: stopped before renewing" };
    return { status: "LIVE", lastError: null, renewedAt: new Date() };
  },
  async checkSession() {
    return { ok: true };
  },
};
