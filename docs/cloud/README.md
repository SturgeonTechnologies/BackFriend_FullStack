# Cloud deployment

**Follow [deployment.md](deployment.md) for the complete deployment.** This page is the summary.

## How it's deployed

`backend/scripts/deploy.mjs` reads one config file and runs the SAM build and deploy, wires up
the Cognito triggers, hosted UI theme and email, then builds the web app, syncs it to S3 and
invalidates CloudFront. `quickstart.sh` wraps those steps with prompts. Pushes to `main` run the
same script from `.github/workflows/deploy.yml`, using a GitHub OIDC role and no long-lived keys.

## Services involved

| Service | Job | Defined in |
|---|---|---|
| CloudFront + ACM + Route 53 | Serves the site on your domain and routes `/api/*` | `infrastructure/frontend-infra.yml` |
| S3 (site) | Holds the built web app, private behind CloudFront OAC | `infrastructure/frontend-infra.yml` |
| API Gateway + Lambda | The API, with a JWT authorizer in front | `backend/template.yaml` |
| Cognito | Google, Facebook and email + password sign-in, plus the invite gate in its triggers | `backend/template.yaml` |
| DynamoDB | Invites, mounts and public shares | `backend/template.yaml` |
| S3 (shares) | The shared files. Private, reached through presigned URLs | Created before deploy |
| SES | Invite and sign-in email | `infrastructure/email-infra.yml` |
| SSM Parameter Store | Google and Facebook OAuth secrets | Created before deploy |

## Who can reach what

API Gateway checks the Cognito token on every request, the handlers enforce mount access, and
S3 only serves a file through a short-lived presigned URL the API signed after that check. See
[Security notes](deployment.md#security-notes).
