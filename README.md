# schuit-sharing

An invite-only web app for browsing and downloading files (ROMs, etc.) stored in S3.
Served at **[sharing.schuit.io](https://sharing.schuit.io)**.

> **Status:** Live on `schuit-sharing-prod-sam` — the backend runs on **AWS
> SAM**, not the original Serverless Framework app (that stack was cut over
> and deleted 2026-08-09; see "Deploy the backend" below). Auth is on a
> **custom Cognito domain** (`auth.schuit.io`, not the auto-generated
> `*.amazoncognito.com` one) — see "Custom Cognito domain" below. There's
> also a **mobile app** (Expo/React Native, `BackFriend_Mobile`) consuming
> this same backend, which is why it now exposes a public `GET /config`
> discovery endpoint (used by the app's "add account" flow; the web SPA
> doesn't need it).
>
> SES has **production access** — invite mail sends to any recipient (quota
> 50k/day). (Email/password *verification* codes use Cognito's own sender,
> separate from SES.) The shares bucket is fully private — **S3 Public Access
> Block is on**; the only ways to reach a file are a signed-in browse/download
> (5-min presigned GET) or an explicit per-file "public" token link.

- Auth: **Cognito** — sign in with **Google**, **Facebook**, *or* **email + password**
  (all via the Cognito hosted UI; email/password users self-register through the invite
  gate and verify their address with a one-time code)
- First admin: `riley.schuit@gmail.com` (bootstrapped via env var)
- Admins invite other users by email; invitees go to the site and "Sign in with
  Google", "Sign in with Facebook", or "Sign in with email" → "Sign up"
- Admins configure **mounts** — a URL path (e.g. `/roms`) mapped to an S3 prefix (e.g. `s3://schuit-sharing/Video_Game_ROMs/`). The Admin page has an **Explore bucket** browser that lists the real S3 layout so a directory can be turned into a mount in one click.

### Features

- **Auth:** Google + Facebook + email/password (all via the Cognito hosted UI, themed to match the site).
- **Mounts** with per-mount access control (`allowedEmails`; blank = admins-only). **Add/modify** a mount or manage its users from the Admin page (with email autocomplete + auto-invite of anyone granted who isn't invited yet).
- **Invites/Access** — invite users; the list shows everyone with access (active users + pending invites).
- **Admin bucket explorer** — browse the raw bucket, **create** a directory, **delete** a directory (type-name + "confirm" guard), and per-file Public / Download / Delete.
- **Browse** any mount you can see: **download** (presigned), **upload** files, admins can **delete**, and admins can toggle a file **Public** (opaque token → presigned redirect, revocable, bucket stays private).
- **Global file search** across every mount you can access.
- **Profile** page + a user dropdown menu.

> **One email = one sign-in method.** Because the pool uses the email as the
> username, a given address should use **exactly one** of Google, Facebook, or a
> password — never a mix. Signing in with a second method for an email that
> already exists under another collides in Cognito (`already found an entry for
> username`). Automatic account-linking is not configured, so pick one method per
> invitee.
- Everything behind a single CloudFront distribution on `sharing.schuit.io`

## Layout

```
schuit-sharing/
├── backend/                      AWS SAM app (Lambda + API GW + Cognito + DDB + S3)
│   ├── template.yaml             The SAM template -- source of truth for backend resources
│   ├── deploy.config.example.json  Template for the one-file deploy config (see below)
│   ├── scripts/
│   │   ├── deploy.mjs            One-command deploy: SAM + Cognito wiring + frontend
│   │   └── wire-cognito-triggers.mjs  Post-deploy Cognito trigger/theme/email wiring
│   └── src/
│       ├── lib/                  Shared helpers (auth, DDB, S3, Cognito, mounts, invites, provision)
│       └── handlers/
│           ├── triggers/         Cognito triggers (preSignUp, postAuth, preTokenGen)
│           ├── admin/            Admin-only (invites/access, mounts, explorer, public sharing)
│           ├── public/           Unauthenticated (public-share resolver, GET /config discovery)
│           └── user/             Authenticated (mounts, browse, download, upload, delete, search)
├── frontend/                     React + Vite SPA
│   └── src/
│       ├── lib/                  auth (OAuth + PKCE), API client, pkce, icons, PublicButton
│       └── pages/                Login, Callback, Home (+ search), Browse, Admin, Profile
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
  │ Google/Facebook │                               │
  │ + email/pass    │                               │
  └─────────────────┘                               │
                        ┌──────────────┐            │
                        │ DynamoDB     │◀───────────┤
                        │ invites +    │            │
                        │ mounts +     │            │
                        │ public-shares│            │
                        └──────────────┘            │
                        ┌──────────────┐            │
                        │ S3: schuit-  │◀───────────┘
                        │ sharing/...  │   presigned GETs
                        └──────────────┘
```

## Prereqs

- Node 20, npm
- AWS CLI configured (for the AWS account that owns your domain in Route 53)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) ≥ 1.163
- A Google Cloud project for OAuth (optional — skip for email/password-only)
- A Meta for Developers app for Facebook Login (https://developers.facebook.com/) (optional)

## 1. Create the OAuth clients (Google + Facebook)

### Google

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

### Facebook

1. Go to https://developers.facebook.com/ → **My Apps → Create App** (use type **Consumer**).
2. Add the **Facebook Login** product to the app.
3. **App Settings → Basic**: note the **App ID** and **App Secret** (these are the `client_id` / `client_secret` for step 2). Set a Privacy Policy URL — Facebook requires one before the app can go Live.
4. **Facebook Login → Settings → Valid OAuth Redirect URIs**: add the Cognito endpoint (same as Google — you'll get the final domain in step 3, so come back and fill this in):
   - `https://<cognito-domain>/oauth2/idpresponse`
5. When ready for real invitees, flip the app from **Development** to **Live** (top bar). `public_profile` + `email` are default permissions and need **no App Review**.

## 2. Store OAuth creds in SSM Parameter Store

```bash
# --- Google ---
aws ssm put-parameter \
  --name /schuit-sharing/prod/google/client_id \
  --type String \
  --value '<google-client-id>'

aws ssm put-parameter \
  --name /schuit-sharing/prod/google/client_secret \
  --type SecureString \
  --value '<google-client-secret>'

# --- Facebook (client_id = App ID, client_secret = App Secret) ---
aws ssm put-parameter \
  --name /schuit-sharing/prod/facebook/client_id \
  --type String \
  --value '<facebook-app-id>'

aws ssm put-parameter \
  --name /schuit-sharing/prod/facebook/client_secret \
  --type SecureString \
  --value '<facebook-app-secret>'
```

Pick names under whatever prefix you like (`/<your-space-name>/<stage>/...`) — the SSM parameter names are what you point at from `deploy.config.<name>.json`'s `oauth` block, not a fixed convention. `samtest` is a disposable throwaway stage (see "Deploy the backend") that's normally left email/password-only — no need to populate OAuth secrets for it unless you specifically want to test federated sign-in there too.

## 3. Deploy the backend (and the frontend, in the same step)

One JSON config file drives the whole thing — SAM build+deploy, Cognito
trigger/hosted-UI-theme/email wiring, and (if you fill in its `frontend`
block) the SPA build + S3 sync + CloudFront invalidation.

**First time bootstrapping a brand-new space:** the `frontend` block names an
*already-deployed* CloudFront/S3 stack (step 4, below), which itself needs
this backend's `ApiEndpoint` output to be created. So on a fresh space, leave
`frontend` out of the config for your first deploy, do step 4 with the
`ApiEndpoint` it prints, then add the `frontend` block and re-run
`deploy.mjs`. Redeploying an existing space, just fill in everything and run
it once.

```bash
cd backend
npm install
cp deploy.config.example.json deploy.config.<name>.json   # e.g. deploy.config.prod.json
```

Fill in `deploy.config.<name>.json` — every field is explained by a
`$comment*` key right next to it in the example file. The short version:

- `stage` / `stackName` / `functionNamePrefix` / `artifactBucket` — names for
  this deployment. `artifactBucket` is a plain S3 bucket SAM uploads build
  artifacts to (`aws s3 mb s3://<name>` once, any region-appropriate name).
- `sharesBucket` / `siteOrigin` / `allowedOrigins` / `appDisplayName` /
  `bootstrapAdminEmails` / `mailFrom` — your space's basics. `bootstrapAdminEmails`
  is who gets auto-promoted to admin on first sign-in — no manual user/group setup needed.
- `oauth` — omit entirely for email/password-only. When present, only SSM
  *parameter names* go in the file (see step 2) — the actual secret values
  are pulled from SSM at deploy time, never written to this file.
- `adopt` — omit for a brand-new space (this creates a fresh Cognito pool +
  tables). Only needed if you're pointing a new compute stack at an existing
  pool (that's what this deployment's own `prod` config does — see "Custom
  Cognito domain" below for why that matters).
- `frontend` — omit to deploy backend-only. When present, `distributionStackName`
  must name an **already-deployed** frontend stack (step 4, below) — this
  script doesn't create infrastructure, only builds and pushes to it.

Then deploy:

```bash
node scripts/deploy.mjs deploy.config.<name>.json
```

It's idempotent — re-run it any time you change the config or pull new code.
Stack outputs (`UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `ApiEndpoint`, …)
print at the end; you'll want `CognitoDomain` for the next step.

**Now go back to both Google Cloud Console and the Facebook app** (if you
configured OAuth) and add the Cognito callback to their redirect URIs
(Google: *Authorized redirect URIs*; Facebook: *Facebook Login → Settings →
Valid OAuth Redirect URIs*), using the `CognitoDomain` the deploy just
printed:

```
<CognitoDomain>/oauth2/idpresponse
```

The admin(s) listed in `bootstrapAdminEmails` are bootstrapped automatically
on first sign-in — no need to manually create a user or add them to the
admins group.

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
API_HOST=abc123def.execute-api.us-east-1.amazonaws.com   # backend deploy's ApiEndpoint output, host only (no https://)

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

> This account **already has SES production access** — the steps below only
> apply to a fresh account.

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

### Redeploy so MAIL_FROM lands

`backend/template.yaml`'s Lambdas are granted `ses:SendEmail`, and `mailFrom`
in your `deploy.config.<name>.json` sets `MAIL_FROM`/`MAIL_REGION` (also used
as the Cognito verification-email sender — see step 3). Redeploy:

```bash
cd backend
node scripts/deploy.mjs deploy.config.<name>.json
```

That's it — the **Invite a user** form on `/admin` now sends an email by
default. If SES rejects the send (sandbox: unverified recipient, identity
not yet DKIM-verified, throttled), the invite row is still written and
the form shows the `signupUrl` so you can copy/paste it manually.

(This is exactly what `deploy.mjs`'s `frontend` block automates — see step 3.
The `frontend/.env.local` route is still there for **local dev** against
`npm run dev`, not for deploying; see "Local development" below.)

## Custom Cognito domain (optional)

By default Cognito's Hosted UI lives at an auto-generated
`<stackname>.auth.<region>.amazoncognito.com` domain — functional, but it
reads as an unfamiliar/untrusted address to real users on the sign-in screen.
Mapping it to something under your own domain (e.g. `auth.your-domain.example`)
fixes that. This is a **one-time, manual** step — not part of `deploy.mjs`,
because it needs a domain only you control and briefly interrupts sign-in
for *everyone* while it's mid-flight (see the downtime note below), so it
shouldn't happen as a side effect of a routine redeploy.

A Cognito user pool has exactly **one** domain at a time — switching means
deleting the old one and creating the new one, with a real gap in between
(the new domain's CloudFront distribution typically takes 15–60 min to go
live). Do this when it's fine for sign-in to be briefly unavailable.

1. **Request an ACM cert** for your chosen subdomain, **in `us-east-1`**
   regardless of where your stack runs (Cognito custom domains are always
   served via CloudFront):
   ```bash
   aws acm request-certificate --domain-name auth.your-domain.example \
     --validation-method DNS --region us-east-1
   ```
   Add the DNS validation CNAME it gives you (`aws acm describe-certificate
   --certificate-arn <arn> --region us-east-1 --query
   "Certificate.DomainValidationOptions[0].ResourceRecord"`) to your hosted
   zone, then wait for `Status` to become `ISSUED`.

2. **Gotcha:** Cognito requires your domain's *parent* to already resolve
   (have an A record) before it'll create a subdomain custom domain — even
   though the record isn't otherwise related to Cognito at all. If your
   apex domain has no A record yet, add one (e.g. alias it to any
   CloudFront distribution you already have, like your frontend's) before
   the next step, or `create-user-pool-domain` fails with "Was not able to
   resolve a DNS A record for the parent domain."

3. **Swap the domain** (this is the disruptive step):
   ```bash
   aws cognito-idp delete-user-pool-domain --domain <old-domain-prefix> --user-pool-id <pool-id>
   aws cognito-idp create-user-pool-domain --domain auth.your-domain.example \
     --user-pool-id <pool-id> \
     --custom-domain-config CertificateArn=<the-acm-cert-arn>
   ```
   The create call returns a `CloudFrontDomain` (e.g. `d123abc.cloudfront.net`)
   — alias your subdomain to it. The Route 53 alias-target hosted zone ID for
   *any* CloudFront distribution is always the constant `Z2FDTNDATAQYW2`:
   ```bash
   aws route53 change-resource-record-sets --hosted-zone-id <your-zone-id> --change-batch '{
     "Changes": [{
       "Action": "UPSERT",
       "ResourceRecordSet": {
         "Name": "auth.your-domain.example.",
         "Type": "A",
         "AliasTarget": { "HostedZoneId": "Z2FDTNDATAQYW2", "DNSName": "<CloudFrontDomain>.", "EvaluateTargetHealth": false }
       }
     }]
   }'
   ```
   Poll `aws cognito-idp describe-user-pool-domain --domain auth.your-domain.example`
   until `Status` is `ACTIVE`.

4. **Point the backend at it**: set `cognitoCustomDomain` in your
   `deploy.config.<name>.json` to the new domain and redeploy — this updates
   `GET /config` (for the mobile app) and the `CognitoDomain` stack output
   (for the frontend build).

5. **Rebuild + redeploy the frontend** — its bundle has the *old* domain
   baked in from the last build and won't pick up the new one just because
   the backend redeployed (see step 3's `frontend` block).

6. **Update Google/Facebook redirect URIs**: Cognito sends `<new-domain>/oauth2/idpresponse`
   as the callback to each IdP now, not the old domain — add that URL in
   both consoles (see step 1) or federated sign-in breaks. Email/password
   sign-in is unaffected (no external IdP redirect involved).

## 5. First sign-in + configure a mount

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

## 6. Inviting another user

In Admin → **Invite a user**:

- Email must match the Google account they'll sign in with
- Pick a TTL (14 days default)
- Optionally check **Make admin** to give them admin rights on first sign-in
- **Send invite email** is on by default — the invitee gets an email from
  `noreply@schuit.io` with the signup link. Uncheck it if you want to
  share the link out-of-band (Slack, etc.). If SES is still in sandbox
  and the recipient isn't verified, the form shows a warning + the link
  so you can paste it yourself.

They go to https://sharing.schuit.io and use **Sign in with Google**, **Sign in
with Facebook**, or **Sign in with email → Sign up** (email/password users get a one-time verification
code — sent by Cognito's default email sender, which is *not* subject to the SES
sandbox, so it reaches any invitee). Either way, the `preSignUp` Lambda trigger lets
them in based on the invite row in DynamoDB; `postAuth` adds them to any groups and
marks the invite redeemed.

## Local development

```bash
# Backend: deploy your samtest (or other dev) stage as in step 3.
# Frontend:
cd frontend
cp .env.example .env.local
# Set VITE_API_BASE to the raw ApiEndpoint output (no trailing /api -- that
# prefix only exists behind the CloudFront distribution, not talking to API
# Gateway directly)
# Set VITE_USER_POOL_CLIENT_ID / VITE_COGNITO_DOMAIN to that stack's outputs
# Set VITE_REDIRECT_URI to http://localhost:5173/auth/callback
# Set VITE_LOGOUT_REDIRECT to http://localhost:5173/

npm install
npm run dev
```

Add `http://localhost:5173/auth/callback` to:
- the Cognito User Pool Client's **Callback URLs** (already included by `template.yaml`'s `webCallbackUrls` default)
- the Google OAuth client's and Facebook app's authorized redirect URIs (optional — only if you want to test the full Google/Facebook → Cognito → app flow against a dev Cognito domain)

## Continuous deployment (GitHub Actions)

Pushes to `main` deploy to prod via `.github/workflows/deploy.yml` — no
long-lived AWS keys (GitHub OIDC → a scoped IAM role). The workflow writes a
repo secret's contents to `backend/deploy.config.json` (the file itself is
gitignored — see step 3) and runs `node scripts/deploy.mjs deploy.config.json`,
which does everything: SAM build+deploy, Cognito wiring, and the frontend
build+sync+invalidation.

**One-time setup:**

1. Create the deploy role (the only step needing your hands, since it grants deploy access):
   ```bash
   aws cloudformation deploy \
     --region us-east-1 \
     --stack-name schuit-sharing-gha \
     --template-file infrastructure/github-oidc.yml \
     --capabilities CAPABILITY_NAMED_IAM
   ```
2. Add a repo secret named `DEPLOY_CONFIG_PROD` containing your real
   `deploy.config.<name>.json` file's full contents (secrets that need
   real OAuth client secrets pulled from SSM still work fine — the deploy
   role just needs `ssm:GetParameter` on those paths, which it already has).

The CloudFormation deploy above creates `schuit-sharing-gha-deploy`, trusted
only by `SturgeonTechnologies/schuit-sharing` on `main` (via the account's
existing GitHub OIDC provider). The workflow already references this role
ARN — update it in `deploy.yml` if you fork this under a different repo.
After the role exists and the secret's set, push to `main` (or run the
workflow manually from the Actions tab).

> The role's policy is scoped by resource for S3/IAM/SSM/CloudFront/DynamoDB but
> broad (service-level) for CloudFormation/Lambda/API Gateway/Cognito, which are
> hard to resource-scope for a SAM deploy. Tighten later if desired.
>
> The bucket's Public Access Block + CORS are set out-of-band and are **not**
> touched by CI. First-ever admin bootstrap (a real sign-in) also can't be done
> by CI — already done here.

## Security notes

- **Cognito is the trust boundary.** The API Gateway JWT authorizer validates every request. Lambdas extract `email`, `sub`, and `cognito:groups` from verified claims.
- **Provisioning runs in the `preTokenGen` trigger**, not `postAuth` — the Post Authentication trigger does *not* fire for hosted-UI/federated sign-ins, so admin-bootstrap, group assignment, and invite-redemption live in Pre Token Generation (which does fire) and it overrides `cognito:groups` so the current token is correct.
- **Invites live in DynamoDB with TTL**; expired rows are removed automatically by DynamoDB TTL.
- **Bucket is fully private.** S3 **Public Access Block is on** (legacy public object ACLs are ignored). Authenticated downloads are 5-minute presigned GETs minted per-request (logged to CloudWatch with caller email, mount, key). The only public path is an explicit per-file share: an opaque token in `public-shares` that the unauthenticated `/public/{token}` endpoint resolves to a fresh presigned GET (revocable).
- **Writes are code-gated.** Upload/create-dir/delete use `s3:PutObject`/`s3:DeleteObject` on the shares bucket, restricted in code to a mount's prefix (with `..`/`\` traversal guards). File/directory **delete is admin-only**; the bucket is unversioned so deletes are permanent.
- **Directory traversal** (`..`, `\`) is rejected in `backend/src/lib/mounts.ts` and the explorer/upload/delete handlers.
- **CloudFront → S3** uses OAC; the bucket policy allows only the distribution. **CloudFront → API** uses `AllViewerExceptHostHeader` so `Authorization` is forwarded and Host is rewritten to API Gateway.
- **One email = one sign-in method** (Google *or* password) — the pool keys on email as username; mixing collides.

## Tighten for production

- Change `httpApi.cors.allowedOrigins` from `*` to `https://sharing.schuit.io`.
- Publish the Google OAuth consent screen out of **Testing** so invitees can sign in without being test users.
- Add a WAF web ACL to the CloudFront distribution.
- Add CloudWatch alarms on Lambda errors/throttles and DynamoDB throttles.
- Turn on MFA in Cognito (`MfaConfiguration: OPTIONAL`) for the email/password accounts.
- Consider CloudFront signed URLs for very large files; S3 presigned GETs are fine up to a few hundred MB.
Done already: SES production access, the S3 Public Access Block lockdown described above, and **GitHub Actions CD** (see the section above; run the one-time role setup to activate it).
