#!/bin/bash
# Deploys the Compose stack following docs/onprem/compose.md, then runs e2e.mjs against it.
# Needs Docker and Node, and nothing else listening on 80, 443 or 8081.
set -euo pipefail
cd "$(dirname "$0")/../compose"
DATA=$(mktemp -d)
mkdir -p "$DATA/data" "$DATA/config/caddy/data" "$DATA/config/caddy/config" "$DATA/config/postgres" "$DATA/config/backups"
sudo chown -R 10001:10001 "$DATA/data"
# Caddy runs as root with no capabilities, so it can only write to folders root owns (as in the docs).
sudo chown -R 0:0 "$DATA/config/caddy"

cp .env.example .env
sed -i \
  -e 's|^SITE_HOST=.*|SITE_HOST=localhost|' \
  -e 's|^BOOTSTRAP_ADMIN_EMAILS=.*|BOOTSTRAP_ADMIN_EMAILS=admin@e2e.test|' \
  -e "s|^BACKFRIEND_DIR=.*|BACKFRIEND_DIR=$DATA|" \
  -e 's|^SMTP_HOST=.*|SMTP_HOST=smtp-sink|' \
  -e 's|^SMTP_PORT=.*|SMTP_PORT=1025|' \
  -e 's|^SMTP_FROM=.*|SMTP_FROM=noreply@e2e.test|' \
  -e 's|^SMTP_AUTH=.*|SMTP_AUTH=false|' \
  -e 's|^SMTP_STARTTLS=.*|SMTP_STARTTLS=false|' \
  -e 's|^SMTP_URL=.*|SMTP_URL=smtp://smtp-sink:1025|' .env
./gen-secrets.sh

dc() { docker compose -f docker-compose.yml -f ../test/compose.e2e.yml "$@"; }
trap 'dc logs --no-color --tail=80 || true; dc down -v || true; rm -f .env' EXIT
dc up -d --build --wait --wait-timeout 300

# Caddy serves `localhost` from its own CA, which this machine doesn't trust.
BASE=https://localhost SINK=http://127.0.0.1:1080 ADMIN_EMAIL=admin@e2e.test NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node ../test/e2e.mjs

# The backup job only fires nightly, so run its command once by hand.
dc exec -T backup sh -c 'pg_dump -h postgres -U postgres -Fc backfriend > /backups/check.dump && test -s /backups/check.dump'
echo "compose: backup dump OK"
