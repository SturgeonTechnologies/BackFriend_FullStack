# Sign-in methods

Email + password works from the first start. Everything here is optional. Each method adds a way
to prove who someone is. It never grants access: the app still requires an invite or a bootstrap
admin entry. See [security.md](security.md).

Run the commands with whichever deployment you use:

```bash
# Kubernetes
KC="kubectl -n backfriend exec -i deploy/keycloak --"
# Compose, from deploy/compose
KC="docker compose exec -T keycloak"
```

Re-running the script updates what's already there.

## Google

1. In Google Cloud, create an OAuth client of type **Web application**, with this redirect URI:
   `https://<your-domain>/idp/realms/backfriend/broker/google/endpoint`
2. Configure it:
   ```bash
   $KC env GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... /opt/keycloak/scripts/configure-optional.sh
   ```
3. Show the button: set `GOOGLE_ENABLED=true` in `kustomization.yaml` or `.env`, and redeploy.

## Facebook

1. In your Meta app, add Facebook Login with this redirect URI:
   `https://<your-domain>/idp/realms/backfriend/broker/facebook/endpoint`
2. Configure it:
   ```bash
   $KC env FACEBOOK_CLIENT_ID=... FACEBOOK_CLIENT_SECRET=... /opt/keycloak/scripts/configure-optional.sh
   ```
3. Set `FACEBOOK_ENABLED=true` and redeploy. Facebook doesn't promise a verified address, so
   Keycloak emails a check on first sign-in.

Google and Facebook both need the site on a real HTTPS domain.

## Active Directory

Keycloak checks passwords against AD over LDAPS, read-only, using a service account with no other rights.

```bash
$KC env LDAP_URL=ldaps://dc01.example.com:636 \
  LDAP_BIND_DN='CN=svc-backfriend,OU=Service,DC=example,DC=com' \
  LDAP_BIND_PASSWORD=... \
  LDAP_USERS_DN='OU=Users,DC=example,DC=com' \
  /opt/keycloak/scripts/configure-optional.sh
```

The script refuses anything other than `ldaps://`, so passwords never cross the network in the clear.

You also need:

- **A network path on Kubernetes.** A domain controller usually has a private address, and the
  `keycloak` NetworkPolicy blocks those. Add an egress rule for its IP on TCP 636.
- **Trust for your AD certificate.** If an internal CA signed it, add that CA to Keycloak's
  truststore (`KC_TRUSTSTORE_PATHS`).
- **A verified address in the directory.** AD users need a `mail` attribute, because invites and
  access rules are written against email addresses. Still invite them from the app.

Test the connection in the Keycloak admin console under **User federation → active-directory**.

## One address, one sign-in

An email address stays bound to the account that first claimed it. If someone registered with a
password and later tries Google with the same address, they're refused and told to contact an
admin. Social sign-in can't take over an existing account. To change a person's method, an admin
removes the old account first.
