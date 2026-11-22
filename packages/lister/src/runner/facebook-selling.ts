/**
 * Pure parsing of Facebook's "Your listings" page (/marketplace/you/selling).
 * Ported from rental-media (facebook-marketplace-takedown.ts).
 *
 * The cards carry no item links. Ids come from the page's own JSON: inline
 * <script type="application/json"> blocks plus /api/graphql/ responses that
 * load more cards on scroll. Each listing is an object with `id`,
 * `marketplace_listing_title`, `formatted_price.text`, `is_sold`, `is_pending`,
 * `is_draft`. We read that JSON; we never guess an id from a title alone.
 */

export type FbListingStatus = "active" | "sold" | "pending" | "draft";

export interface FbListing {
  id: string;
  title: string;
  price: string;
  status: FbListingStatus;
  onMarketplace?: boolean;
  photoUrl?: string;
  /** Unix seconds, when the JSON carries a creation time. */
  createdAt?: number;
}

/** Every JSON value in a blob: one document, NDJSON lines, or a "for (;;);" prefix. */
export function parseJsonBlob(blob: string): unknown[] {
  const s = blob.replace(/^\s*for\s*\(;;\);/, "").trim();
  if (!s) return [];
  try {
    return [JSON.parse(s)];
  } catch {
    const out: unknown[] = [];
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* not JSON */
      }
    }
    return out;
  }
}

export function jsonScriptBlocks(html: string): string[] {
  return [
    ...html.matchAll(
      /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1] ?? "");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function statusOf(o: Obj): FbListingStatus | undefined {
  if (o.is_draft === true) return "draft";
  if (o.is_sold === true) return "sold";
  if (o.is_pending === true) return "pending";
  if (o.is_sold === false && o.is_pending === false) return "active";
  return undefined;
}

export function extractSellingListings(values: unknown[]): FbListing[] {
  const byId = new Map<string, Partial<FbListing>>();
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 60 || v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Obj;
    if (
      typeof o.id === "string" &&
      /^\d{6,20}$/.test(o.id) &&
      typeof o.marketplace_listing_title === "string"
    ) {
      const cur = byId.get(o.id) ?? { id: o.id };
      cur.title = o.marketplace_listing_title;
      const fp =
        isObj(o.formatted_price) && typeof o.formatted_price.text === "string"
          ? o.formatted_price.text
          : undefined;
      if (fp) cur.price = fp;
      const st = statusOf(o);
      if (st) cur.status = st;
      if (typeof o.is_on_marketplace === "boolean")
        cur.onMarketplace = o.is_on_marketplace;
      if (typeof o.creation_time === "number") cur.createdAt = o.creation_time;
      const photo =
        isObj(o.primary_listing_photo) && isObj(o.primary_listing_photo.image)
          ? o.primary_listing_photo.image.uri
          : undefined;
      if (typeof photo === "string") cur.photoUrl = photo;
      byId.set(o.id, cur);
    }
    for (const k of Object.keys(o)) visit(o[k], depth + 1);
  };
  for (const v of values) visit(v, 0);
  return [...byId.values()]
    .filter(
      (l): l is FbListing => !!l.id && typeof l.title === "string" && !!l.status,
    )
    .map((l) => ({ ...l, price: l.price ?? "" }));
}

export function itemUrl(id: string): string {
  return `https://www.facebook.com/marketplace/item/${id}/`;
}

/**
 * FALLBACK read-back after publish (the primary source is
 * `listingIdFromPublish`): an active listing with exactly our title AND price
 * that was not on the page before we published. With several such listings
 * (duplicate titles), the newest one wins, but only when the JSON carries a
 * creation time for every candidate, the newest is strictly newer than the
 * rest, and it was created after `since` (unix seconds, minus slack). Null
 * otherwise: never guess.
 */
export function findNewListingId(
  after: FbListing[],
  title: string,
  beforeIds: Set<string>,
  opts: { priceCents?: number; since?: number } = {},
): string | null {
  const t = norm(title);
  let fresh = after.filter(
    (l) => norm(l.title) === t && l.status !== "sold" && !beforeIds.has(l.id),
  );
  if (opts.priceCents !== undefined) {
    const want = fbPrice(opts.priceCents);
    fresh = fresh.filter((l) => !l.price || priceDigits(l.price) === want);
  }
  if (fresh.length === 1) return fresh[0]!.id;
  if (fresh.length === 0 || fresh.some((l) => l.createdAt === undefined)) return null;
  const sorted = [...fresh].sort((a, b) => b.createdAt! - a.createdAt!);
  const [newest, next] = sorted;
  if (newest!.createdAt === next!.createdAt) return null;
  if (opts.since !== undefined && newest!.createdAt! < opts.since - 120) return null;
  return newest!.id;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** "$1,200" / "US$1,200" / "$5" → "1200" / "5"; "Free" → "0". */
export function priceDigits(text: string): string {
  if (/^\s*free\s*$/i.test(text)) return "0";
  const m = /(\d[\d,]*)(?:\.(\d{2}))?/.exec(text);
  return m ? m[1]!.replace(/,/g, "") : "";
}

/**
 * PRIMARY: the new listing's id from Facebook's own response to Publish.
 * The create mutation's response carries the listing under a key such as
 * `marketplace_listing_create` / `..._composer_create` → `listing` (typename
 * GroupCommerceProductItem / MarketplaceListing). Only objects INSIDE a
 * create/publish key that look like a listing count (a listing key, a listing
 * typename, or a `marketplace_listing_title`), so the actor's user id, story
 * ids and tracking ids are never taken. Null unless exactly one id is found.
 */
export function listingIdFromPublish(values: unknown[], excludeIds: string[] = []): string | null {
  const found = new Set<string>();
  const exclude = new Set(excludeIds);
  const seen = new Set<unknown>();
  const looksLikeListing = (o: Obj, key: string) =>
    typeof o.id === "string" &&
    /^\d{6,20}$/.test(o.id) &&
    (/^(listing|marketplace_listing|product_item|created_listing)$/i.test(key) ||
      (typeof o.__typename === "string" && /listing|productitem/i.test(o.__typename)) ||
      typeof o.marketplace_listing_title === "string");
  const visit = (v: unknown, key: string, inside: boolean, depth: number) => {
    if (depth > 60 || v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, inside, depth + 1);
      return;
    }
    const o = v as Obj;
    if (inside && looksLikeListing(o, key) && !exclude.has(o.id as string)) found.add(o.id as string);
    for (const k of Object.keys(o)) {
      const enter = inside || /(marketplace|commerce|listing|composer).*(create|publish)|(create|publish).*(listing|marketplace|commerce)/i.test(k);
      visit(o[k], k, enter, depth + 1);
    }
  };
  for (const v of values) visit(v, "", false, 0);
  return found.size === 1 ? [...found][0]! : null;
}

/** A listing id in a URL Facebook navigated to after Publish (item page or ?listing_id=). */
export function listingIdFromUrl(url: string): string | null {
  const m =
    /\/marketplace\/item\/(\d{6,20})/.exec(url) ??
    /[?&](?:listing_id|listingID|product_id)=(\d{6,20})/.exec(url);
  return m ? m[1]! : null;
}

export type FbDecision =
  | { kind: "already"; detail: string }
  | { kind: "failed"; detail: string }
  | { kind: "act"; listing: FbListing };

/** What to do with listing `id` on the selling page (mark sold or delete). */
export function decideOnCard(
  listings: FbListing[],
  id: string,
  action: "markSold" | "remove",
): FbDecision {
  if (listings.length === 0)
    return { kind: "failed", detail: "could not read any listing from Your listings; nothing clicked" };
  const l = listings.find((x) => x.id === id);
  if (!l) return { kind: "already", detail: `listing ${id} is not on Your listings (deleted)` };
  if (action === "markSold" && l.status === "sold")
    return { kind: "already", detail: `listing ${id} is already marked sold` };
  if (l.status === "pending")
    return { kind: "failed", detail: `listing ${id} is "pending"; not touched` };
  const twins = listings.filter((x) => x.id !== id && x.title.trim() === l.title.trim());
  if (twins.length)
    return { kind: "failed", detail: `another listing has the same title as ${id}; refusing to pick a card by title` };
  return { kind: "act", listing: l };
}

/** Login / checkpoint wording judged from URL + title only (body text has false positives). */
export function stopFromUrl(url: string, title = ""): string | null {
  if (/facebook\.com\/(login|checkpoint|two_step|recover)/i.test(url))
    return "Facebook asks for a login or checkpoint";
  if (/log in|log into facebook|security check/i.test(title))
    return "Facebook asks for a login or checkpoint";
  return null;
}

const BODY_STOPS: Array<[RegExp, string]> = [
  [/enter the code|two-factor authentication|approve from another device/i, "two-factor prompt"],
  [/captcha|are you a (human|robot)/i, "bot check / captcha"],
  [
    /\blimit reached\b|you've reached your (daily )?(listing|posting) limit|reached the limit for/i,
    "Facebook says: Limit reached (posting limit for this account; wait a day before retrying)",
  ],
  [/you can't (sell|post) on marketplace|access to marketplace (is )?(restricted|denied)/i, "Marketplace access restricted"],
];

export function stopFromBody(text: string): string | null {
  for (const [re, why] of BODY_STOPS) if (re.test(text)) return why;
  return null;
}

/** Contract condition → Facebook's option label. */
export const FB_CONDITION: Record<string, string> = {
  NEW: "New",
  USED_LIKE_NEW: "Used - Like New",
  USED_GOOD: "Used - Good",
  USED_FAIR: "Used - Fair",
};

/** Whole dollars, as Facebook's price field takes them. */
export function fbPrice(priceCents: number): string {
  return String(Math.round(priceCents / 100));
}

/**
 * Pick the option to click for a wanted label among the visible option texts:
 * exact (case-insensitive) first, then "starts with", then "contains".
 */
export function matchOption(options: string[], wanted: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const w = norm(wanted);
  const opts = options.map((o) => ({ o, n: norm(o.split("\n")[0] ?? o) }));
  return (
    opts.find((x) => x.n === w)?.o ??
    opts.find((x) => x.n.startsWith(w))?.o ??
    opts.find((x) => x.n.includes(w))?.o ??
    null
  );
}
