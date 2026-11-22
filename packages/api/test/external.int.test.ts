/**
 * Tenant isolation for lister's external API: an API key acts only in its own
 * organization. Rows are written directly; nothing here reaches the queue
 * (every call below is refused, or is a read, before an enqueue).
 */
import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";
import type { ApiCaller } from "@repo/lister";

import { appRouter } from "../src/root";
import { createCallerFactory } from "../src/trpc";

const factory = createCallerFactory(appRouter);

function apiCallerFor(t: TestTenant, scopes: ApiCaller["scopes"] = ["accounts:read", "listings:read", "listings:write"]) {
  return factory({
    db,
    session: null,
    headers: new Headers(),
    apiCaller: { name: `app-${t.organizationId}`, organizationId: t.organizationId, scopes, webhookSecret: null },
  });
}

async function seedListing(t: TestTenant) {
  const account = await db.sellerAccount.create({
    data: { organizationId: t.organizationId, platform: "FACEBOOK", label: "fb", externalAccountId: `u-${t.organizationId}` },
  });
  const listing = await db.listing.create({
    data: {
      organizationId: t.organizationId,
      accountId: account.id,
      platform: "FACEBOOK",
      refSystem: "test",
      refKind: "item",
      refId: "1",
      title: "Chair",
      description: "",
      priceCents: 500,
      category: "Furniture",
      condition: "USED_GOOD",
      photoIds: [],
      status: "DRY_RUN_OK",
    },
  });
  return { account, listing };
}

describe("external.v1 tenant isolation", () => {
  it("a key sees and changes only its own organization's accounts and listings", async () => {
    const a = await createTenant("ext-a");
    const b = await createTenant("ext-b");
    const { account, listing } = await seedListing(a);

    const asA = apiCallerFor(a);
    const asB = apiCallerFor(b);

    expect((await asA.external.v1.accounts.list()).map((x) => x.id)).toEqual([account.id]);
    expect(await asB.external.v1.accounts.list()).toEqual([]);

    const got = await asA.external.v1.listings.get({ listingId: listing.id });
    expect(got).toMatchObject({ id: listing.id, status: "DRY_RUN_OK", externalRef: { system: "test", kind: "item", id: "1" } });
    expect(await asB.external.v1.listings.list({})).toEqual([]);

    await expect(asB.external.v1.listings.get({ listingId: listing.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(asB.external.v1.listings.markSold({ listingId: listing.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      asB.external.v1.listings.create({
        accountId: account.id,
        externalRef: { system: "test", kind: "item", id: "2" },
        title: "x",
        description: "",
        priceCents: 1,
        category: "x",
        condition: "NEW",
        photoIds: ["p"],
        callbackUrl: "http://127.0.0.1:1/hook",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires a key and the right scope", async () => {
    const a = await createTenant("ext-c");
    const noKey = factory({ db, session: null, headers: new Headers() });
    await expect(noKey.external.v1.accounts.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const readOnly = apiCallerFor(a, ["listings:read"]);
    await expect(readOnly.external.v1.accounts.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readOnly.external.v1.listings.retry({ listingId: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
