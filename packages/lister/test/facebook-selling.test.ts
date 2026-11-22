import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  decideOnCard,
  extractSellingListings,
  fbPrice,
  findNewListingId,
  jsonScriptBlocks,
  matchOption,
  parseJsonBlob,
  stopFromBody,
  stopFromUrl,
} from "../src/runner/facebook-selling";

const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures/fb-selling.html"), "utf8");
const listings = extractSellingListings(jsonScriptBlocks(html).flatMap(parseJsonBlob));

describe("Your listings page (saved HTML fixture)", () => {
  it("reads every listing with a numeric id, title and status", () => {
    expect(listings.map((l) => [l.id, l.title, l.status])).toEqual([
      ["1234567890123456", "TEST — do not buy", "active"],
      ["2222222222222222", "Old couch", "sold"],
      ["3333333333333333", "Draft lamp", "draft"],
    ]);
    expect(listings[0]).toMatchObject({ price: "$5", onMarketplace: true, createdAt: 1795400000 });
  });

  it("parses GraphQL bodies with the for(;;); prefix and NDJSON", () => {
    const body = 'for (;;);{"a":{"id":"4444444444444444","marketplace_listing_title":"Chair","is_sold":false,"is_pending":false}}\n{"b":1}';
    expect(extractSellingListings(parseJsonBlob(body))).toHaveLength(1);
  });

  it("finds the new listing's id only when exactly one fresh match exists", () => {
    expect(findNewListingId(listings, "TEST — do not buy", new Set())).toBe("1234567890123456");
    expect(findNewListingId(listings, "TEST — do not buy", new Set(["1234567890123456"]))).toBeNull();
    const twin = [...listings, { ...listings[0]!, id: "5555555555555555" }];
    expect(findNewListingId(twin, "TEST — do not buy", new Set())).toBeNull();
  });

  it("decides what to do on a card", () => {
    expect(decideOnCard(listings, "1234567890123456", "markSold").kind).toBe("act");
    expect(decideOnCard(listings, "2222222222222222", "markSold").kind).toBe("already");
    expect(decideOnCard(listings, "9999999999999999", "remove").kind).toBe("already");
    expect(decideOnCard([], "1", "remove").kind).toBe("failed");
  });
});

describe("form helpers", () => {
  it("matches drawer options exactly, then by prefix, then contains", () => {
    const opts = ["Tools", "Furniture", "Household", "Used - Like New", "Used - Good"];
    expect(matchOption(opts, "furniture")).toBe("Furniture");
    expect(matchOption(opts, "Used - Good")).toBe("Used - Good");
    expect(matchOption(opts, "House")).toBe("Household");
    expect(matchOption(opts, "Cars")).toBeNull();
  });

  it("prices are whole dollars", () => {
    expect(fbPrice(500)).toBe("5");
    expect(fbPrice(1999)).toBe("20");
  });

  it("detects login/checkpoint and limits", () => {
    expect(stopFromUrl("https://www.facebook.com/checkpoint/123")).toMatch(/login or checkpoint/);
    expect(stopFromUrl("https://www.facebook.com/marketplace/create/item")).toBeNull();
    expect(stopFromBody("Limit reached. We limit how often sellers can post")).toMatch(/Limit reached/);
    expect(stopFromBody("Item for sale Title Price")).toBeNull();
  });
});
