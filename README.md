# schuit-sharing

An invite-only web app for browsing and downloading files (ROMs, etc.) stored in S3.
Served at **[sharing.schuit.io](https://sharing.schuit.io)**.

> **Status:** SES invite email send is verified end-to-end as of
> 2026-04-26 (admin gate passes, invite written to DDB, email
> delivered). SES is still in *sandbox* mode — only verified
> recipients can receive mail until production access is requested
> via the SES console. See [`TODO.md`](./TODO.md) for that and the
> next planned item (real staging environment + GitHub Actions CD).

- Auth: **Cognito + Google federation** (sign in with Google)
- First admin: `riley.schuit@gmail.com` (bootstrapped via env var)
- Admins invite other users by email; invitees just click "Sign in with Google"
- Admins configure **mounts** — a URL path (e.g. `/roms`) mapped to an S3 prefix (e.g. `s3://schuit-sharing/Video_Game_ROMs/`)
- Everything behind a single CloudFront distribution on `sharing.schuit.io`

## Layout

```
schuit-sharing/
├── backend/                      Serverless Framework app (Lambda + API GW + Cognito + DDB + S3)
│   ├── serverless.yml
│   └── src/
│       ├── lib/                  Shared helpers (auth, DDB, S3, Cognito, mounts)
│       └── handlers/
│           ├── triggers/         Cognito Lambda triggers (preSignUp, postAuth)
│           ├── admin/            Admin-only (invites, mounts)
│           └── user/             Authenticated (listMounts, browseList, browseDownloadUrl)
├── frontend/                     React + Vite SPA
│   └── src/
│       ├── lib/                  auth (OAuth + PKCE), API client, pkce helpers
│       └── pages/                Login, Callback, Home, Browse, Admin
└── infrastructure/
    ├── frontend-infra.yml        CloudFormation: ACM + S3 + CloudFront + Route 53
    └── email-infra.yml           CloudFormation: SES domain identity + DKIM + MAIL FROM
```

## Architecture

```
                        ┌─────────────────────────────────┐
 sharing.schuit.io ────▶│ CloudFront distribution          │
                        │  ├─ default  → S3 site (SPA)     │
                        │  └─ /api/*  → API Gateway (Lambda│
                        │                strip /api prefix)│
                        └──────┬──────────────┬────────────┘
                               │              │
                        ┌──────▼───┐    ┌─────▼─────────┐
                        │ S3 site  │    │ API Gateway   │── JWT auth (Cognito)
                        │ (SPA)    │    │ + Lambdas     │
                        └──────────┘    └───┬───────┬───┘
                                            │       │
  ┌─────────────────┐                       │       │
  │ Cognito User    │◀──OAuth/PKCE (browser)┘       │
  │ Pool (hosted UI)│                               │
  │ + Google IdP    │                               │
  └─────────────────┘                               │
                        ┌──────────────┐            │
                        │ DynamoDB     │◀───────────┤
                        │ invites +    │            │
                        │ mounts       │            │
                        └──────────────┘            │
                        ┌──────────────┐            │
                        │ S3: schuit-  │◀───────────┘
                        │ sharing/...  │   presigned GETs
                        └──────────────┘
```

## Prereqs

- Node 20, npm
- AWS CLI configured (for the AWS account that owns `schuit.io` in Route 53)
- A Google Cloud project for OAuth
- Serverless Framework v3 (`npm i -g serverless`)

## 1. Create the Google OAuth client

1. Go to https://console.cloud.google.com/ → pick (or create) a project.
2. **APIs & Services → OAuth consent screen**: create one (External, add your email as a test user if you leave it in Testing; publish later).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `https://sharing.schuit.io`
     - `http://localhost:5173` (for local dev)
   - Authorized redirect URIs (these are Cognito's hosted UI endpoints — you'll get the final domain in step 3, so come back and update these):
     - `https://<cognito-domain>/oauth2/idpresponse`
4. Save the **Client ID** and **Client secret** for step 2.

## 2. Store Google creds in SSM Parameter Store

```bash
aws ssm put-parameter \
  --name /schuit-sharing/prod/google/client_id \
  --type String \
  --value '<google-client-id>'

aws ssm put-parameter \
  --name /schuit-sharing/prod/google/client_secret \
  --type SecureString \
  --value '<google-client-secret>'
```

The live deployment uses stage `prod`. The `dev` stage is reserved for a future personal sandbox / `serverless offline` use; if you populate `/schuit-sharing/dev/google/...` you can deploy a parallel sandbox stack with `--stage dev`.

## 3. Deploy the backend

```bash
cd backend
npm install
npx serverless deploy --stage prod
```

Outputs you'll need:

- `UserPoolId`
- `UserPoolClientId`
- `CognitoDomain` — e.g. `https://schuit-sharing-prod-<acct>.auth.us-east-1.amazoncognito.com`
- `SharesBucketName` — the bucket the app reads from (default: `schuit-sharing`)
- `ApiEndpoint` — raw API Gateway URL; you'll need the host portion only

**Now go back to Google Cloud Console** and add the Cognito callback to the authorized redirect URIs:

```
https://schuit-sharing-prod-<acct>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

The first admin (`riley.schuit@gmail.com`) is bootstrapped automatically — no need to manually create the user or add them to the admins group. The `postAuth` Lambda trigger adds them on first sign-in.

## 4. Deploy the frontend infra (custom domain)

`infrastructure/frontend-infra.yml` creates:

- ACM certificate for `sharing.schuit.io` (DNS-validated)
- CloudFront Origin Access Control (OAC)
- CloudFront distribution with two origins:
  - default → the existing `schuit-sharing` bucket, scoped to the `web/` prefix
  - `/api/*` → API Gateway
- Route 53 A-alias `sharing.schuit.io → CloudFront`

The SPA lives at `s3://schuit-sharing/web/`. No dedicated site bucket is created — one bucket hosts both the SPA (`web/`) and the shared files (`Video_Game_ROMs/`, etc.). CloudFront's OAC is scoped to `web/*` only, so the distribution cannot serve anything outside that prefix.

### DNS model (read this first)

**You only need the parent `schuit.io` hosted zone** — there is **no** separate
hosted zone for `sharing.schuit.io`. Subdomains are just records inside the
parent zone. This stack adds:

1. A temporary CNAME for ACM DNS validation (removed after the cert issues)
2. A permanent A-alias `sharing.schuit.io → CloudFront`

If `schuit.io` isn't in Route 53 yet:

```bash
aws route53 create-hosted-zone \
  --name schuit.io \
  --caller-reference "$(date +%s)"
# then point your domain registrar at the 4 nameservers it prints
```

### Deploy

**Must be deployed in `us-east-1`** — CloudFront requires its ACM cert in that region.

Easiest: use the helper script (auto-discovers the hosted zone ID and API host):

```bash
cd infrastructure
./deploy.sh
```

Or run it manually:

```bash
HOSTED_ZONE_ID=ZXXXXXXXXXXXXX
API_HOST=abc123def.execute-api.us-east-1.amazonaws.com   # from serverless outputs

aws cloudformation deploy \
  --region us-east-1 \
  --stack-name schuit-sharing-frontend \
  --template-file infrastructure/frontend-infra.yml \
  --parameter-overrides \
      DomainName=sharing.schuit.io \
      HostedZoneId=$HOSTED_ZONE_ID \
      ApiGatewayDomain=$API_HOST \
      SiteBucket=schuit-sharing \
      SitePrefix=web \
      SiteBucketRegion=us-east-1 \
  --capabilities CAPABILITY_IAM
```

Outputs:
- `SiteBucketName` — `schuit-sharing`
- `SitePrefix` — `web`
- `SiteUploadPath` — `s3://schuit-sharing/web/` (sync target)
- `DistributionId` — for cache invalidation
- `Url` — `https://sharing.schuit.io`

> **Heads-up on bucket policy:** this stack now owns the bucket policy on
> `schuit-sharing` (the OAC grant). Don't set a bucket policy manually or
> via another tool — put any additional statements in `SiteBucketPolicy`
> inside `frontend-infra.yml` and redeploy. Lambda access to ROM files
> uses IAM (not the bucket policy), so this doesn't affect the backend.

## 4b. Deploy the SES email stack (for invite emails)

`infrastructure/email-infra.yml` creates the SES sending identity for
`schuit.io` so the backend can email invitees from `noreply@schuit.io`.
It coexists with Google Workspace on the same root domain because:

- DKIM uses unique selector subdomains (`<token>._domainkey.schuit.io`),
  not Google's `google._domainkey.schuit.io`. They don't collide.
- The custom **MAIL FROM** lives on a *subdomain* (`mail.schuit.io`), with
  its own MX (`feedback-smtp.us-east-1.amazonses.com`) and SPF
  (`v=spf1 include:amazonses.com ~all`). The root domain's MX (Google) and
  any root SPF stay untouched.
- Outbound mail still says `From: noreply@schuit.io` and is DKIM-signed
  by the apex identity, so DMARC alignment passes.

Deploy:

```bash
cd infrastructure
./email-deploy.sh
```

Or manually:

```bash
HOSTED_ZONE_ID=ZXXXXXXXXXXXXX
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name schuit-sharing-email \
  --template-file infrastructure/email-infra.yml \
  --parameter-overrides \
      Domain=schuit.io \
      MailFromSubdomain=mail \
      HostedZoneId=$HOSTED_ZONE_ID \
      Region=us-east-1 \
  --capabilities CAPABILITY_IAM
```

### Wait for DKIM verification

DKIM CNAMEs propagate, then SES detects them and flips the identity to
**Verified**. Typical wait: 5–60 minutes. Poll:

```bash
aws ses get-identity-verification-attributes \
  --region us-east-1 \
  --identities schuit.io \
  --query 'VerificationAttributes."schuit.io".VerificationStatus' \
  --output text
```

`Success` means you're good to send.

### Sandbox mode (one-time gate)

A new SES account is in **sandbox**: you can only send to *verified*
recipient addresses (max 200 messages/day, 1/sec). For initial testing,
verify your own inbox:

```bash
aws ses verify-email-identity --region us-east-1 \
  --email-address riley.schuit@gmail.com
# (click the link in the email AWS sends you)
```

Then **request production access** in the SES console (one-form,
usually granted within 24h):
<https://console.aws.amazon.com/ses/home?region=us-east-1#/account>

After production access is granted, sandbox restrictions disappear and
the backend can email any invitee.

### Redeploy backend so MAIL_FROM lands

`backend/serverless.yml` now sets `MAIL_FROM=noreply@schuit.io`,
`MAIL_REGION=us-east-1`, and grants Lambdas `ses:SendEmail`. Redeploy:

```bash
cd backend
npx serverless deploy --stage dev
```

That's it — the **Invite a user** form on `/admin` now sends an email by
default. If SES rejects the send (sandbox: unverified recipient, identity
not yet DKIM-verified, throttled), the invite row is still written and
the form shows the `signupUrl` so you can copy/paste it manually.

## 5. Build & upload the frontend

```bash
cd frontend
cp .env.example .env.local
```

Fill in `.env.local`:

```
VITE_API_BASE=https://sharing.schuit.io/api
VITE_USER_POOL_CLIENT_ID=<UserPoolClientId>
VITE_COGNITO_DOMAIN=https://schuit-sharing-prod-<acct>.auth.us-east-1.amazoncognito.com
VITE_REDIRECT_URI=https://sharing.schuit.io/auth/callback
VITE_LOGOUT_REDIRECT=https://sharing.schuit.io/
```

Then build and sync:

```bash
npm install
npm run build

aws s3 sync dist/ s3://schuit-sharing/web/ --delete
aws cloudfront create-invalidation \
  --distribution-id <DistributionId> \
  --paths "/*"
```

The `--delete` flag will remove objects under `web/` that aren't in the new build. Because the OAC is scoped to `web/*`, this only touches the SPA — `Video_Game_ROMs/` and other shared content are untouched.

## 6. First sign-in + configure the `/roms` mount

1. Open https://sharing.schuit.io
2. Click **Sign in with Google** → pick `riley.schuit@gmail.com`
3. You should land on the Home page. Click **Admin** in the nav.
4. Scroll to **Add a shared directory (mount)**. Defaults are pre-filled:
   - Path: `roms`
   - Display name: `Video Game ROMs`
   - S3 prefix: `Video_Game_ROMs/`
   - Bucket: *(leave blank; defaults to `schuit-sharing`)*
5. Click **Add mount**.
6. Head back to Home → click **Video Game ROMs** → browse and download.

## 7. Inviting another user

In Admin → **Invite a user**:

- Email must match the Google account they'll sign in with
- Pick a TTL (14 days default)
- Optionally check **Make admin** to give them admin rights on first sign-in
- **Send invite email** is on by default — the invitee gets an email from
  `noreply@schuit.io` with the signup link. Uncheck it if you want to
  share the link out-of-band (Slack, etc.). If SES is still in sandbox
  and the recipient isn't verified, the form shows a warning + the link
  so you can paste it yourself.

They just go to https://sharing.schuit.io and click **Sign in with Google**. The `preSignUp` Lambda trigger lets them in based on the invite row in DynamoDB; `postAuth` adds them to any groups and marks the invite redeemed.

## Local development

```bash
# Backend: deploy to dev stage as above.
# Frontend:
cd frontend
cp .env.example .env.local
# Set VITE_API_BASE to the raw API Gateway URL (ends in /dev)
# Set VITE_REDIRECT_URI to http://localhost:5173/auth/callback
# Set VITE_LOGOUT_REDIRECT to http://localhost:5173/

npm install
npm run dev
```

Add `http://localhost:5173/auth/callback` to:
- the Cognito User Pool Client's **Callback URLs** (already included by `serverless.yml`)
- the Google OAuth client's authorized redirect URIs (optional — only if you want to test the full Google → Cognito → app flow against a dev Cognito domain)

## Security notes

- **Cognito is the trust boundary.** The API Gateway JWT authorizer validates every request. Lambdas extract `email`, `sub`, and `cognito:groups` from verified claims.
- **Invites live in DynamoDB with TTL**; expired rows are removed automatically by DynamoDB TTL.
- **Bucket is private.** Downloads are 5-minute S3 presigned GET URLs minted per-request. Every download is logged (CloudWatch) with caller email, mount, and S3 key.
- **Directory traversal** (`..`, `\`) is rejected by `safeSubpath` in `backend/src/lib/mounts.ts`.
- **CloudFront → S3** uses OAC; the bucket policy allows only the distribution.
- **CloudFront → API** uses the `AllViewerExceptHostHeader` origin request policy, so `Authorization` is forwarded, but Host is rewritten to API Gateway's domain.

## Tighten for production

- Change `httpApi.cors.allowedOrigins` from `*` to `https://sharing.schuit.io`.
- Publish the Google OAuth consent screen out of **Testing** so invitees can sign in without being test users.
- Add a WAF web ACL to the CloudFront distribution.
- Add CloudWatch alarms on Lambda errors/throttles and DynamoDB throttles.
- Turn on MFA in Cognito (`MfaConfiguration: OPTIONAL`) — Google already enforces its own, but local accounts (if you add any) should have it.
- Consider CloudFront signed URLs for very large files; S3 presigned GETs are fine up to a few hundred MB.
