#!/bin/sh
# Creates the backfriend-secrets Secret with random service passwords, once. Set the
# mail and admin values in the environment first; see docs/onprem/kubernetes.md.
# It never overwrites an existing Secret: changing POSTGRES_PASSWORD or a database
# password here wouldn't change it inside Postgres, and would lock the services out.
set -eu
NS=backfriend
: "${BOOTSTRAP_ADMIN_EMAILS:?the email address of the first admin}"
: "${SMTP_HOST:?your mail server}"
: "${SMTP_FROM:?the address mail comes from}"
SMTP_PORT=${SMTP_PORT:-587}
SMTP_AUTH=${SMTP_AUTH:-true}
SMTP_STARTTLS=${SMTP_STARTTLS:-true}
SMTP_USER=${SMTP_USER:-}
SMTP_PASSWORD=${SMTP_PASSWORD:-}
if [ -z "${SMTP_URL:-}" ]; then
  if [ -n "$SMTP_USER" ]; then
    # The password has to be URL-safe here, or set SMTP_URL yourself.
    SMTP_URL="smtp://$SMTP_USER:$SMTP_PASSWORD@$SMTP_HOST:$SMTP_PORT"
  else
    SMTP_URL="smtp://$SMTP_HOST:$SMTP_PORT"
  fi
fi

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"
if kubectl -n "$NS" get secret backfriend-secrets >/dev/null 2>&1; then
  echo "backfriend-secrets already exists, leaving it alone" >&2
  exit 0
fi

random() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
umask 077
ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<SECRETS
POSTGRES_PASSWORD=$(random)
APP_DB_PASSWORD=$(random)
KEYCLOAK_DB_PASSWORD=$(random)
KEYCLOAK_ADMIN_PASSWORD=$(random)
FILE_SIGNING_KEY=$(random)
BOOTSTRAP_ADMIN_EMAILS=$BOOTSTRAP_ADMIN_EMAILS
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_FROM=$SMTP_FROM
SMTP_AUTH=$SMTP_AUTH
SMTP_USER=$SMTP_USER
SMTP_PASSWORD=$SMTP_PASSWORD
SMTP_STARTTLS=$SMTP_STARTTLS
SMTP_URL=$SMTP_URL
SECRETS
kubectl -n "$NS" create secret generic backfriend-secrets --from-env-file="$ENV_FILE"
