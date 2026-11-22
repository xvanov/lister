# Selling contracts — lister · communicator · garage-saler

Status: v1, 2026-11-22. Canonical copy lives in `lister/docs/CONTRACTS.md`.
Any change to a shape here must be made in all three repos in the same change.

## The three systems

| System | Repo | Job | Web port (host) |
|---|---|---|---|
| **lister** | `/home/k/lister` (git@github.com:xvanov/lister.git) | Posts / marks sold / removes listings on Facebook Marketplace (then Craigslist) by driving a logged-in browser profile per account. Knows nothing about conversations. | **3240** |
| **communicator** | `/home/k/communicator` (branch `lister-integration`) | Every buyer conversation: reads Marketplace messages via the Matrix/mautrix-meta bridge, drafts replies, negotiates, books pickups, sends — under an autonomy mode. Knows nothing about posting. | **3220** |
| **garage-saler** | `/home/k/garage-saler` (branch `marketplace-selling`) | The catalog and the orchestrator. Tells lister to post; when live, tells communicator what the listing is and the rules (ask, floor, pickup windows, autonomy). Receives events from both. | **3201** |

All three run on the same host (k-911-X17); they call each other on `http://localhost:<port>`.

Facebook account for the first test: Meta user id **100022296936546** ("Kalin Ivanov"). It is the
account rental-media posts rentals from AND the account communicator's mautrix-meta bridge is logged
into, so buyer replies to anything lister posts arrive in communicator.

## Auth between services

- Each caller has an API key: `Authorization: Bearer <key>`. Keys are configured via env in the callee
  (lister: `LISTER_API_CLIENTS`; communicator: its existing `EXTERNAL_API_CLIENTS`), each mapped to an
  organization + scopes. Multi-tenant: every record is org-scoped; one deployment serves many apps/accounts.
- Webhooks are signed: header `X-Signature: sha256=<hex HMAC-SHA256 of raw body with the shared secret>`,
  header `X-Event-Id: <uuid>` (receivers dedupe on it), `X-Event-Type`. Delivery is at-least-once with
  retry/backoff via the sender's job queue, every attempt recorded.

## lister API (tRPC at `/api/trpc`, namespace `external.v1`, plus one upload route)

Accounts (`Account`): `{ id, platform: "FACEBOOK" | "CRAIGSLIST", label, externalAccountId (FB user id),
status: "NEEDS_LOGIN" | "READY" | "PAUSED", liveMode: boolean }`. A browser profile dir per account.
`liveMode=false` = dry run: walk the whole form, screenshot, do NOT press publish.

- `POST /api/v1/photos` (multipart `file`, Bearer) → `{ photoId }`. Bytes go to `@repo/storage`.
- `external.v1.accounts.list()` → `Account[]`
- `external.v1.listings.create({ accountId, externalRef: {system, kind, id}, title, description,
  priceCents, category, condition: "NEW"|"USED_LIKE_NEW"|"USED_GOOD"|"USED_FAIR", location?: string,
  photoIds: string[] (1..10, first = cover), callbackUrl })` → `{ listingId, status: "QUEUED" }`.
  Idempotent on `(accountId, externalRef)`: a second create for the same ref returns the existing listing.
- `external.v1.listings.get({ listingId })` → `Listing`
- `external.v1.listings.list({ externalRef? , status? })` → `Listing[]`
- `external.v1.listings.markSold({ listingId })` → `{ status: "QUEUED" }`
- `external.v1.listings.remove({ listingId })` → `{ status: "QUEUED" }`
- `external.v1.listings.retry({ listingId })`

`Listing`: `{ id, accountId, platform, externalRef, title, priceCents, status:
"QUEUED"|"POSTING"|"LIVE"|"DRY_RUN_OK"|"FAILED"|"SOLD"|"REMOVED", platformListingId?: string,
url?: string, lastError?: string, screenshots: string[], updatedAt }`

Webhook to `callbackUrl` on every status change, `X-Event-Type: listing.status`, body:
`{ eventId, type: "listing.status", listing: Listing }`.

## communicator API (tRPC, new namespace `external.v2`; v1 stays as is)

- `external.v2.listings.upsert({ externalRef: {system, kind, id}, channel: "marketplace",
  channelAccountId: "100022296936546", platformListingId?: string, title, url?,
  askingPriceCents, floorPriceCents, currency: "USD",
  facts: string (free text the AI may state: condition, dimensions, defects),
  pickup: { area: string (public, e.g. "Durham, near Duke"), addressShared: "ON_BOOKING",
            address?: string (private, revealed only when a pickup is booked),
            windows: [{ weekday: 0-6, start: "HH:MM", end: "HH:MM" }], timezone: "America/New_York" },
  autonomy: "DRAFT_ONLY" | "AUTO_WITHIN_RULES" | "FULL_AUTO",
  callbackUrl, status: "ACTIVE" | "SOLD" | "PAUSED" })` → `{ contextId }`. Idempotent on externalRef.
- `external.v2.listings.get({ externalRef })` → context + linked threads summary
- `external.v2.threads.list({ externalRef })` → `[{ threadId, buyerName, lastMessageAt, state, offerCents?, pickupAt? }]`
- `external.v2.threads.read({ threadId })` → messages (in/out, text, at) + pending drafts
- `external.v2.drafts.approve({ draftId, editedBody? })` / `external.v2.drafts.reject({ draftId })`
- `external.v2.listings.setAutonomy({ externalRef, autonomy })`

Autonomy semantics (enforced inside communicator, through the existing PendingAction + guard path — never
by bypassing it):
- `DRAFT_ONLY`: every outbound reply waits for a human approval.
- `AUTO_WITHIN_RULES`: auto-send when the draft (a) commits to no price below `floorPriceCents`, (b) proposes
  or confirms only times inside `windows`, (c) reveals the private address only after a booking, (d) the
  inbound triggered no escalation (abuse, scam pattern, off-platform payment, shipping request). Otherwise waits.
- `FULL_AUTO`: auto-send everything except hard-escalations (d). Floor still never revealed or undercut.
Every auto-send is recorded with the rule that allowed it, and visible in communicator's queue/log UI.

Webhooks to `callbackUrl`, `X-Event-Type` one of:
`thread.started {threadId, buyerName}` · `message.received {threadId, text}` · `message.sent {threadId, text, auto: boolean}` ·
`draft.pending {threadId, draftId, text, reason}` · `offer.made {threadId, priceCents}` ·
`deal.agreed {threadId, priceCents}` · `pickup.booked {threadId, at (ISO), buyerName}` ·
`escalation {threadId, reason}`. Body: `{ eventId, type, externalRef, contextId, ...payload }`.

When garage-saler upserts `status: "SOLD"`, communicator replies to other open threads for that listing
(subject to autonomy) that the item is sold, and stops negotiating.

## garage-saler responsibilities

- Item gains: `description`, `floorPriceCents`, `condition`, `category`, pickup settings (org-level default
  windows/area/address, overridable per item), `autonomy`.
- `ItemListing` per (item, platform): lister listingId, status, url, platformListingId, communicator contextId,
  last event; `ItemThread`/events mirror from communicator webhooks for display.
- "Post to Facebook" → tRPC mutation → enqueue job in `packages/jobs` (rule 5) → upload photos to lister,
  `listings.create`. On `listing.status` LIVE → `external.v2.listings.upsert` to communicator.
- Webhook receivers (route handlers, documented exception to rule 1 — external signed callers tRPC can't serve):
  `POST /api/webhooks/lister`, `POST /api/webhooks/communicator`.
- Marking an item sold → lister `markSold` + communicator upsert `status: "SOLD"`.
- UI (web first, mobile parity after): per item — post button, listing status + link, autonomy selector,
  buyer threads with messages, pending drafts with approve/edit/reject, agreed price, booked pickup.
