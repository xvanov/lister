# CLAUDE.md — lister

Read this whole file first; it is short on purpose. `docs/guide.md` is the
template's full brief (layout, architecture rules, traps); this file adds what
is specific to lister.

## What this is

A service other apps call to **post items for sale on Facebook Marketplace**
(Craigslist next), **mark them sold** and **remove** them, by driving a
logged-in Chromium profile per seller account. Multi-tenant (every row is
org-scoped) and multi-account. It knows nothing about buyer conversations
(that is communicator). The API contract shared with garage-saler and
communicator is **docs/CONTRACTS.md** (canonical copy): never change a shape
without changing all three repos.

```
packages/lister        contract shapes, API keys, webhook signing, listing state (web-safe)
packages/lister/src/runner   Playwright side, WORKER ONLY: profiles, click guard,
                       Facebook adapter, fake adapter, screenshots
packages/api/src/routers/external.ts   external.v1 (API-key callers)
packages/api/src/routers/lister.ts     the operator console's API (/app/lister)
packages/jobs/src/lister.ts            listing.run, webhook.deliver, account.check
apps/web/src/app/api/v1/photos         multipart photo upload (Bearer)
apps/worker/src/cli/account.ts         npm run account:{list,login,check,live,headless}
apps/worker/src/cli/fb-probe.ts        dev: dump the create form's controls
```

Ports: **web 3240 · postgres 5502 · redis 6449 · mailpit 1097/8097 · test
mailpit 1098/8098**. Compose project `lister`.

## Running it

```bash
./scripts/setup.sh && npm run lister:seed   # first time
make dev                                    # dev: web :3240 + worker
scripts/service.sh install                  # persistent: systemd --user lister-web + lister-worker
scripts/service.sh deploy | logs [web|worker] | stop | status
```

## Gates — all green before anything is "done"

```bash
make typecheck && make lint && make test && make smoke
```

`make smoke` drives lister's journey too (`apps/web/e2e/lister.spec.ts`):
sign up → add account → create API key → upload photo → listings.create →
worker → DRY_RUN_OK → signed webhook received. The gate's worker runs with
`LISTER_BROWSER_DRIVER=fake`: it never opens a real marketplace.

## Rules specific to lister

1. **Dry run is the default.** `SellerAccount.liveMode=false` walks the whole
   form, screenshots every step and stops before Publish / Mark as sold /
   Delete. Only the owner flips an account live (`npm run account:live -- <id> on`
   or the console). Never flip it in code, tests or scripts.
2. **Every click goes through `guardClick`** (runner/guard.ts). Spending and
   promotion labels (boost, promote, pay, buy...) are refused always; publish /
   delete / mark-sold labels only on a live run AND only when named as the
   action's final step.
3. **One browser per account.** A Chromium profile dir cannot be opened twice.
   Every browser job (and `account:login` / `account:check`) holds the Redis
   lock `lister:account-lock:<accountId>`; never launch a profile without it.
4. **listing.run is never retried by the queue** (`attempts: 1`, failures are
   UnrecoverableError): a retried create could post twice. Callers retry with
   `listings.retry`. Webhooks ARE retried (8 attempts, exponential), each
   attempt counted in `webhook_delivery`.
5. **Playwright only loads in the worker.** `@repo/jobs` imports the runner
   with a dynamic `import()`, and `next.config.ts` lists playwright in
   `serverExternalPackages`. A static import of `@repo/lister/runner` from
   anything the web app imports would drag Chromium into the Next bundle.
6. **Secrets live only in `.env`** (gitignored): `LISTER_API_CLIENTS` (JSON in
   single quotes; keys map to an org by slug), `LISTER_WEBHOOK_SECRET`. Never
   print them. Browser profiles under `data/profiles/` are logged-in sessions:
   `data/` is gitignored; never copy a profile somewhere shared.

## Things that will bite you (learned here)

- **The Facebook "Item for sale" form has THREE pages now**, not two:
  details → `?step=delivery` (Location, delivery method) → `?step=audience`
  ("List in more places": Marketplace + group checkboxes, then Publish). The
  adapter presses Next until a Publish button exists (max five pages).
- **The create page renders a skeleton first.** Wait for
  `input[type=file][accept^="image/"]`, not for a fixed delay or `load`.
  `page.goto` with `domcontentloaded` timed out headless; use `waitUntil: "commit"`.
- **Category and Condition are `label[role=combobox]`** with accessible names;
  `getByRole("combobox", { name })` finds them, `label` + `hasText` does not.
- **"Boost listing after publish" is a switch on page 1.** It must be OFF
  (`ensureBoostOff`); a live run refuses to publish if it cannot turn it off.
- **Location typeahead finds nothing for "Durham, NC"** but does for "Durham":
  the adapter types with real keystrokes, falls back to the part before the
  first comma, and picks the first `[role=option]`. With nothing picked, Next
  stays disabled.
- **The listing id after publish is not in the URL.** Facebook lands on
  /marketplace/you/selling; ids come from the page's JSON (inline
  `application/json` scripts + `/api/graphql/` responses). The new one is the
  active listing with our exact title that was not there before Publish.
  Duplicate titles on one account make it ambiguous (and break mark-sold, which
  finds the card by title): keep titles unique per account.
- **Session check = the `c_user` cookie equals `externalAccountId`.** A profile
  logged into a different Facebook user is NEEDS_LOGIN, not READY.
- **Headed runs need `LISTER_DISPLAY`** (`:2` on this desktop; systemd user
  units have no DISPLAY). Headless works for Facebook today.
- **The profile was copied once from rental-media.** Do not touch
  rental-media, its containers or its data: lister owns its own copy in
  `data/profiles/facebook-100022296936546`.
- Smoke overrides go after `.env` is sourced (`set -a`), with explicit
  `export`s; see the template's note on `${VAR:-fallback}` never applying.
