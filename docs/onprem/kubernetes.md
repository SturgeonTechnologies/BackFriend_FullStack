# Deploy on Kubernetes

Installs BackFriend at `sharing.schuit.io` from `deploy/kubernetes`, with files and service state
on one NFS share. For another site, change the values in steps 1 and 2.

## What gets created

| Object | Purpose |
|---|---|
| Namespace `backfriend` | Enforces the `restricted` Pod Security level |
| PVs and PVCs `backfriend-data`, `backfriend-config` | `data/` and `config/` on the NFS share |
| Deployments `backfriend`, `keycloak`, `postgres` | The services, one replica each |
| CronJob `database-backup` | Dumps both databases at 03:17 to `config/backups/` |
| NetworkPolicies | Deny everything except the paths listed in `networkpolicy.yml` |
| Ingresses `backfriend`, `backfriend-idp` | Routing, TLS and the certificate request |
| Middleware `idp-ratelimit` | Rate limit on the sign-in paths |

## Before you start

- Kubernetes with `kubectl` and `kustomize` (`kubectl apply -k` works too).
- **Traefik** in a namespace named `traefik`, with the `traefik` IngressClass. For another
  namespace, change the selectors in `networkpolicy.yml`. For another controller, also replace the
  Middleware and its annotation in `ingress.yml`.
- **cert-manager** with a ClusterIssuer named `letsencrypt-prod`. If you don't have one, edit the
  email in `cert-manager/clusterissuer.yml` and apply that file.
- **A network plugin that enforces NetworkPolicy.** Without one, the policies do nothing.
- **An SMTP server.** Keycloak needs it to verify addresses, so people can't finish signing up without it.
- **NFS client tools on every node** (`nfs-common` or `nfs-utils`).
- The site's public address pointing at your ingress. Let's Encrypt has to reach it over HTTP.

## 1. Create the NFS directories

Create the share first: `sharing_schuit_io` on the file server (`192.168.0.33`, Unraid), with NFS
export on. Limit its export rule to your Kubernetes nodes; see [security.md](security.md#nfs).

**The two directories must exist before the first deploy**, because each PV mounts its own
directory. On the file server:

```bash
mkdir -p /mnt/user/sharing_schuit_io/config /mnt/user/sharing_schuit_io/data
chown -R nobody:users /mnt/user/sharing_schuit_io
chmod -R 775 /mnt/user/sharing_schuit_io
```

Postgres and the backup job create `config/postgres` and `config/backups` themselves.

For another server or path, edit `server` and `path` in `deploy/kubernetes/storage.yml`. The pods
run as `99:100`, the owner of a new Unraid share. For another owner, change `runAsUser` and
`runAsGroup` in `app.yml`, `postgres.yml` and `backup.yml`, and `chown` to match.

Check from a node:

```bash
sudo mount -t nfs -o nfsvers=3,nolock 192.168.0.33:/mnt/user/sharing_schuit_io/data /mnt && ls -la /mnt; sudo umount /mnt
```

## 2. Set the domain and image

In `deploy/kubernetes/kustomization.yaml`:

- The four `backfriend-site` values already use `sharing.schuit.io`. They're the only place the
  domain is set.
- Set `newTag` to a released `sha-<7 chars>` tag. `main` follows the latest build; CI pushes an
  image after a merge to `main` passes its deployment tests.

## 3. Create the secrets

This generates random service passwords and the file signing key once. It never overwrites an
existing Secret, because changed database passwords would lock the services out.

```bash
export BOOTSTRAP_ADMIN_EMAILS=you@example.com   # the first admin
export SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_FROM=noreply@schuit.io
export SMTP_USER=... SMTP_PASSWORD=...          # the password must be URL-safe, or set SMTP_URL yourself
deploy/kubernetes/gen-secret.sh
```

**With External Secrets Operator instead:** put the same keys in your secret manager, add
`externalsecret.example.yml` to `kustomization.yaml`, and set the store and key. The keys are
listed in `gen-secret.sh`.

If your mail server has a private address, add it to the `backfriend` and `keycloak` egress rules
in `networkpolicy.yml`. They only allow public addresses for mail.

## 4. Deploy

```bash
kustomize build deploy/kubernetes | kubectl apply -f -
kubectl -n backfriend rollout status deploy/postgres --timeout=5m
kubectl -n backfriend rollout status deploy/keycloak --timeout=7m
kubectl -n backfriend rollout status deploy/backfriend --timeout=3m
```

## 5. Point DNS at the ingress

Set the site's record to your ingress address. For `sharing.schuit.io` that means changing it from
the current CloudFront alias to `66.187.28.58`, the address `media.schuit.io` uses. **Doing this
takes the site off the cloud deployment**, so migrate first if you have data there; see
[migrate-from-aws.md](migrate-from-aws.md). The certificate can't be issued until DNS has moved:

```bash
kubectl -n backfriend get certificate backfriend-tls -w   # want READY True
```

## 6. Sign in and check it

1. Open the site, choose **Sign in with email**, then **Register**, using a `BOOTSTRAP_ADMIN_EMAILS` address.
2. Click the link in the verification email. You land in the app as an admin.
3. In **Admin**, create a mount, then upload a file and download it again.
4. Confirm the file is under `data/` on the share and that `config/postgres/data/PG_VERSION` exists.
5. Confirm Keycloak's admin paths are blocked. Both should return 404:
   ```bash
   curl -si https://sharing.schuit.io/idp/admin/ | head -1
   curl -si https://sharing.schuit.io/idp/realms/master/ | head -1
   ```
6. Run a backup once: `kubectl -n backfriend create job backup-now --from=cronjob/database-backup`

## A second, separate install under a sub-path

`deploy/overlays/rileyschuit-bros` runs the same image at `https://www.rileyschuit.com/bros`, and
redirects `rileyschuit.com` to `www.rileyschuit.com`, keeping the path. It has its own namespace
(`backfriend-bros`), Keycloak, Postgres, secrets and NFS share, so its users and files stay separate
from `sharing.schuit.io`. Only `/bros` is routed, so the rest of `www.rileyschuit.com` is free for
something else and returns 404 for now.

1. **Create the share** `rileyschuit_com_bros` on the file server, as in step 1:
   ```bash
   mkdir -p /mnt/user/rileyschuit_com_bros/config /mnt/user/rileyschuit_com_bros/data
   chown -R nobody:users /mnt/user/rileyschuit_com_bros
   chmod -R 775 /mnt/user/rileyschuit_com_bros
   ```
2. **Create its secrets.** Export the same variables as step 3, with `NS` set:
   ```bash
   NS=backfriend-bros deploy/kubernetes/gen-secret.sh
   ```
3. **Deploy:**
   ```bash
   kustomize build deploy/overlays/rileyschuit-bros | kubectl apply -f -
   kubectl -n backfriend-bros rollout status deploy/postgres --timeout=5m
   kubectl -n backfriend-bros rollout status deploy/keycloak --timeout=7m
   kubectl -n backfriend-bros rollout status deploy/backfriend --timeout=3m
   ```
4. **Point DNS** for `rileyschuit.com` and `www.rileyschuit.com` at the ingress, then follow step 6
   using `https://www.rileyschuit.com/bros`. Keycloak is at `/bros/idp`, so the admin console is at
   `http://localhost:8081/bros/idp/admin` through the port-forward.

## Day to day

- **Upgrade:** change `newTag`, then repeat step 4. The schema migrates when the app starts.
- **Keycloak admin console:** it isn't on the internet. Use a port-forward, then open
  `http://localhost:8081/idp/admin`:
  ```bash
  kubectl -n backfriend get secret backfriend-secrets -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d; echo
  kubectl -n backfriend port-forward deploy/keycloak 8081:8080
  ```
- **Restore a database:** scale `backfriend` and `keycloak` to 0, then run `pg_restore --clean` from
  a dump in `config/backups/`, and scale back up.
- **Logs:** the app writes one JSON line per API request, including who was refused and why.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Pods stuck in `ContainerCreating`, `No such file or directory` | `config/` or `data/` is missing from the share (step 1) |
| Pods stuck in `ContainerCreating`, `access denied by server` | The export rule doesn't include that node |
| Postgres: `data directory has wrong ownership` | The share's owner doesn't match `runAsUser`; `chown` it (step 1) |
| Certificate never becomes Ready | DNS doesn't point at the ingress yet, or port 80 isn't reachable |
| Verification email never arrives | SMTP settings, or a private mail server (step 3) |
| "No invite found" after signing in | That address has no invite and isn't a bootstrap admin |
| Keycloak ignores a realm edit | The realm is only imported the first time. Change it in the admin console |
| Pod won't restart after an NFS outage | Stale mount on the node. Delete the pod, then unmount the stale path on the node if needed |
