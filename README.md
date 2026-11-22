# lister

Posts items for sale on Facebook Marketplace (Craigslist next), marks them sold
and removes them, by driving a logged-in browser profile per seller account.
Other apps call its API; the contract is [docs/CONTRACTS.md](docs/CONTRACTS.md).

**Needs:** Node ≥ 22, Docker, Playwright's Chromium (`npx playwright install chromium`).

## First run

```bash
./scripts/setup.sh       # .env, deps, Postgres + Redis + mail inbox, migrations
npm run lister:seed      # org "rentus" + the Facebook account (dry run)
make dev                 # web on http://localhost:3240 + the worker
```

Configure in `.env` (names documented in `.env.example`): `LISTER_API_CLIENTS`
(API keys → org slug + scopes), `LISTER_WEBHOOK_SECRET`, `LISTER_DISPLAY`.

## Running it persistently (this host)

```bash
scripts/service.sh install          # build + systemd --user units lister-web, lister-worker
scripts/service.sh deploy           # rebuild + restart after a code change
scripts/service.sh status
scripts/service.sh logs worker      # follow the worker (screenshot paths are logged here)
scripts/service.sh stop | start | restart | uninstall
```

Postgres and Redis are the `lister` docker compose services (`make up` / `make down`).

## Seller accounts

```bash
npm run account:list
npm run account:check -- <accountId>     # opens the profile, sets READY / NEEDS_LOGIN
npm run account:login -- <accountId>     # HEADED browser on the profile: log in, close it
npm run account:live -- <accountId> on   # REAL posting (Publish gets clicked). off = dry run
npm run account:headless -- <accountId> off
```

New accounts start in dry run: a create walks every page of the form,
screenshots each step and stops before Publish (status `DRY_RUN_OK`). The
operator console at http://localhost:3240/app/lister shows accounts, API keys,
listings, errors and screenshots (sign up there first; the seeded org has no
human member).

## Calling the API

```bash
curl -H "Authorization: Bearer $KEY" -F file=@photo.jpg http://localhost:3240/api/v1/photos
# → {"photoId":"..."}
curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"json":{"accountId":"...","externalRef":{"system":"garage","kind":"item","id":"42"},
       "title":"Oak table","description":"...","priceCents":5000,"category":"Furniture",
       "condition":"USED_GOOD","location":"Durham","photoIds":["..."],
       "callbackUrl":"http://localhost:3201/api/webhooks/lister"}}' \
  http://localhost:3240/api/trpc/external.v1.listings.create
```

tRPC with superjson: queries are `GET /api/trpc/<path>?input={"json":...}`,
mutations `POST` with body `{"json":...}`. Webhooks: `X-Signature:
sha256=<hex HMAC-SHA256 of the raw body>`, `X-Event-Id`, `X-Event-Type:
listing.status`.

## Before you push

```bash
make typecheck && make lint && make test && make smoke
```

## Docs

- [CLAUDE.md](CLAUDE.md): lister's rules and the lessons learned
- [docs/CONTRACTS.md](docs/CONTRACTS.md): the API contract (canonical)
- [docs/guide.md](docs/guide.md): the template's architecture brief
