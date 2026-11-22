import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  accountEmail,
  craigslistCategory,
  craigslistSettings,
  pacingDecision,
  PAID_CATEGORIES,
  parseAccountHome,
  pickLabel,
  placement,
  postingIdFromUrl,
  readAfterPublish,
  renewDecision,
  stopFromCraigslist,
} from "../src/craigslist-plan";
import { guardClick } from "../src/runner/guard";

const fixture = (n: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", n), "utf8");

/** The category radios exactly as post.craigslist.org showed them (2026-11-22, rdu, for sale by owner). */
const CL_CATEGORIES = [
  "antiques", "appliances", "arts & crafts", "atvs, utvs, snowmobiles", "auto parts", "auto wheels & tires",
  "aviation", "baby & kid stuff", "barter", "bicycle parts", "bicycles", "boat parts", "boats",
  "books & magazines", "business/commercial", "cars & trucks ($5)", "cds / dvds / vhs", "cell phones",
  "clothing & accessories", "collectibles", "computer parts", "computers", "electronics", "farm & garden",
  "free stuff", "furniture", "garage & moving sales", "general for sale", "health and beauty",
  "heavy equipment", "household items", "jewelry", "materials", "motorcycle parts",
  "motorcycles/scooters ($5)", "musical instruments", "photo/video", "rvs ($5)", "sporting goods", "tickets",
  "tools", "toys & games", "trailers", "video gaming", "wanted",
];

describe("category map", () => {
  it("maps garage/Facebook categories onto real Craigslist categories", () => {
    for (const [garage, cl] of [
      ["Tools", "tools"],
      ["Furniture", "furniture"],
      ["Household", "household items"],
      ["Electronics", "electronics"],
      ["Miscellaneous", "general for sale"],
      ["Sporting Goods", "sporting goods"],
      ["Toys & Games", "toys & games"],
      ["Garden", "farm & garden"],
      ["power drill", "tools"],
      ["something odd", "general for sale"],
    ] as const) {
      expect(craigslistCategory(garage)).toBe(cl);
    }
  });

  it("every mapped category exists on Craigslist and none costs money", () => {
    const samples = ["Tools", "Furniture", "Household", "Electronics", "Miscellaneous", "Baby & Kids", "Books",
      "Clothing", "Jewelry", "Appliances", "Video Games", "Bikes", "Musical Instruments", "Antiques",
      "Auto Parts", "Building Materials", "Cameras", "Free", "Health & Beauty", "Arts & Crafts", "Office Supplies"];
    for (const s of samples) {
      const c = craigslistCategory(s);
      expect(pickLabel(CL_CATEGORIES, c), `${s} → ${c}`).toBe(c);
      expect(PAID_CATEGORIES.test(c)).toBe(false);
    }
  });

  it("a per-listing override wins; paid categories are recognised", () => {
    expect(craigslistCategory("Tools", "heavy equipment")).toBe("heavy equipment");
    expect(PAID_CATEGORIES.test("cars & trucks ($5)")).toBe(true);
    expect(PAID_CATEGORIES.test("cars & trucks")).toBe(true);
    expect(PAID_CATEGORIES.test("auto parts")).toBe(false);
  });
});

describe("placement and settings", () => {
  it("defaults to raleigh/durham, relay replies, 1/h 6/day, renew after 48h", () => {
    const s = craigslistSettings(null);
    expect(s).toMatchObject({ area: "rdu", replyVia: "relay", chat: false, pacing: { perHour: 1, perDay: 6, renewAfterHours: 48 } });
    expect(placement(s, { category: "Tools", location: "Durham, NC", platformOptions: null })).toEqual({
      areaText: "raleigh / durham / CH",
      site: "rdu",
      subarea: null,
      category: "tools",
      city: "Durham",
    });
  });

  it("listing options override account settings", () => {
    const s = craigslistSettings({ area: "rdu", subarea: "x" });
    const p = placement(s, { category: "Tools", location: null, platformOptions: { area: "charlotte", subarea: "y", category: "materials" } });
    expect(p).toMatchObject({ site: "charlotte", areaText: "charlotte", subarea: "y", category: "materials", city: "Durham" });
  });

  it("bad settings are a readable error", () => {
    expect(() => craigslistSettings({ contactEmail: "nope" })).toThrow(/contactEmail/);
    expect(() => craigslistSettings({ pacing: { perHour: 0 } })).toThrow(/pacing.perHour/);
  });
});

describe("pacing", () => {
  const p = { perHour: 1, perDay: 6, renewAfterHours: 48 };
  const now = new Date("2026-11-22T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  it("allows the first post, holds the second within the hour", () => {
    expect(pacingDecision(now, [], p).ok).toBe(true);
    const d = pacingDecision(now, [ago(20)], p);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.notBefore.toISOString()).toBe("2026-11-22T12:40:00.000Z");
    expect(pacingDecision(now, [ago(61)], p).ok).toBe(true);
  });

  it("holds the 7th post in a day until the oldest is 24h old", () => {
    const six = [ago(23 * 60), ago(20 * 60), ago(15 * 60), ago(10 * 60), ago(5 * 60), ago(90)];
    const d = pacingDecision(now, six, p);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toMatch(/24h/);
      expect(d.notBefore.toISOString()).toBe("2026-11-22T13:00:00.000Z");
    }
  });

  it("renews no sooner than 48h after the last post/renew", () => {
    expect(renewDecision(now, ago(47 * 60), 48).ok).toBe(false);
    expect(renewDecision(now, ago(48 * 60), 48).ok).toBe(true);
    expect(renewDecision(now, null, 48).ok).toBe(true);
  });
});

describe("reading Craigslist pages", () => {
  it("account home: posting ids from the manage forms, never from titles", () => {
    const rows = parseAccountHome(fixture("cl-account-home.html"));
    expect(rows.map((r) => [r.id, r.title, r.status])).toEqual([
      ["7801234567", "DeWalt drill & charger", "active"],
      ["7801111111", "Old couch", "deleted"],
    ]);
    expect(Object.keys(rows[0]!.actions).sort()).toEqual(["delete", "display", "edit", "renew"]);
    expect(rows[0]!.actions.renew).toBe("https://post.craigslist.org/manage/7801234567");
    expect(accountEmail("home of owner@example.com log out")).toBe("owner@example.com");
  });

  it("posting ids from URLs", () => {
    expect(postingIdFromUrl("https://raleigh.craigslist.org/tls/d/durham-dewalt-drill/7801234567.html")).toBe("7801234567");
    expect(postingIdFromUrl("https://post.craigslist.org/manage/7801234567/abcde")).toBe("7801234567");
    expect(postingIdFromUrl("https://post.craigslist.org/k/aT7FK6v5Wu3iuugkih8o2d/AFgst?s=preview")).toBeNull();
  });

  it("the page after publish: posted / email confirmation / payment / blocked", () => {
    expect(
      readAfterPublish("Thanks for posting! Your posting can be seen at the link below.", [
        "https://raleigh.craigslist.org/tls/d/durham-dewalt-drill/7801234567.html",
      ]),
    ).toEqual({ kind: "posted", postingId: "7801234567", url: "https://raleigh.craigslist.org/tls/d/durham-dewalt-drill/7801234567.html" });
    expect(readAfterPublish("IMPORTANT - FURTHER ACTION IS REQUIRED. We've sent an email to x@y.com. Click the link in the email.", []).kind).toBe(
      "emailConfirm",
    );
    expect(readAfterPublish("Please enter your credit card to pay for this posting", []).kind).toBe("payment");
    expect(readAfterPublish("You are posting too fast. Please try later.", []).kind).toBe("blocked");
    expect(readAfterPublish("hmm", []).kind).toBe("unknown");
  });

  it("stops: captcha, limits, blocks, duplicates", () => {
    expect(stopFromCraigslist("Please complete the hCaptcha")).toMatch(/captcha/);
    expect(stopFromCraigslist("This posting appears to be a duplicate")).toMatch(/duplicate/);
    expect(stopFromCraigslist("this is an unpublished draft. publish")).toBeNull();
  });

  it("the click guard: continue / done with images pass a dry run, publish / renew / delete do not", () => {
    for (const l of ["continue", "done with images", "Continue"]) expect(guardClick(l, { live: false }).allowed).toBe(true);
    for (const l of ["publish", "renew", "delete"]) expect(guardClick(l, { live: false }).allowed).toBe(false);
    expect(guardClick("publish", { live: true, finalStep: /^publish$/i }).allowed).toBe(true);
  });
});
