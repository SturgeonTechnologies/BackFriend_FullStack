# On-prem deployment

BackFriend without AWS: everything runs in containers and stays on your own hardware.

- **[kubernetes.md](kubernetes.md):** Kubernetes manifests with NFS storage, Ingress and
  certificates. Configured for `sharing.schuit.io`.
- **[compose.md](compose.md):** Docker Compose on one host.
- **[authentication.md](authentication.md):** Google, Facebook and Active Directory sign-in, all optional.
- **[security.md](security.md):** how authorization works, and what you have to protect yourself.
- **[migrate-from-aws.md](migrate-from-aws.md):** moving an existing cloud deployment over.

## Services involved

| Service | Image | Job | Replaces |
|---|---|---|---|
| App | `ghcr.io/sturgeontechnologies/backfriend` | The API and web app in one process | API Gateway, Lambda, S3 site |
| Keycloak | `quay.io/keycloak/keycloak` | Sign-in, password resets and email checks | Cognito |
| Postgres | `postgres:17` | App records and Keycloak's data, as two databases with separate logins | DynamoDB |
| Database backup | `postgres:17` | Nightly `pg_dump` of both databases, keeping 14 days | DynamoDB backups |
| Traefik or Caddy | Yours (Kubernetes) or `caddy` (Compose) | TLS, and only exposes the Keycloak paths sign-in needs | CloudFront |
| cert-manager | Yours (Kubernetes only) | Issues and renews the certificate. Caddy does this itself under Compose | ACM |
| SMTP server | Yours | Invites, address checks and password resets | SES |

The app runs the same handlers as the cloud. `backend/onprem/build.mjs` swaps their DynamoDB, S3,
Cognito and SES modules for the versions in `backend/onprem/src/shims`, and the build fails if
any AWS SDK import is left.

```
browser ── HTTPS ──▶ Traefik / Caddy ─┬─ /idp/realms/backfriend/{protocol,login-actions,...} ─▶ Keycloak ─┐
                                      └─ everything else ─▶ App ───────────────────────────▶ Postgres ◀──┘
                                                             │                                   │
                                                             ▼                                   ▼
                                                           data/                     config/postgres, config/backups
```

## Where things are stored

Both deployment types use the same layout under one directory, or one NFS share:

```
sharing_schuit_io/
├── data/              The shared files. Only the app mounts this.
│   └── .backfriend-tmp/   Upload scratch space, created by the app. Never listed to users.
└── config/            One directory per service.
    ├── postgres/      Users, invites, mounts, public links and Keycloak's data
    ├── backups/       Nightly database dumps, kept 14 days
    └── caddy/         Compose only: certificates and Caddy state
```

Keycloak and the app have no directory of their own because they keep their state in Postgres.
The realm definition ships in the repo (`deploy/keycloak`), and secrets live in a Kubernetes
Secret or a Compose `.env` file, not on the share.

**To back up:** `data/` and `config/backups/`. Don't copy `config/postgres/` while Postgres is
running; restore from a dump instead.
