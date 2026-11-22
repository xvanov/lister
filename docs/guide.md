# Guide — how this codebase works

Read this whole file before changing code; it is the full brief. Do not go
exploring to answer questions it already answers.

## What this is

The starting point for an app: one backend serving every surface over a typed
API. Everything here already runs — if something does not work, that is a
bug, not an unfinished feature.

```
apps/web       Next.js 16 (App Router) — the UI *and* the API (/api/trpc, /api/auth)
apps/worker    BullMQ worker + cron schedules (separate process on purpose)
packages/api   tRPC routers — the ONLY API surface, shared by every client
packages/db    Prisma schema + client (Postgres)
packages/auth  better-auth: email+password, Google OAuth, organizations
packages/jobs  job registry + queue + schedules
packages/domain  domain functions (input rules + writes) shared by tRPC routers (and agent tools)
packages/storage  file storage: local disk or any S3-compatible bucket
packages/email  outbound email (SMTP by default, or Resend), ONLY via the outbound guard. Mailpit locally
packages/outbound  the outbound guard: every outbound message passes it and is logged
packages/notify  operator alerts (ntfy push, else email, else console), deduped + digested
packages/security  rate limiting, cron/webhook auth, AES-GCM sealing of stored secrets
packages/env   the validated environment — import `env()`, never `process.env`
```

## First run

```bash
./scripts/setup.sh     # .env + deps + postgres/redis + migrations. Idempotent.
make dev               # web on :3240 + the worker
```

Sign up with any email and an 8+ character password. Google sign-in appears only
once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set; email/password always works.

Ports are non-default so this coexists with other projects:
**web 3240 · postgres 5502 · redis 6449**.


## The gates — run these before claiming anything works

```bash
make typecheck    # tsc --noEmit across every workspace
make lint
make test         # unit + integration tests (vitest). Needs Postgres: `make up`
make smoke        # THE GATE: production build, booted, driven in a real browser
```

`next build` does NOT type-check (`typescript.ignoreBuildErrors` in
`apps/web/next.config.ts`): `make typecheck` is the type gate, and checking
twice cost ~7s on every smoke run and Docker build. So a green smoke alone does
not mean the types are clean — run both.

`make test` runs two kinds of test. `*.test.ts` are unit tests: no database,
run anywhere. `*.int.test.ts` hit real Postgres: once per run,
`packages/db/testing/global-setup.ts` creates a throwaway schema `vt_<ts>_<hex>`
in the dev database, applies each migration's SQL into it in order (~40 ms in
all), and drops it afterwards; `public` is never touched. If Postgres is down
and the tests actually execute, the run FAILS with "start it with `make up`";
it never silently skips. Caveat: turbo replays a cached pass when nothing
changed, without running anything, so a green `make test` does not prove
Postgres is up. `npx turbo run test --force` re-runs for real.
`TEST_DATABASE_URL` points it at another database (CI does).
`npm run test:unit -w @repo/api` runs only the DB-free tests.

**Writing an org-isolation test** (do this for every new org-scoped model), in
`packages/api/test/<thing>.int.test.ts`; `tenant-isolation.int.test.ts` is the
reference:

```ts
const a = await createTenant("a"); // from @repo/db/testing: user+org+session
const b = await createTenant("b");
const row = await callerFor(a).things.create({ ... }); // ./caller: real router
expect(await callerFor(b).things.list()).toEqual([]);  // B sees nothing of A's
await expect(callerFor(b).things.remove({ id: row.id }))
  .rejects.toMatchObject({ code: "NOT_FOUND" });       // nor can B change it
```

Each `createTenant` is unique, so test files share the schema and still run in
parallel. Assert only on what a tenant can see; never on global row counts.

`make smoke` is the one that counts. Unit tests pass on an app that does not
boot; the smoke gate builds for production, boots the standalone server **and
the worker** on an isolated port against real Postgres and Redis, and drives
sign-up → create → reload → a worker job → sign-out through Chromium. It fails
if either process dies during boot or during the run, and prints the tail of
both logs on any failure. It runs **every** e2e test (no tag filter), so a new
test in `apps/web/e2e` is in the gate automatically. **Nothing is "done" until it is green.** CI runs
this same script (`.github/workflows/ci.yml`) — change the script, never
re-inline its steps in the workflow.



## Production

One Docker host, documented in `docs/deploy.md`: `docker-compose.prod.yml`
plus `scripts/deploy.sh` (`deploy`/`rollback`/`status`), `scripts/backup.sh`,
`scripts/restore.sh`, and the systemd templates in `ops/systemd/`.
`make test-ops` runs the migration-guard unit test, the deploy self-exec
test, a real reproduction of collation corruption and its repair, and a
backup/restore round trip (about 30s).

`make lint` shellchecks every script (`SHELL_SCRIPTS` in the Makefile).

## Architecture rules (a reviewer should reject violations)

1. **The API is tRPC in `packages/api`.** Add a procedure there, not a Next route
   handler. Route handlers exist only for things tRPC cannot carry: auth
   (`/api/auth/[...all]`), file bytes (`/api/media/*`), health (`/api/health`),
   and machine callers authenticated by a secret instead of a session: cron
   triggers (`/api/cron/[schedule]`, `requireCronAuth`) and provider webhooks
   (`/api/webhooks/*`, signature over the raw body). Copy those. A webhook
   verifies, stores, and hands slow work to a job; it never does that work in
   the request. The webhooks and other secret-authenticated routes:
   - `email-events`: Resend via `verifySvix`, or generic `verifyHmac`
2. **Tenant isolation lives in `orgProcedure`, not in resolvers.** Any query on
   an org-scoped table goes through `orgProcedure` and filters on
   `ctx.organizationId`. Mutations use `updateMany`/`deleteMany` with the org in
   the `where`, never `update`-by-id plus a separate ownership check.
3. **`env()` from `@repo/env`, never `process.env`.** It validates once and fails
   with a readable message. Node entrypoints start with `import "@repo/env/load"`.


5. **Slow or failable work goes to `packages/jobs`**, not into a request. Every
   run is recorded in `job_run` — Redis is ephemeral, that table is not. Each
   registry entry declares `scope: "org" | "system"`, and the compiler holds it
   to the payload schema: an org job's schema must have a required
   `organizationId: string`, a system job's must not have one. The worker stamps
   the run's owner from the validated payload; system runs are owned by nobody
   and shown to no tenant. A tenant's job whose org was deleted while queued is
   recorded as `skipped` and not run.
6. **Auth schema belongs to better-auth.** After changing plugins in
   `packages/auth`, run `npm run auth:schema` and diff before migrating.
7. **Shared packages export TypeScript source**, no build step. Next transpiles
   them (`transpilePackages`); Metro sees them via `watchFolders`.
8. **Every outbound message goes through the guard** (`deliver` in
   `packages/outbound`). Each provider is reachable from ONE file, its
   channel's transport (ESLint rules in `eslint.boundaries.mjs` fail `make
lint`; wiring tests back them up):
   - `email`: `sendMail` from `@repo/email`; mail SDKs (nodemailer, resend) and
     `RESEND_API_KEY` only in `packages/email/src/transport.ts`.
   - `push` (ntfy): only via `notifyOperator` from `@repo/notify`;
     `NTFY_URL`/`NTFY_TOKEN` only in `packages/notify/src/ntfy.ts`.


   A new channel gets its own package that calls `deliver` and does not
   export its raw transport, plus a `Channel` value, a recipient parser and an
   enable flag in the same change. (The guard's policy already knows `sms` and
   `mobile_push`, switched off, whether or not their packages are in this
   app.) Transports refuse the real SDK under `NODE_ENV=test`; tests install a
   fake (`useFakeResend`, and each channel's own).

9. **Mutations write an audit event in the same transaction**:
   `ctx.db.$transaction(async (tx) => { ...; await ctx.audit("item.delete", { targetId }, tx) })`.
   `packages/api/src/routers/items.ts` is the reference.
10. **Expected failures throw typed errors** from `packages/api/src/errors.ts`
    (`NotFoundError`, `DomainRuleError`, `ConflictError`, `ForbiddenError`);
    the API maps them to NOT_FOUND / BAD_REQUEST / CONFLICT / FORBIDDEN with
    their message, which the user sees. Anything else is a 500 whose message
    and stack are hidden in production. Plain route handlers get the tenant
    from `requireTenant(req)` (`apps/web/src/lib/route-auth.ts`), which shares
    `orgProcedure`'s resolution — including the check that the user is STILL
    a member of the session's active org (better-auth does not clear it when
    an admin removes someone).
11. **File access is scoped to the ACTIVE org**, like every other read: the
    `/api/media` routes serve only the active tenant's files, never "any org
    the user belongs to". Deliberate; a user in two orgs switches org to see
    the other's files.

## Outbound messages and safe mode

Exists because a production app emailed the wrong thing to 8 real customers.
`deliver()` runs these gates in order; the first that fails blocks the message:

0. recipient: exactly ONE plain address. Lists (`a@x, b@y`), display names
   (`Name <a@x>`) and anything else a mail library would expand are blocked as
   `INVALID_RECIPIENT`; the parsed address is what gets checked, capped,
   logged, and handed to the transport. SMS: one number in international
   form, normalised to E.164 (`+44 7700 900123` → `+447700900123`); a
   national number (`07700 900123`) is refused, never guessed at. Mobile
   push: one Expo push token (`ExponentPushToken[...]`), case kept.
1. channel switch `OUTBOUND_EMAIL_ENABLED` (on), `OUTBOUND_PUSH_ENABLED` (on),
   `OUTBOUND_SMS_ENABLED` (OFF), `OUTBOUND_MOBILE_PUSH_ENABLED` (OFF)
2. kill switch: `OUTBOUND_FROZEN=true`, or at runtime with no restart:
   `npm run outbound:freeze -- on` / `off` / `status` (stored in `app_setting`)
3. **safe mode**, resolved once per process and printed loudly at boot:
   - `strict`: only `OUTBOUND_SAFE_RECIPIENTS` (addresses, `@domain`, exact
     E.164 numbers) get anything; everything else is blocked and logged.
   - `local-catcher`: everyone is allowed. Only via an explicit
     `OUTBOUND_SAFE_MODE=local`, which asserts SMTP is a catcher (Mailpit) that
     delivers nowhere. `.env.example` sets it, so `make dev` just works. It is
     never inferred from a loopback `SMTP_HOST` (a local postfix relays to the
     internet), and production refuses it and runs strict. It opens EMAIL
     only: SMS, push and mobile push have no catcher (they reach real
     phones), so for them it means strict.
   - `off`: real mail to real people (`OUTBOUND_SAFE_MODE=false`, or unset in
     production).

   Unset outside production = `strict`, so a staging box loaded with
   production data cannot mail a customer.

4. suppression list (`outbound_suppression`: global for hard bounces and
   complaints, fed by `/api/webhooks/email-events`; per-org for
   unsubscribes).
5. volume caps in Redis: per recipient/hour, per org/hour and /day, and a
   global/hour, with SEPARATE global pools for auth mail and app mail so a
   flood of anonymous sign-ups cannot starve tenants' mail. Redis unreachable =
   **blocked** (fails closed).

Every attempt writes one `outbound_message` row, BEFORE the provider is
called, so nothing leaves without a record. Blocked sends resolve with
`status: "blocked"` (they do not throw); provider errors throw after being
recorded as `failed`. If the provider accepted a message but recording "sent"
fails, it still returns sent (the row stays `pending`) so a retry cannot send
it twice. Tenants read their own rows via `activity.outbound`.

**Retries and idempotency.** Pass `idempotencyKey` (`invoice.42.reminder`)
from anything that retries. Keys are per tenant (system rows share one
namespace). A second `deliver` with the same key reuses the first row: once
sent, it is returned untouched; while another attempt holds it (`pending`,
claimed under 5 minutes ago) it returns `status: "in_progress"` and sends
nothing; otherwise (failed, blocked, or a stale pending) it takes the row with
a compare-and-set, so of any number of racing retries exactly one sends. The
same key for a different channel or recipient throws `ConflictError`
(CONFLICT) and sends nothing. An attempt's final write ("sent"/"failed") only
applies while it still holds its claim, so a sender slow enough to be taken
over cannot overwrite the retry's outcome. If the provider accepted a message
but marking it sent failed, the row stays `pending`, and a keyed retry
re-sends it once the 5-minute window has passed (SMTP and Twilio cannot tell
us they already have it; Resend drops the repeat by its key). A send reuses
the row id, which the transport hands the provider (Resend's
`Idempotency-Key`; every email's `Message-ID` is `<obm.<row id>@<from
domain>>`, which is how replies are threaded). SMTP and Twilio take no key, so
a crash between their accepting a message and our marking it sent can still
duplicate one.

**Delivery status.** `status` is the guard's verdict ("the provider took
it"). What happened next is `deliveryStatus` (`delivered`, `bounced`,
`undelivered`, `complained`, ...), written by the Resend and Twilio webhooks by
provider message id and never moved backwards (`recordDeliveryStatus`).

**Operator messages vs safe mode.** `notifyOperator` sends with
`operator: true`, which is exempt from the strict allowlist ONLY when the
recipient is exactly the configured `NTFY_TOPIC` / `OPERATOR_EMAIL` (the guard
checks it, not the caller). Kill switch and suppression still apply; the
verified operator skips the per-recipient cap (an urgent alert must not stop at
the 11th of the hour) and counts in its own `operator` global pool.
`sendOperatorMail` takes no `to`: it can only mail `OPERATOR_EMAIL`. They are recorded with `organizationId` null,
so no tenant sees them (or the topic). `local` safe mode opens email only: a
push reaches a real phone, so push stays strict. A staging box with
production's `NTFY_TOPIC` alerts production's operator: every title is
prefixed with the `APP_URL` host (`[staging.example.com] …`) so the two can be
told apart, but give staging its own topic.


**Auth mail vs safe mode.** better-auth's verification mail is sent with
`sendAuthMail`, which is exempt from the strict allowlist and nothing else.
The recipient just typed that address into the sign-up form, so it cannot be
"the wrong person", and without the exemption nobody could sign up on a
strict box. The kill switch, suppression and caps still apply. Use
`sendAuthMail` for better-auth callbacks only. `make smoke` forces safe mode
to `strict` with an empty allowlist, so the gate proves sign-up still works.


**Every webhook** caps its body while streaming (`readBodyLimited`) BEFORE
any signature work, then verifies the signature. Only requests whose
signature FAILED are rate-limited per IP (`refuseUnsigned`, fails open): the
IP is X-Forwarded-For, which an attacker can set to the provider's, so
throttling all traffic would let anyone 429 real callbacks (a lost opt-out is
not retried).

## Operator notifications

`notifyOperator({ title, body, priority, dedupeKey?, url?, tags?, organizationId? })`
from `@repo/notify` tells whoever RUNS the app (not tenants) about something:
wired today for a job that failed for good (worker, high, one per job name per
window) and new sign-ups (low, digest only). It never throws.

- Every call writes a `notification` row; the send is also an
  `outbound_message` row. Same `dedupeKey` within
  `NOTIFY_DEDUPE_WINDOW_MINUTES` (or the call's `dedupeWindowMinutes`) =
  `deduped`, but only when the earlier one reached the operator (sent, logged,
  held, digested, or in flight for under 2 minutes): a failed alert never
  silences its repeat.
- Channel: ntfy push if `NTFY_TOPIC`, else email to `OPERATOR_EMAIL`, else
  the console. Titles go out prefixed with the `APP_URL` host. **No customer
  data in titles or bodies**: on ntfy.sh the topic is the only password. Ids,
  counts, error classes.
- `low` waits for the digest at `NOTIFY_DIGEST_TIMES` (APP_TIMEZONE); the
  rest is sent at once (`normal`/`high`/`urgent` only change ntfy's loudness).
  The `operator.digest` job runs every 15 minutes: it retries high/urgent
  alerts the volume cap held, then sends the digest if one is due. A digest
  that is not delivered is marked failed and gives its items back to the next
  slot. No quiet hours or daily budget (cut: not worth it at this volume).
- No UI: there is no app-wide operator role, and tenant admins must not see
  them. Read the table directly.
- `make smoke` forces the console channel and checks sign-up logged one.




## UI (apps/web)

**Use the kit; do not hand-roll.** Every button, input, modal, menu, table and
toast comes from `apps/web/src/components/ui/` — shadcn/ui (new-york style,
neutral base colour, CSS variables), copied into the repo so you own the code.
See every component rendered at **`/design`** (public, static, noindex; source
in `src/app/design/styleguide.tsx` doubles as usage examples).

- **Where things live.** `components/ui/*` = the kit (shadcn files plus our
  `data-table`, `states` (loading/empty/error/`FieldError`), `file-drop`,
  `confirm-dialog`). `components/app-shell.tsx` = the signed-in sidebar +
  header (add nav entries to `NAV`). `lib/utils.ts` = `cn()`. Theme tokens =
  `:root` / `.dark` in `src/app/globals.css` — re-skin there, not per component.
- **Add a shadcn component:** `cd apps/web && npx shadcn@4.23.0 add <name>`
  (reads `components.json`). Recent registries import `cn` from a separate
  `cn` npm package (pre-1.0); this repo keeps `cn` in `@/lib/utils`
  (clsx + tailwind-merge, like the production apps), so point the import back:
  `sed -i 's#from "cn"#from "@/lib/utils"#' src/components/ui/<name>.tsx` and
  `npm uninstall -w web cn` if the CLI added it. Then pin any new dependency
  exactly in `apps/web/package.json`, run `npx prettier --write src` and
  `make lint` (the React Compiler lint rules flag a few upstream files — fix
  them, see `hooks/use-mobile.ts`), and add the component to `/design`.
- **Dark mode** is next-themes, class-based (`dark:` follows the user's choice).
  The root layout must keep `<html suppressHydrationWarning>`; that is what lets
  the inline script set the class before first paint (no flash). `ThemeToggle`
  is a plain button on purpose.
- **Forms:** react-hook-form + the kit's `Form*` components. In client code
  validate with named imports from `zod/mini` (see `login-form.tsx`): classic
  `zod` adds ~60 kB gzipped to the page. Server code keeps classic zod. Keep
  labels visible (`FormLabel`).
- **Prisma enums in client code:** `import { X } from "@repo/db/enums"` —
  plain objects, no Prisma client in the bundle (verified against a real
  build). Never import `@repo/db` from a `"use client"` file.
- **Every query-backed panel** renders exactly one of `LoadingState` /
  `ErrorState` / `EmptyState` / data. Mutations report with `toast` (sonner).
- **Formatting:** never `toLocaleString` ad hoc. `useFormat()` (client, from
  `components/format-provider.tsx`) or `getFormatter()` (server,
  `lib/format-server.ts`) — locale, currency, timezone come from `APP_LOCALE`,
  `APP_CURRENCY`, `APP_TIMEZONE`. Money is integer minor units (cents).
  `useFormat()` only sees the env config under `/app` (its layout provides it);
  elsewhere it falls back to en-US · USD · UTC.
- **Auth guard, two layers:** `src/app/app/layout.tsx` redirects without a
  session, AND every `/app` page (and any server-side data access) calls
  `requireSession()` from `lib/session.ts`. The layout alone is not enough:
  Next renders layouts and pages in parallel and can skip a layout on client
  navigation. The lookup is `cache()`d per request, so repeating it is free.
- **The root layout reads nothing per request** (no `env()`, no cookies) so
  static pages like `/design` prerender and the Docker build needs no secrets.
  It also mounts no `<Toaster>`: the `/app` layout and `/design` do, so sonner
  stays off the public pages. A new page tree that toasts mounts its own.
- **Deleting `/design`?** Delete `e2e/design.spec.ts` with it; nothing else in
  the gate depends on it.
- **Bundle:** watch first-load JS when adding client libraries; Radix menus,
  popovers and tooltips pull in positioning code — keep them off public pages
  that do not need them.



## Running it

### Email confirmation

Sign-up requires confirming the address, and it works with **no third-party
account**: `docker compose up -d mailpit` runs a real SMTP server locally, and
every message lands in its inbox at **http://localhost:8097**. Sign up, open the
inbox, click the link — you are verified and signed in.

`scripts/setup.sh` starts it, and the end-to-end suite reads the message out of
Mailpit's API and opens the real link, so the confirmation flow is part of the
merge gate rather than something you hope still works.

The suite uses a **second, throwaway catcher** (`mailpit-test`, ports 1098/8098),
never your dev inbox. Its links point at the gate's isolated port and stop working
when the run ends, so letting them pile up in your inbox would make working mail
look broken.


Two honest limits:

- **Mailpit shows mail; it never delivers it onward.** It is an inbox for you and
  your tests, not for your users. To reach real inboxes, point `SMTP_*` at an
  SMTP relay. (Self-hosting an MTA that strangers' servers accept is a
  deliverability project — SPF, DKIM, DMARC, reputation — and outbound port 25 is
  usually blocked anyway.)
- **Verification links are built from `APP_URL`.** If that says `localhost` the
  link is unclickable on a phone. Set it to the origin your users actually reach.

With `SMTP_HOST` unset the message is printed to the server console instead, so a
fresh clone still runs and you can copy the link out of the terminal. Set
`REQUIRE_EMAIL_VERIFICATION=false` to let unconfirmed accounts sign in — but
that means anyone can register an address they do not own.

### Reaching it from anywhere (Tailscale)

Wifi works out of the box. To reach the app from off the LAN — and to get real
HTTPS, which Google OAuth requires for any non-localhost redirect — put it behind
Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3240
tailscale serve status          # confirm you did not overwrite another mapping
```

That publishes `https://<machine>.<tailnet>.ts.net:8443`, tailnet-only, with a
valid certificate.

Two things must then be true:

- **Pick a port nothing else is serving.** `--https=443` is the obvious choice
  and also the one most likely already taken by another project on the same
  machine; `tailscale serve status` before and after is the check.
- **Add the origin to `TRUSTED_ORIGINS`** in `.env` (comma-separated), both the
  HTTPS name (and the raw `http://<tailscale-ip>:3240` a phone uses). Without it
  every sign-in fails with "Invalid origin" — that check is a CSRF boundary, so
  add the origin rather than relaxing it. Recreate the containers afterwards
  (`docker compose --profile full up -d --force-recreate web worker`); `env_file`
  is read at container creation.

The same list also feeds the dev server's `allowedDevOrigins`: `next dev`
refuses its scripts to hosts it does not know, so a page opened on the Tailscale
name renders but never hydrates. Restart `make dev` after editing `.env` — the
Next config is read once at startup.


`tailscale serve` is tailnet-only. `tailscale funnel` would expose it to the
public internet — do not reach for that to test a phone.

### Google sign-in

Optional — email/password works with no external setup. To enable it, create an
OAuth client at
[console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
(type: Web application), add these redirect URIs, and put the two values in
`.env`:

```
http://localhost:3240/api/auth/callback/google
<your public https origin>/api/auth/callback/google
```


## Things that will bite you (all learned here, the hard way)

- **A database image with another C library silently corrupts text
  indexes.** Existing volumes sort text with the image's libc; reopened under
  a different one (Alpine/musl ↔ Debian/glibc), lookups miss rows and unique
  indexes admit duplicates — after which the fixing REINDEX itself fails.
  `scripts/lib/collation.sh` + `packages/db/prisma/ops/collation-guard.sql`
  detect it (stored vs actual collation version) and rebuild. They run from
  `make up` and `setup.sh` and from the `migrate` image before every
  migration. New volumes use the builtin `C.UTF-8` collation
  (`POSTGRES_INITDB_ARGS`), immune to libc. The db image is now
  `pgvector/pgvector` (Debian, glibc) instead of `postgres:17-alpine` (musl)
  — exactly this change for every existing volume. If a rebuild fails
  (duplicates already written), its error names the index and the key: merge
  or delete the extra rows and run `bash scripts/lib/collation.sh` again, or
  restore a dump taken before the image change.
  In production `deploy.sh` runs them too (app stopped first when the db
  image changes, and on every deploy and rollback), and re-execs itself
  after pulling so a release is always deployed by its own script. Details
  and the by-hand production fallback: `docs/deploy.md`.
- **Blank `*_URL=` lines are deleted from `process.env`** by `@repo/env`
  when it loads: an SDK that builds a default client from its base-URL
  variable at import (`@ai-sdk/openai` did) crashes the server on a blank
  value (a copied `.env.example`). Import `@repo/env` before any SDK that
  reads the environment itself.


- **`output: standalone` does not copy static assets.** Boot it without copying
  `.next/static` next to `server.js` and the app serves HTML, every JS chunk
  404s, nothing hydrates. `scripts/smoke.sh` and the Dockerfile both do it.
- **Never pin an absolute `baseURL` in the web auth client.** Same-origin is
  correct; a build-time origin breaks every preview URL, tunnel and test port.
- **"Invalid origin" on sign-in** means the origin is not in better-auth's
  `trustedOrigins`. Set `APP_URL` truthfully, or add to `TRUSTED_ORIGINS`
  (comma-separated). Do not loosen the check — it is a CSRF boundary.
- **"Too many requests" in tests** is the auth rate limiter doing its job. Raise
  `AUTH_RATE_LIMIT_MAX` for the load generator; never disable it.
- **A new account's first session has no `activeOrganizationId`** — sign-up
  creates the session before the membership exists. `orgProcedure` repairs it on
  first use; do not "fix" this by removing the fallback.


- **Sign-up requires email confirmation** (`REQUIRE_EMAIL_VERIFICATION`, on by
  default), so sign-up returns NO session. Code that assumes a session right
  after `signUp.email` is wrong — check `result.data.token` and show the
  "confirm your email" state. The e2e suite opens the real emailed link via
  Mailpit's API; `docker compose up -d mailpit` must be running for it.
- **Verification links are built from `APP_URL`.** A `localhost` value emails an
  unclickable link to a phone. Set it to the origin users actually reach.
- **The gate boots the worker, so a worker that crashes fails the merge.** It
  waits for the `[worker] up` line; keep that log line if you touch
  `apps/worker/src/index.ts`. The journey clicks "Summarise items in the
  worker" and waits for `✓ items.summarize`, so a job that fails or is never
  picked up is red too. The gate puts logs and `STORAGE_LOCAL_DIR` in a fresh
  `mktemp -d` dir, kept and printed on failure.
- **The Dockerfiles build from `turbo prune <app> --docker`**, so each image
  holds only its app and the workspace packages it imports, and `npm ci` runs
  on manifests alone (source edits reuse that layer). Prune does NOT carry
  root-level files: `tsconfig.base.json` is copied explicitly. A new root file
  the build needs must be added there too, or the image build fails.
- **The gate has its OWN mail catcher** (`mailpit-test`, :1098/:8098) separate
  from the dev inbox (:1097/:8097). Its links point at the gate's isolated port
  and die with the run, so mixing them into your inbox makes real mail look
  broken. Keep them apart.
- **`.env` is sourced with `set -a` at the top of smoke.sh**, so every variable in
  it is already exported by the time the server is launched. A
  `${SOME_VAR:-fallback}` default therefore NEVER applies — that is why the gate's
  overrides use distinct `SMOKE_*` names. Watch for this whenever you add one.
- **Quote `.env` values containing `< > | &`.** `scripts/smoke.sh` sources the
  file with `.`, and an unquoted `<` is a shell redirect — `SMTP_FROM` is the one
  that bites. dotenv strips the quotes, so both readers are satisfied.
- **Exposing it over Tailscale needs two steps, not one.** `tailscale serve` gives
  you the URL; the origin must also go into `TRUSTED_ORIGINS`, and the containers
  must be recreated (`env_file` is read at creation, not on restart). Check
  `tailscale serve status` first — another project on the machine may already own
  the port you were about to claim. "Running it" above has the exact commands.
- **`next dev` only reads `.env` from `apps/web/`**, but the one `.env` lives at
  the root — so a bare `next dev` fails every render with "Invalid environment".
  `apps/web/scripts/with-root-env.mjs` loads the root file first (set variables
  win); the `dev`/`start` scripts go through it. The smoke gate never sees this
  because it exports everything itself. Do not "fix" it with a symlink.
- **The dev server blocks its own scripts on unknown hosts**, so a page opened
  over Tailscale or a LAN IP renders but never hydrates (forms submit as GET).
  `allowedDevOrigins` in `next.config.ts` is derived from the hostnames in
  `APP_URL` + `TRUSTED_ORIGINS` — add the origin there and restart `make dev`.
- **`STORAGE_LOCAL_DIR` is relative to each process's cwd**, which differs per
  entrypoint. The resolved root is logged at startup. `setup.sh` writes an
  absolute `<repo>/storage` into a NEW `.env` so web and worker share it (an
  existing `.env` is never rewritten; it prints a hint). The path is absolute,
  so **moving or re-cloning the repo leaves it pointing at the old place** —
  update it. The compose files override it with the container volume path.


- **"I sent an email and nothing arrived"**: look in `outbound_message` first.
  The row says whether it was sent, or which gate blocked it and why. The guard
  also prints `[outbound] BLOCKED ...` to the log.
- **Two Redis connections on purpose.** BullMQ's (packages/jobs) has no command
  timeout because workers block; the request-path one (packages/security) has a
  2s timeout so rate limits and caps fail fast. Do not merge them.
- **Rate limits fail open, outbound caps fail closed.** A limit that protects
  our capacity (`rateLimited` tRPC middleware) lets traffic through when Redis
  is down; one that protects other people (outbound caps) blocks. The counter
  store is in-memory only under `NODE_ENV=test`.
- **better-auth's rate limiter counts in Redis** (`customStorage` in
  packages/auth), shared by every web replica; `AUTH_RATE_LIMIT_*` still set
  the limits. better-auth consults it on EVERY `/api/auth/*` request (session
  checks included), so if Redis is down it falls back to a per-process memory
  limiter with a warning, rather than taking the whole app down.
- **OAuth tokens are encrypted at rest** (`account.encryptOAuthTokens`), keyed
  by `BETTER_AUTH_SECRET`: rotating that secret makes stored tokens unreadable
  and users must re-link Google.
- **Deleting an organization deletes its audit rows** (cascade). The deletion
  itself is recorded as a global `org.delete` audit event (organizationId null).
- **Machine-to-machine endpoints fail closed.** `requireCronAuth` /
  `verifyHmac` from `@repo/security` refuse every request in production when
  their secret is unset (outside production an unset secret is allowed).
  Third-party tokens at rest go through `sealSecret`/`openSecret`.


- **Rollback swaps code, not schema.** `deploy.sh` migrates forward before
  the swap, so a rolled-back image runs on the NEW schema. Migrations must
  keep the previous code working: add a column, backfill it, and drop the old
  one in a later deploy. `deploy.sh` refuses new migrations that drop, rename,
  retype or add NOT NULL unless `--allow-destructive`
  (`scripts/lib/migration-guard.sh`). Every deploy also takes a `pre-deploy`
  dump right before migrating.
- **Prod has two env files.** `.env.production` holds the app's settings and
  goes to the containers through `env_file` only; the scripts never source it.
  `.env.deploy` holds ops settings: `POSTGRES_PASSWORD`, `PROD_WEB_PORT` (not
  the dev `WEB_PORT`), `DEPLOY_*`, `BACKUP_*` and the tunnel token. It is
  sourced by the scripts and used for compose interpolation, and is never
  handed to the app. Pin `DEPLOY_PROJECT` there: the default `<dir>-prod`
  means renaming the directory points at new, empty volumes. Because
  `.env.deploy` is sourced with `set -a`, a value it sets beats an inline
  `VAR=x scripts/...` override.
- **`backups/` and `.deploy/` must stay in `.dockerignore`.** Without that,
  every image build ships the database dumps into the build context.
- **A deploy started from inside a systemd service must run in its own unit**
  (`scripts/deploy.sh --detach`, or `systemctl --user start <app>-deploy`).
  `setsid nohup` leaves it in the caller's cgroup; stopping the caller kills
  the deploy halfway.


## Renaming and trimming

The template's generator already renamed the app and removed the modules it
did not need (the list is in `.template.json`). Two consequences:

- **This app no longer tracks the template.** Its migrations are the
  template's with the removed modules' statements cut out, so a later
  template migration cannot be copied in verbatim: re-create the change in
  this schema with `npm run db:migrate`. Template fixes come over by hand.
- **Modules cannot be added later** by re-running the generator. To get one
  back, generate a throwaway app with it and port the module's files and
  marked lines (the template's module manifest lists them).

What it cannot do for you:


- **Icons**: `apps/web/src/app/icon.svg` and `apple-icon.png`.
- **Replace the `Item` model with your domain** — keep its `organizationId`
  column and index shape. `packages/api/src/routers/items.ts` is the
  reference resolver.
- **Keep the smoke test honest**: it should always drive _your_ core journey.

## Handing work to the software factory

This template is designed to be driven by `../software-factory` (see its
`CLAUDE.md`). To wire a new app built from it, copy `factory/config.yaml` to
`software-factory/apps/<app>/config.yaml` and adjust `repo`/`app_repo_path`. The
gate commands there are exactly the ones above, so the factory's merge gates and
your local gates cannot drift apart.
