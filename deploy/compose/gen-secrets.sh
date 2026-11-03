#!/bin/sh
# Adds any missing random secret to .env and never changes an existing one.
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "Copy .env.example to .env first" >&2; exit 1; }
chmod 600 .env
for name in POSTGRES_PASSWORD APP_DB_PASSWORD KEYCLOAK_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD FILE_SIGNING_KEY; do
  if ! grep -q "^$name=" .env; then
    # Hex, so the value is safe inside a connection string.
    printf '%s=%s\n' "$name" "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >> .env
    echo "generated $name"
  fi
done
