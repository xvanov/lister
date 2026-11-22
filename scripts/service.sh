#!/usr/bin/env bash
# Run lister persistently on this host as two systemd --user services:
#   lister-web     the production build (standalone Next server) on WEB_PORT (3240)
#   lister-worker  the BullMQ worker (drives the browsers)
#
#   scripts/service.sh install   build, write the units, enable + start them
#   scripts/service.sh deploy    rebuild and restart (after a code change)
#   scripts/service.sh start|stop|restart|status
#   scripts/service.sh logs [web|worker]     follow the journal
#   scripts/service.sh uninstall
#
# The web build is copied to data/service/web so `make smoke` (which builds in
# apps/web/.next) can never clobber the running server. Both processes source
# .env the same way smoke.sh does. Postgres/Redis are the docker compose
# services (restart: unless-stopped).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
UNIT_DIR="${HOME}/.config/systemd/user"
DIST="${ROOT}/data/service/web"

build() {
  echo "→ infra"
  docker compose up -d --wait db redis >/dev/null
  echo "→ migrations"
  npm run db:deploy >/dev/null
  echo "→ production build"
  npm run build --workspace web >/dev/null
  echo "→ assembling ${DIST}"
  rm -rf "${DIST}.new"
  mkdir -p "$(dirname "$DIST")"
  cp -r apps/web/.next/standalone "${DIST}.new"
  cp -r apps/web/.next/static "${DIST}.new/apps/web/.next/static"
  [ -d apps/web/public ] && cp -r apps/web/public "${DIST}.new/apps/web/public"
  rm -rf "$DIST"
  mv "${DIST}.new" "$DIST"
}

write_units() {
  mkdir -p "$UNIT_DIR"
  cat > "${UNIT_DIR}/lister-web.service" <<UNIT
[Unit]
Description=lister web + API (production build, port 3240)
After=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=/bin/bash -c 'set -a; . ${ROOT}/.env; set +a; export PORT=\${WEB_PORT:-3240} HOSTNAME=0.0.0.0 NODE_ENV=production; exec node ${DIST}/apps/web/server.js'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  cat > "${UNIT_DIR}/lister-worker.service" <<UNIT
[Unit]
Description=lister worker (listing runs in Chromium, webhooks)
After=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=PATH=${ROOT}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -c 'set -a; . ${ROOT}/.env; set +a; exec node --import tsx apps/worker/src/index.ts'
# Let an in-flight browser run finish (worker.close() drains).
TimeoutStopSec=600
KillSignal=SIGTERM
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
}

case "${1:-}" in
  install)
    build
    write_units
    systemctl --user enable --now lister-web lister-worker
    systemctl --user --no-pager status lister-web lister-worker | grep -E "●|Active:"
    ;;
  deploy)
    build
    write_units
    systemctl --user restart lister-web lister-worker
    ;;
  start | stop | restart) systemctl --user "$1" lister-web lister-worker ;;
  status) systemctl --user --no-pager status lister-web lister-worker ;;
  logs)
    case "${2:-}" in
      web) journalctl --user -u lister-web -f ;;
      worker) journalctl --user -u lister-worker -f ;;
      *) journalctl --user -u lister-web -u lister-worker -f ;;
    esac
    ;;
  uninstall)
    systemctl --user disable --now lister-web lister-worker || true
    rm -f "${UNIT_DIR}/lister-web.service" "${UNIT_DIR}/lister-worker.service"
    systemctl --user daemon-reload
    ;;
  *)
    echo "usage: scripts/service.sh install|deploy|start|stop|restart|status|logs [web|worker]|uninstall" >&2
    exit 2
    ;;
esac
