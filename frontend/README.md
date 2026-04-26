# Frontend deployment

React 18 + Vite SPA. Auth is OAuth 2.0 authorization-code + PKCE against the Cognito hosted UI (Google as IdP). No `amazon-cognito-identity-js` dependency — all auth is handled directly by the browser talking to Cognito.

## Prereqs

- Node 20, npm
- Backend deployed (see `../backend/README.md`) — you need `UserPoolClientId`, `CognitoDomain`, `ApiEndpoint`
- CloudFront + S3 site bucket provisioned (see `../infrastructure/README.md`) — you need `SiteBucketName` and `DistributionId`

## 1. Configure env

```bash
cd frontend
cp .env.example .env.local
```

Edit `.env.local`:

```
# Prod (serving from sharing.schuit.io behind CloudFront)
VITE_API_BASE=https://sharing.schuit.io/api
VITE_USER_POOL_CLIENT_ID=<UserPoolClientId from serverless info>
VITE_COGNITO_DOMAIN=https://<CognitoDomain host>
VITE_REDIRECT_URI=https://sharing.schuit.io/auth/callback
VITE_LOGOUT_REDIRECT=https://sharing.schuit.io/
```

For local dev, use these instead (and make sure the URIs are listed in the Cognito User Pool client's callback/logout URLs — they already are in `serverless.yml`):

```
VITE_API_BASE=<raw ApiEndpoint ending in /dev>
VITE_USER_POOL_CLIENT_ID=<UserPoolClientId>
VITE_COGNITO_DOMAIN=https://<CognitoDomain host>
VITE_REDIRECT_URI=http://localhost:5173/auth/callback
VITE_LOGOUT_REDIRECT=http://localhost:5173/
```

## 2. Install

```bash
npm install
```

## 3. Local development

```bash
npm run dev
```

Opens http://localhost:5173. Sign-in goes: SPA → Cognito hosted UI → Google → Cognito → SPA callback.

## 4. Production build

```bash
npm run build
```

Output lands in `dist/`.

## 5. Deploy to S3 + invalidate CloudFront

The SPA(Single Page Applications) lives under `s3://schuit-sharing/web/`. The CloudFormation stack's
`SiteUploadPath` output has the full target URI.

```bash
# Grab from CFN outputs (or hardcode — they won't change)
SITE_UPLOAD_PATH=$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name schuit-sharing-frontend \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUploadPath'].OutputValue" \
  --output text)
DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name schuit-sharing-frontend \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text)

aws s3 sync dist/ "$SITE_UPLOAD_PATH" --delete

aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*"
```

The `--delete` flag only removes objects under the `web/` prefix (by definition of `aws s3 sync`). Files outside `web/` — like `Video_Game_ROMs/` — are not touched.

CloudFront returns an `InvalidationId`. The new build is live in ~60 seconds.

### One-command deploy (optional)

Add to your `package.json` scripts:

```json
"deploy": "vite build && aws s3 sync dist/ s3://schuit-sharing/web/ --delete && aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths '/*'"
```

Then: `DISTRIBUTION_ID=... npm run deploy`.

## Routes

- `/login` — "Sign in with Google" button (redirects to Cognito hosted UI)
- `/auth/callback` — exchanges the OAuth code for tokens (PKCE), stores them in `localStorage` key `rh_tokens`
- `/` — Home: lists mounts configured by an admin
- `/browse/:mountPath` — directory browser (`?path=<subpath>`)
- `/admin` — admins only: manage invites and mounts

SPA routing is made to work on CloudFront by mapping 403/404 to `/index.html` (see `../infrastructure/frontend-infra.yml`).

## Token handling

- ID token stored in `localStorage`
- Tokens are sent as `Authorization: Bearer <idToken>` to the API
- No refresh-token flow in the MVP — on expiry, the user clicks "Sign in with Google" again (SSO makes it instant)
- `logout()` clears tokens and redirects to Cognito's `/logout` endpoint so the session on Cognito's side is also cleared

## Env schema

| Var                        | Example                                                            | Notes                                  |
|----------------------------|--------------------------------------------------------------------|----------------------------------------|
| `VITE_API_BASE`            | `https://sharing.schuit.io/api`                                    | Base URL for API calls                 |
| `VITE_USER_POOL_CLIENT_ID` | `1a2b3c4d5e6f7g8h`                                                 | Cognito App Client ID                  |
| `VITE_COGNITO_DOMAIN`      | `https://schuit-sharing-prod-123.auth.us-east-1.amazoncognito.com` | Full URL, no trailing slash            |
| `VITE_REDIRECT_URI`        | `https://sharing.schuit.io/auth/callback`                          | Must be registered on the App Client   |
| `VITE_LOGOUT_REDIRECT`     | `https://sharing.schuit.io/`                                       | Must be registered on the App Client   |

## Troubleshooting

- **`redirect_uri_mismatch` from Google**: you didn't add `https://<cognito-domain>/oauth2/idpresponse` to the Google OAuth client's authorized redirect URIs.
- **`invalid_grant` on `/auth/callback`**: the PKCE verifier was lost (sessionStorage cleared between authorize and callback). Usually caused by opening the auth flow in one tab and the callback in another. The user should retry.
- **403 after login on API calls**: either the ID token is expired (click Log out → Log in), or the API URL doesn't include `/api` — double-check `VITE_API_BASE`.
- **Blank page after refresh on `/browse/...`**: CloudFront isn't mapping 404 → `/index.html`. Redeploy `frontend-infra.yml`.
