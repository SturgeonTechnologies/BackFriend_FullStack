# Deploy with Docker Compose

Runs everything on one host from `deploy/compose`. Caddy gets and renews the certificate itself.

## Before you start

- Docker with the Compose plugin.
- Ports 80 and 443 open from the internet to this host, and the domain pointing at it.
- An SMTP server. Keycloak needs it to verify addresses.

## 1. Create the directories

`BACKFRIEND_DIR` can be a local disk or an NFS mount. It uses the
[same layout as Kubernetes](README.md#where-things-are-stored).

```bash
sudo mkdir -p /srv/backfriend/data
sudo mkdir -p /srv/backfriend/config/{postgres,backups,caddy/data,caddy/config}
sudo chown -R 10001:10001 /srv/backfriend/data
```

The app runs as `10001:10001`. To use an existing owner, such as `99:100` on Unraid, set `APP_UID`
and `APP_GID` in `.env` and `chown` `data/` to match.

## 2. Configure

```bash
cd deploy/compose
cp .env.example .env
```

In `.env`, set `SITE_HOST`, `BOOTSTRAP_ADMIN_EMAILS`, `BACKFRIEND_DIR` and the `SMTP_*` values.
`SMTP_URL` is the same server in `smtp://user:pass@host:587` form, for invite emails.

```bash
./gen-secrets.sh
```

This adds the random passwords and the file signing key to `.env` and sets it to mode 600. It
never changes a value that's already there.

## 3. Start

```bash
docker compose up -d --wait
docker compose ps
```

## 4. Sign in and check it

1. Open `https://<SITE_HOST>`, choose **Sign in with email**, then **Register**, using a bootstrap admin address.
2. Click the link in the verification email. You land in the app as an admin.
3. In **Admin**, create a mount, then upload a file and download it again.
4. Confirm the file is under `$BACKFRIEND_DIR/data/`.
5. `curl -si https://<SITE_HOST>/idp/admin/ | head -1` should return 404.

## Day to day

- **Upgrade:** set `BACKFRIEND_IMAGE` to a `sha-<7 chars>` tag in `.env`, then run `docker compose up -d`.
- **Keycloak admin console:** `http://localhost:8081/idp/admin` from the host itself, or through an
  SSH tunnel. It's bound to `127.0.0.1`. The password is `KEYCLOAK_ADMIN_PASSWORD` in `.env`.
- **Backups:** dumps land in `config/backups/` nightly and are kept for 14 days. Copy them and
  `data/` off the host.
- **Restore:** stop `app` and `keycloak`, run `pg_restore --clean` from a dump, then start them again.

For optional sign-in methods, see [authentication.md](authentication.md).
