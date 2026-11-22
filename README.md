# Lister

_What this app is, in a sentence._

**Needs:** Node ≥ 22 and Docker.

```bash
./scripts/setup.sh     # .env, dependencies, Postgres + Redis + mail inbox, migrations
make dev               # web on http://localhost:3240 + the background worker
```

Sign up with any email; the confirmation link lands in the local inbox at
http://localhost:8097. `make` lists every command.

## Before you push

```bash
make typecheck && make lint && make test && make smoke
```

## Docs

- [docs/guide.md](docs/guide.md): how it is built, the rules, the traps
- [docs/deploy.md](docs/deploy.md): production on one Docker host
