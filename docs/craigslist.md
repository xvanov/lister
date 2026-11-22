# Craigslist (for sale by owner)

The adapter is `packages/lister/src/runner/craigslist.ts`; the pure parts
(settings, category map, pacing, page reading) are
`packages/lister/src/craigslist-plan.ts`, tested in
`packages/lister/test/craigslist.test.ts`.

## The posting flow (mapped with dry runs, 2026-11-22)

`https://post.craigslist.org/c/<site>?lang=en` walks these steps (the `s=`
query parameter): `area` (a select of every site; "raleigh / durham / CH") →
`subarea` (only where the site has them; rdu has none) → `type` ("for sale by
owner", `fso`) → `cat` (category radios) → `edit` (title, price, city, ZIP,
description, condition, email, reply options) → `geoverify` (map) →
`editimage` (up to 24 images, "done with images") → `preview` ("this is an
unpublished draft." + **publish**). A dry run stops on the preview.

Categories marked "($5)" (cars & trucks, motorcycles/scooters, rvs) cost money
and are refused; a page mentioning payment stops a live run.

## Login: needed for live runs

Without a login the form takes an email, and after **publish** Craigslist
emails a confirmation link: the posting goes live only when it is clicked, and
renew / delete then need the link from that email. So lister requires a
logged-in profile for live runs (`NeedsHumanError` → account NEEDS_LOGIN), and
uses the account home (`accounts.craigslist.org/login/home`) to read posting
ids and to renew / delete. **Dry runs work without a login** (a logged-out
profile with no `contactEmail` uses the placeholder `lister-dry-run@example.com`
on the form; nothing is ever published on a dry run).

Owner, once:

```bash
npm run account:login -- cmws4ncod0000rogd6keowgn8   # headed Chromium on DISPLAY :2 (LISTER_DISPLAY)
# log in at accounts.craigslist.org (create the account there if needed), approve the
# emailed code if asked, then CLOSE the window. The check runs and records the account email.
```

## Settings (per account; console → Edit, or `npm run account:settings -- <id> '<json>'`)

```json
{ "contactEmail": "you@example.com", "replyVia": "relay", "chat": false,
  "area": "rdu", "subarea": null, "city": "Durham", "postal": "27701",
  "pacing": { "perHour": 1, "perDay": 6, "renewAfterHours": 48 } }
```

Replies arrive by email through the **CL mail relay** (`Privacy=C`, the form's
default: the address is never published). Phone and CL chat are off unless set.
Pacing holds a live create back (status QUEUED, `lastError` says until when)
and re-queues it for that time; renew earlier than `renewAfterHours` after the
post / last renew is refused. Per listing, callers may pass
`craigslist: { area, subarea, category }` (contract v1.2).

Mark sold and remove both **delete** the posting (Craigslist has no "sold"
state); the listing becomes SOLD or REMOVED accordingly.

## Not yet seen live (verify on the first real posting)

The account home's table and the page after a logged-in publish were not
visible without a login. They are read by their form actions
(`…/manage/<postingId>`) and posting URLs (`…/<postingId>.html`);
`test/fixtures/cl-account-home.html` is a RECONSTRUCTED shape. After the
owner's first live test posting, save the real account home over it
(`page.content()`), and run the renew/delete dry runs below.

# Mark sold / remove / renew dry runs on the owner's own test listing

Never run these against listings lister did not create. Once the owner's live
test listing exists (created through lister, so it has a `platformListingId`):

1. Put the account back in dry run: `npm run account:live -- <accountId> off`
   (or "Back to dry run" in the console).
2. `npm run listing:run -- <listingId> markSold` (and `remove`, `renew` for
   Craigslist), or the listing's buttons in the console.
3. The run walks to the final click and stops; the listing stays LIVE with
   `lastError: "dry run: stopped …"`. Screenshots: `data/runs/<listingId>/<time>/`
   and the console. Facebook remove goes as far as Facebook's "Delete listing?"
   confirmation and cancels it; Facebook mark sold stops before the card's
   "Mark as sold" button (Facebook has no confirmation before it).
4. Only the owner then flips the account live and repeats it for real.
