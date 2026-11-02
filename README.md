# BackFriend Fullstack

An invite-only web app for browsing, sharing and downloading files, with access controlled per
mount and admins inviting users by email. A companion mobile app (Expo/React Native) uses the
same backend on the cloud deployment.

The same API handlers (`backend/src`) and web app (`frontend`) run in two ways. Pick one and
follow its guide from top to bottom.

| | Cloud | On-prem |
|---|---|---|
| **Guide** | [docs/cloud](docs/cloud/README.md) | [docs/onprem](docs/onprem/README.md) |
| **How it deploys** | `scripts/deploy.mjs` and AWS SAM, by hand or from GitHub Actions | One container image plus Postgres and Keycloak, using [Kubernetes manifests](docs/onprem/kubernetes.md) or [Docker Compose](docs/onprem/compose.md) |
| **Web hosting** | S3 + CloudFront | The app container, behind Traefik or Caddy |
| **API** | API Gateway + Lambda | The app container |
| **Sign-in** | Cognito | Keycloak (local accounts, optional Google, Facebook, Active Directory) |
| **Records** | DynamoDB | Postgres |
| **Files** | S3 | A directory, usually on NFS |
| **Email** | SES | Your SMTP server |

Security model for on-prem: [docs/onprem/security.md](docs/onprem/security.md). Moving from one
to the other: [docs/onprem/migrate-from-aws.md](docs/onprem/migrate-from-aws.md).
