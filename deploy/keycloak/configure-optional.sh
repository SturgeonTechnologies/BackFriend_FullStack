#!/bin/sh
# Optional sign-in methods. Run inside the Keycloak container; see
# docs/onprem/authentication.md. Each block only runs if its variables are set,
# and re-running updates what's already there.
#
#   KC_PASSWORD         Keycloak admin password (defaults to the bootstrap admin's)
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
#   FACEBOOK_CLIENT_ID, FACEBOOK_CLIENT_SECRET
#   LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD, LDAP_USERS_DN
set -eu
KCADM=/opt/keycloak/bin/kcadm.sh
REALM=backfriend
"$KCADM" config credentials --server "${KC_URL:-http://localhost:8080/idp}" --realm master \
  --user "${KC_USER:-admin}" --password "${KC_PASSWORD:-$KC_BOOTSTRAP_ADMIN_PASSWORD}"

idp() { # alias providerId clientId secret trustEmail
  if "$KCADM" get "identity-provider/instances/$1" -r "$REALM" >/dev/null 2>&1; then action="update identity-provider/instances/$1"; else action="create identity-provider/instances"; fi
  # shellcheck disable=SC2086
  "$KCADM" $action -r "$REALM" -s alias="$1" -s providerId="$2" -s enabled=true -s trustEmail="$5" \
    -s firstBrokerLoginFlowAlias=backfriend-first-login -s 'config.clientId='"$3" -s 'config.clientSecret='"$4" -s 'config.syncMode=IMPORT'
  echo "configured $1"
}

# Google verifies addresses. Facebook doesn't promise that, so Keycloak emails a check.
if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then idp google google "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" true; fi
if [ -n "${FACEBOOK_CLIENT_ID:-}" ]; then idp facebook facebook "$FACEBOOK_CLIENT_ID" "$FACEBOOK_CLIENT_SECRET" false; fi

if [ -n "${LDAP_URL:-}" ]; then
  case "$LDAP_URL" in ldaps://*) ;; *) echo "LDAP_URL must be ldaps://, passwords would otherwise cross the network in the clear" >&2; exit 1 ;; esac
  # Read-only, so nothing a user does here can change Active Directory. trustEmail:
  # the directory is the authority on its own addresses, and the app requires a verified one.
  ID=$("$KCADM" get components -r "$REALM" -q name=active-directory --fields id --format csv --noquotes 2>/dev/null || true)
  ARGS="-s name=active-directory -s providerId=ldap -s providerType=org.keycloak.storage.UserStorageProvider
    -s config.vendor=[\"ad\"] -s config.editMode=[\"READ_ONLY\"] -s config.importEnabled=[\"true\"]
    -s config.usernameLDAPAttribute=[\"sAMAccountName\"] -s config.rdnLDAPAttribute=[\"cn\"]
    -s config.uuidLDAPAttribute=[\"objectGUID\"] -s config.userObjectClasses=[\"person,organizationalPerson,user\"]
    -s config.authType=[\"simple\"] -s config.pagination=[\"true\"] -s config.trustEmail=[\"true\"]
    -s config.useTruststoreSpi=[\"always\"]"
  # shellcheck disable=SC2086
  if [ -n "$ID" ]; then
    "$KCADM" update "components/$ID" -r "$REALM" $ARGS -s "config.connectionUrl=[\"$LDAP_URL\"]" -s "config.bindDn=[\"$LDAP_BIND_DN\"]" -s "config.bindCredential=[\"$LDAP_BIND_PASSWORD\"]" -s "config.usersDn=[\"$LDAP_USERS_DN\"]"
  else
    "$KCADM" create components -r "$REALM" $ARGS -s "config.connectionUrl=[\"$LDAP_URL\"]" -s "config.bindDn=[\"$LDAP_BIND_DN\"]" -s "config.bindCredential=[\"$LDAP_BIND_PASSWORD\"]" -s "config.usersDn=[\"$LDAP_USERS_DN\"]"
  fi
  echo "configured active-directory"
fi
