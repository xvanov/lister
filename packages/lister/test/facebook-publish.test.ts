import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findNewListingId,
  listingIdFromPublish,
  listingIdFromUrl,
  parseJsonBlob,
  priceDigits,
  stopFromBody,
  type FbListing,
} from "../src/runner/facebook-selling";

const fixture = (n: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", n), "utf8");
const ME = "100022296936546";

describe("new listing id from Facebook's publish response (primary)", () => {
  it("reads the listing id from the create mutation (for(;;) prefix + deferred NDJSON)", () => {
    const values = parseJsonBlob(fixture("fb-publish-response.txt"));
    expect(values.length).toBe(2);
    expect(listingIdFromPublish(values, [ME])).toBe("1876543210987654");
  });

  it("never takes the seller's user id, story ids or photo ids", () => {
    const values = parseJsonBlob(fixture("fb-publish-response.txt"));
    const id = listingIdFromPublish(values, [ME]);
    expect(id).not.toBe(ME);
    expect(id).not.toBe("998877665544332211");
  });

  it("ignores listings in responses that are not a create/publish", () => {
    expect(listingIdFromPublish(parseJsonBlob(fixture("fb-unrelated-mutation.txt")), [ME])).toBeNull();
  });

  it("returns null when a create response names two different listings", () => {
    const two = {
      data: {
        marketplace_listing_create: { listing: { id: "1000000000000001" } },
        other_marketplace_create: { listing: { id: "1000000000000002" } },
      },
    };
    expect(listingIdFromPublish([two])).toBeNull();
  });

  it("reads an id from a URL Facebook navigates to", () => {
    expect(listingIdFromUrl("https://www.facebook.com/marketplace/item/1876543210987654/?ref=x")).toBe("1876543210987654");
    expect(listingIdFromUrl("https://www.facebook.com/marketplace/you/selling/?listing_id=1876543210987654")).toBe("1876543210987654");
    expect(listingIdFromUrl("https://www.facebook.com/marketplace/you/selling/")).toBeNull();
  });
});

describe("Your listings read-back (fallback)", () => {
  const l = (id: string, title: string, price: string, createdAt?: number): FbListing => ({
    id,
    title,
    price,
    status: "active",
    ...(createdAt !== undefined ? { createdAt } : {}),
  });

  it("with duplicate titles, price tells them apart", () => {
    const after = [l("1", "Oak table", "$50"), l("2", "Oak table", "$80")];
    expect(findNewListingId(after, "Oak table", new Set(), { priceCents: 8000 })).toBe("2");
  });

  it("with duplicate title AND price, the strictly newest created after publish wins", () => {
    const since = 1_800_000_000;
    const after = [l("1", "Oak table", "$50", since - 86400), l("2", "Oak table", "$50", since + 5)];
    expect(findNewListingId(after, "Oak table", new Set(), { priceCents: 5000, since })).toBe("2");
  });

  it("never guesses: no times, equal times, or nothing created after publish", () => {
    const since = 1_800_000_000;
    expect(findNewListingId([l("1", "A", "$5"), l("2", "A", "$5")], "A", new Set(), { priceCents: 500 })).toBeNull();
    expect(
      findNewListingId([l("1", "A", "$5", since), l("2", "A", "$5", since)], "A", new Set(), { priceCents: 500, since }),
    ).toBeNull();
    expect(
      findNewListingId([l("1", "A", "$5", since - 9000), l("2", "A", "$5", since - 8000)], "A", new Set(), {
        priceCents: 500,
        since,
      }),
    ).toBeNull();
  });

  it("listings seen before Publish are excluded", () => {
    const after = [l("1", "A", "$5"), l("2", "A", "$5")];
    expect(findNewListingId(after, "A", new Set(["1"]), { priceCents: 500 })).toBe("2");
  });

  it("price text normalizes", () => {
    expect(priceDigits("$1,200")).toBe("1200");
    expect(priceDigits("US$5")).toBe("5");
    expect(priceDigits("Free")).toBe("0");
  });
});

describe("Limit reached", () => {
  it("is a clear failure reason", () => {
    expect(stopFromBody("Limit reached\nWe limit how often you can post")).toMatch(/posting limit for this account/);
    expect(stopFromBody("You've reached your listing limit for today")).toMatch(/Limit reached/);
  });
});
