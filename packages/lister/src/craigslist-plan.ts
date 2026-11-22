/**
 * Craigslist, the pure part: account settings, where a listing goes (area,
 * subarea, category), pacing, and reading Craigslist's pages. No browser, no
 * DB: unit-tested in test/craigslist.test.ts.
 *
 * The posting flow (post.craigslist.org, mapped with dry runs 2026-11-22). Each
 * step is a form; the step name is the `s=` query parameter:
 *   area       <select name=n> of every site ("raleigh / durham / CH" = 36)
 *   subarea    radios, only on sites that have them (rdu has none)
 *   type       radios name=id: "for sale by owner" = fso
 *   cat        radios name=id: "tools" = 118, "furniture" = 141, ...
 *              ("cars & trucks ($5)", "motorcycles/scooters ($5)", "rvs ($5)" cost money)
 *   edit       PostingTitle, price, geographic_area, postal, PostingBody,
 *              condition <select>, FromEMail (only when not logged in),
 *              Privacy=C (CL mail relay) hidden, contact_chat_ok, show_phone_ok ...
 *   geoverify  map; "continue"
 *   editimage  input[type=file] (plupload), up to 24 images; "done with images"
 *   preview    "this is an unpublished draft." + the "publish" button  ← final step
 * Not logged in, Craigslist emails a confirmation link after publish and the
 * posting only goes live when it is clicked; logged in, publish is immediate
 * and the posting shows on the account's home (accounts.craigslist.org/login/home)
 * with renew / delete buttons. lister requires a logged-in profile for live runs.
 */
import { z } from "zod";

export const POST_URL = (site: string) =>
  `https://post.craigslist.org/c/${encodeURIComponent(site)}?lang=en`;
export const ACCOUNT_HOME = "https://accounts.craigslist.org/login/home";
export const LOGIN_URL = "https://accounts.craigslist.org/login";

/** Craigslist site code → the text of its option on the "area" step. */
export const CL_AREAS: Record<string, string> = {
  rdu: "raleigh / durham / CH",
  raleigh: "raleigh / durham / CH",
  durham: "raleigh / durham / CH",
  greensboro: "greensboro",
  charlotte: "charlotte",
  fayetteville: "fayetteville, NC",
  wilmington: "wilmington, NC",
};

export const pacingSchema = z.object({
  perHour: z.number().int().min(1).max(100).default(1),
  perDay: z.number().int().min(1).max(500).default(6),
  renewAfterHours: z.number().min(1).max(24 * 30).default(48),
});

export const craigslistSettingsSchema = z.object({
  /** The account's email. Required by the form when not logged in. */
  contactEmail: z.string().email().optional(),
  /** Replies: "relay" = CL mail relay (Craigslist hides the address). */
  replyVia: z.enum(["relay"]).default("relay"),
  /** Also allow CL chat replies. */
  chat: z.boolean().default(false),
  /** Publish a phone number (off by default; replies go through the relay). */
  phone: z.string().trim().max(30).optional(),
  area: z.string().trim().default("rdu"),
  subarea: z.string().trim().optional(),
  /** "city or neighborhood" on the form; listing.location overrides it. */
  city: z.string().trim().default("Durham"),
  postal: z.string().trim().default("27701"),
  pacing: pacingSchema.default({ perHour: 1, perDay: 6, renewAfterHours: 48 }),
});
export type CraigslistSettings = z.infer<typeof craigslistSettingsSchema>;

/** Parse an account's settings JSON with defaults. Throws a readable error. */
export function craigslistSettings(raw: unknown): CraigslistSettings {
  const r = craigslistSettingsSchema.safeParse(raw ?? {});
  if (!r.success)
    throw new Error(
      `account settings are invalid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return r.data;
}

export const listingOptionsSchema = z
  .object({
    area: z.string().optional(),
    subarea: z.string().optional(),
    category: z.string().optional(),
  })
  .passthrough();

/**
 * Garage / Facebook-style category → Craigslist "for sale by owner" category.
 * Keys are matched case-insensitively, whole name first, then by keyword.
 */
const CATEGORY_EXACT: Record<string, string> = {
  tools: "tools",
  "tools & hardware": "tools",
  furniture: "furniture",
  household: "household items",
  "household items": "household items",
  "home goods": "household items",
  "home & garden": "household items",
  kitchen: "household items",
  appliances: "appliances",
  electronics: "electronics",
  "electronics & computers": "electronics",
  computers: "computers",
  "computer parts": "computer parts",
  "cell phones": "cell phones",
  "mobile phones": "cell phones",
  "video games": "video gaming",
  "video gaming": "video gaming",
  "toys & games": "toys & games",
  toys: "toys & games",
  "baby & kids": "baby & kid stuff",
  "baby & kid stuff": "baby & kid stuff",
  "sporting goods": "sporting goods",
  sports: "sporting goods",
  "sports & outdoors": "sporting goods",
  bicycles: "bicycles",
  bikes: "bicycles",
  "musical instruments": "musical instruments",
  instruments: "musical instruments",
  books: "books & magazines",
  "books, movies & music": "books & magazines",
  "cds / dvds / vhs": "cds / dvds / vhs",
  clothing: "clothing & accessories",
  "clothing & shoes": "clothing & accessories",
  apparel: "clothing & accessories",
  "jewelry & watches": "jewelry",
  jewelry: "jewelry",
  "health & beauty": "health and beauty",
  "arts & crafts": "arts & crafts",
  antiques: "antiques",
  collectibles: "collectibles",
  "antiques & collectibles": "antiques",
  garden: "farm & garden",
  "patio & garden": "farm & garden",
  "farm & garden": "farm & garden",
  "auto parts": "auto parts",
  "vehicle parts": "auto parts",
  "auto wheels & tires": "auto wheels & tires",
  "building materials": "materials",
  materials: "materials",
  "home improvement supplies": "materials",
  "photo/video": "photo/video",
  cameras: "photo/video",
  "office supplies": "business/commercial",
  "business/commercial": "business/commercial",
  "pet supplies": "general for sale",
  free: "free stuff",
  "free stuff": "free stuff",
  miscellaneous: "general for sale",
  misc: "general for sale",
  "garage sale": "general for sale",
  other: "general for sale",
};

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(drill|saw|wrench|tool|sander|ladder|compressor)\b/i, "tools"],
  [/\b(sofa|couch|chair|table|desk|dresser|bed|shelf|shelves|cabinet|furniture)\b/i, "furniture"],
  [/\b(fridge|refrigerator|washer|dryer|microwave|dishwasher|appliance)/i, "appliances"],
  [/\b(tv|television|speaker|stereo|audio|electronic)/i, "electronics"],
  [/\b(laptop|computer|monitor|keyboard|printer)\b/i, "computers"],
  [/\b(bike|bicycle)\b/i, "bicycles"],
  [/\b(toy|game|lego|puzzle)/i, "toys & games"],
  [/\b(baby|kid|stroller|crib)/i, "baby & kid stuff"],
  [/\b(sport|golf|fitness|exercise|camping|fishing|outdoor)/i, "sporting goods"],
  [/\b(garden|lawn|mower|plant|patio)/i, "farm & garden"],
  [/\b(kitchen|cookware|decor|lamp|rug|home|household)/i, "household items"],
  [/\b(lumber|tile|paint|plywood|material)/i, "materials"],
];

/** Craigslist categories that cost money to post by owner: never chosen. */
export const PAID_CATEGORIES = /\(\$\d+\)|^(cars & trucks|motorcycles\/scooters|rvs)\b/i;

export function craigslistCategory(category: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const c = category.trim().toLowerCase();
  if (CATEGORY_EXACT[c]) return CATEGORY_EXACT[c]!;
  for (const [re, cl] of CATEGORY_KEYWORDS) if (re.test(c)) return cl;
  return "general for sale";
}

/** Contract condition → the "condition" select's option text. */
export const CL_CONDITION: Record<string, string> = {
  NEW: "new",
  USED_LIKE_NEW: "like new",
  USED_GOOD: "good",
  USED_FAIR: "fair",
};

/** Where a listing goes: listing options over account settings over defaults. */
export function placement(
  settings: CraigslistSettings,
  listing: { category: string; location: string | null; platformOptions: unknown },
): { areaText: string; site: string; subarea: string | null; category: string; city: string } {
  const opts = listingOptionsSchema.safeParse(listing.platformOptions ?? {});
  const o = opts.success ? opts.data : {};
  const area = (o.area ?? settings.area).trim();
  const site = /^[a-z]{2,20}$/.test(area) ? area : "rdu";
  const areaText = CL_AREAS[area.toLowerCase()] ?? area;
  return {
    areaText,
    site,
    subarea: (o.subarea ?? settings.subarea ?? null) || null,
    category: craigslistCategory(listing.category, o.category),
    city: (listing.location?.split(",")[0]?.trim() || settings.city).slice(0, 60),
  };
}

/**
 * Pick the option/radio label to use for `wanted` among the visible labels:
 * exact (case/space-insensitive), then starts-with, then contains.
 */
export function pickLabel(labels: string[], wanted: string): string | null {
  const n = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const w = n(wanted);
  return (
    labels.find((l) => n(l) === w) ??
    labels.find((l) => n(l).startsWith(w)) ??
    labels.find((l) => n(l).includes(w)) ??
    null
  );
}

// ── pacing ──────────────────────────────────────────────────────────────

export type Pacing = z.infer<typeof pacingSchema>;

/**
 * May the account post a new listing now? `posted` = when its earlier live
 * posts went up. Returns the earliest time it may post when it may not.
 */
export function pacingDecision(
  now: Date,
  posted: Date[],
  pacing: Pacing,
): { ok: true } | { ok: false; notBefore: Date; reason: string } {
  const hour = 3600_000;
  const lastHour = posted.filter((d) => now.getTime() - d.getTime() < hour).sort((a, b) => +a - +b);
  const lastDay = posted.filter((d) => now.getTime() - d.getTime() < 24 * hour).sort((a, b) => +a - +b);
  if (lastDay.length >= pacing.perDay) {
    const at = new Date(lastDay[lastDay.length - pacing.perDay]!.getTime() + 24 * hour);
    return { ok: false, notBefore: at, reason: `pacing: ${lastDay.length} posts in the last 24h (max ${pacing.perDay})` };
  }
  if (lastHour.length >= pacing.perHour) {
    const at = new Date(lastHour[lastHour.length - pacing.perHour]!.getTime() + hour);
    return { ok: false, notBefore: at, reason: `pacing: ${lastHour.length} post(s) in the last hour (max ${pacing.perHour})` };
  }
  return { ok: true };
}

/** May a posting last posted/renewed at `last` be renewed now? */
export function renewDecision(
  now: Date,
  last: Date | null,
  renewAfterHours: number,
): { ok: true } | { ok: false; notBefore: Date } {
  if (!last) return { ok: true };
  const at = new Date(last.getTime() + renewAfterHours * 3600_000);
  return now >= at ? { ok: true } : { ok: false, notBefore: at };
}

// ── reading Craigslist's pages ──────────────────────────────────────────

/** A posting id from a posting URL (…/tls/d/durham-oak-table/7801234567.html) or a manage URL. */
export function postingIdFromUrl(url: string): string | null {
  const m =
    /craigslist\.org\/(?:[a-z]{2,4}\/)*(?:[a-z]{3}\/)?(?:d\/[^/]+\/)?(\d{9,12})\.html/i.exec(url) ??
    /\/manage\/(\d{9,12})\b/.exec(url);
  return m ? m[1]! : null;
}

export type AfterPublish =
  | { kind: "posted"; postingId: string | null; url: string | null }
  | { kind: "emailConfirm" }
  | { kind: "payment"; detail: string }
  | { kind: "blocked"; detail: string }
  | { kind: "unknown" };

/** What the page after "publish" says: posted (with id/url), email confirmation, payment, blocked. */
export function readAfterPublish(text: string, links: string[]): AfterPublish {
  const stop = stopFromCraigslist(text);
  if (stop) return { kind: "blocked", detail: stop };
  if (/payment|credit card|billing|pay for this posting|posting fee/i.test(text))
    return { kind: "payment", detail: "Craigslist asks for payment" };
  if (/(we('ve| have) sent|check your) e-?mail|an email has been sent|click the link in the email|confirm your posting/i.test(text))
    return { kind: "emailConfirm" };
  const postUrl = links.find((l) => /craigslist\.org\/.+\/\d{9,12}\.html/i.test(l)) ?? null;
  const id = (postUrl && postingIdFromUrl(postUrl)) ?? links.map(postingIdFromUrl).find((x) => x) ?? null;
  if (postUrl || id || /thanks for posting|your posting can be seen at|is now live|has been posted/i.test(text))
    return { kind: "posted", postingId: id, url: postUrl };
  return { kind: "unknown" };
}

const CL_STOPS: Array<[RegExp, string]> = [
  [/h-?captcha|recaptcha|are you a (human|robot)|verify you are human/i, "Craigslist shows a captcha"],
  [/(posting|posted) too (fast|often|many)|too many postings|posting limit|exceeded the (maximum|limit)/i, "Craigslist says: posting limit reached for now"],
  [/(this|your) (account|ip|email).{0,40}(blocked|suspended|banned)|blocked from posting/i, "Craigslist blocked this account from posting"],
  [/appears to be a duplicate|duplicate posting|already posted (this|a similar)/i, "Craigslist says: duplicate posting (same item posted within 48h)"],
  [/prohibited (item|content)|violates (our )?terms/i, "Craigslist says: prohibited item / terms violation"],
];

export function stopFromCraigslist(text: string): string | null {
  for (const [re, why] of CL_STOPS) if (re.test(text)) return why;
  return null;
}

export interface ClPosting {
  id: string;
  title: string;
  status: string;
  /** form action URLs on the account home row, by button value (renew, delete, edit, display, ...). */
  actions: Record<string, string>;
}

const strip = (h: string) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/**
 * The postings table on the account home (accounts.craigslist.org/login/home).
 * Each row carries small POST forms (action …/manage/<postingId>…, a hidden
 * `action` or a submit `value` naming the button) and the posting's title +
 * status as text. Ids come from those forms, never from the title.
 */
export function parseAccountHome(html: string): ClPosting[] {
  const out = new Map<string, ClPosting>();
  const rows = html.split(/<tr\b/i).slice(1);
  for (const raw of rows) {
    const row = raw.split(/<\/tr>/i)[0] ?? raw;
    const forms = [...row.matchAll(/<form\b[^>]*action="([^"]*\/manage\/(\d{9,12})[^"]*)"[^>]*>([\s\S]*?)<\/form>/gi)];
    if (forms.length === 0) continue;
    const id = forms[0]![2]!;
    const actions: Record<string, string> = {};
    for (const f of forms) {
      const body = f[3] ?? "";
      const name =
        /name="action"[^>]*value="([^"]+)"/i.exec(body)?.[1] ??
        /value="([^"]+)"[^>]*name="action"/i.exec(body)?.[1] ??
        /type="submit"[^>]*value="([^"]+)"/i.exec(body)?.[1] ??
        /<button\b[^>]*>([^<]+)<\/button>/i.exec(body)?.[1];
      if (name) actions[name.trim().toLowerCase()] = f[1]!.replace(/&amp;/g, "&");
    }
    const noForms = row.replace(/<form\b[\s\S]*?<\/form>/gi, " ");
    const titleHtml = /<td\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(noForms)?.[1];
    const statusHtml = /<td\b[^>]*class="[^"]*\bstatus\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(noForms)?.[1];
    out.set(id, {
      id,
      title: strip(titleHtml ?? noForms).slice(0, 200),
      status: strip(statusHtml ?? "").toLowerCase(),
      actions,
    });
  }
  return [...out.values()];
}

/** The email the account home is logged in as ("… home of you@example.com"), if shown. */
export function accountEmail(text: string): string | null {
  const m = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}
