# Security

There's no IAM or S3 signing to lean on here, so the app enforces access itself. Every request
has to pass each layer below, and anything that doesn't end in an explicit allow is refused.

## From a request to a file

1. **Proof of identity.** Keycloak issues an RS256 or ES256 token using the authorization code
   flow with PKCE. The app checks the signature, issuer, audience and expiry on every API
   request (`backend/onprem/src/authz.ts`), using keys fetched over the internal network.
2. **Permission to enter.** A valid token isn't enough. The email must be verified, and the first
   sign-in needs a live invite or a bootstrap admin entry. The invite is used up in a transaction,
   so it can't be used twice.
3. **Groups come from Postgres, not the token,** and are read on every request. Disabling a user
   takes effect on their next request, not when their token expires.
4. **Mount access.** The same handlers as the cloud check the caller against the mount's
   `allowedEmails`. Blank means admins only.
5. **Signed file links**, the on-prem equivalent of S3 presigned URLs. After those checks, the API
   signs a `/files/...` link with HMAC-SHA256 over the method, path, expiry and filename, using
   `FILE_SIGNING_KEY`. Downloads default to 5 minutes and uploads to 1 hour. A link can't be
   changed to reach another file or used for another method.
6. **The path itself.** `keyToPath` rejects `..`, absolute paths and control characters. Symlinks
   are never followed, and every path has to resolve inside `data/`.

Public share links use opaque 128-bit tokens, can be revoked, and are rate-limited per address.

## Uploaded content

Files are served from the same origin as the app, unlike S3. So only a short list of media and
document types render inline. Everything else downloads, and all of it gets a sandboxing
Content-Security-Policy, so an uploaded HTML file can't run as the app.

## Keycloak

Only the paths sign-in needs are exposed: `.well-known`, `protocol`, `login-actions`, `broker` and
`resources` for the `backfriend` realm. The admin console, master realm, account console and client
registration aren't reachable from the internet. The realm has brute force protection, a 12-character
minimum password, and required email verification. Anyone can register in Keycloak, because the
app is what refuses people without an invite, so those paths are rate-limited.

**Not on by default:** multi-factor authentication. Turn it on under Keycloak's
**Authentication → Required actions**, especially for admins.

## Containers and network

- Pods run as non-root, drop all capabilities, block privilege escalation and use read-only root
  filesystems where the image allows it. The namespace enforces the `restricted` Pod Security level.
- No pod gets a Kubernetes API token.
- Default-deny NetworkPolicies: only Traefik reaches the app, only the app, Keycloak and the backup
  job reach Postgres. Mail is limited to public addresses.
- The app and Keycloak have separate database logins, and each PV mounts one directory, so the app
  can't read `config/` and Postgres can't read `data/`.

<a id="nfs"></a>

## What you have to protect yourself

- **The NFS export is the weakest point.** NFSv3 trusts the client's IP address and has no
  encryption. Anyone who can mount the share can read every file and the database, bypassing all
  of the above. Limit the export rule to your Kubernetes nodes, not `*`, for example on Unraid:
  ```
  192.168.0.11(rw,sec=sys,insecure,anongid=100,anonuid=99,all_squash) 192.168.0.14(rw,sec=sys,insecure,anongid=100,anonuid=99,all_squash)
  ```
  List every node that can run these pods, and keep NFS on a trusted network.
- **Files at rest aren't encrypted** by the app. Use disk encryption on the file server if that matters.
- **`FILE_SIGNING_KEY` and the Secret.** Anyone with this key can sign links to any file. Limit who
  can read secrets in the namespace. Changing the key only breaks links already issued, so rotate
  it if it may have leaked.
- **Backups contain the whole database.** Protect `config/backups/` the same way, including off-site copies.
- **`TRUSTED_PROXY_HOPS`** must match the number of proxies in front of the app, or rate limits can
  be dodged by forging `X-Forwarded-For`. It's `1` here. Set it to `2` behind another proxy.
- **Patching.** Keycloak only gives security fixes to its newest release. Keep its image and the
  app's up to date, and watch for new versions.

## Auditing

The app logs one JSON line per API request with the user, status, source address and, for
refusals, the reason (for example `no-invite` or `user-disabled`). Ship those to your log system
and alert on repeated refusals.
