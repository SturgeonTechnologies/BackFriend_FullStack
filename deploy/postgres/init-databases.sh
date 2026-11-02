#!/bin/sh
# Runs once, when Postgres first initialises its data directory. Each service gets
# its own database and login, and neither can read the other's.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres \
  -v app_pw="$APP_DB_PASSWORD" -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE backfriend LOGIN PASSWORD :'app_pw';
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE backfriend OWNER backfriend;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE backfriend FROM PUBLIC;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
