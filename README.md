# schuit-sharing

A mostly 'vibed' full stack application to assist with sharing between messaging applications and operating systems.  

An invite-only web app for browsing and downloading files stored in S3. Auth is
**Cognito** (Google, Facebook, or email + password), access is controlled per-mount, and admins
invite users by email. There's also a companion mobile app (Expo/React Native) that consumes the
same backend.

This README walks through deploying your own copy end-to-end. Every example below uses the
placeholder domain **`slapchop.vinceoffer.com`** — swap in whatever domain you actually
control as you go.

## Requirements

Before you start, make sure you have:

- [ ] **An AWS account** with billing enabled — [Sign up for AWS](https://portal.aws.amazon.com/billing/signup)
- [ ] **AWS CLI installed and configured** with credentials for that account — [Install & configure the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [ ] **Node.js 20+ and npm** — [Install Node.js](https://nodejs.org/en/download)
- [ ] **AWS SAM CLI ≥ 1.163** — [Install the AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [ ] **A domain you control, with a Route 53 hosted zone** (or one you can create) — this is what `slapchop.vinceoffer.com` stands in for below
- [ ] *(Optional)* **A Google Cloud project** for Google sign-in — skip this and Facebook below if you only want email/password
- [ ] *(Optional)* **A Meta for Developers app** for Facebook sign-in — [developers.facebook.com](https://developers.facebook.com/)

### Quick start

Once you have the above and (if you want federated sign-in) OAuth clients from step 1 below,
`./quickstart.sh` (macOS/Linux) or `.\quickstart.ps1` (Windows) will walk you through the rest
interactively — bucket creation, OAuth secrets, and the backend, frontend hosting, and SES
deploys (steps 2 through 4b). It's a convenience wrapper, not a replacement for understanding
what it's doing — the numbered steps below are still the reference for what each one does and
the raw commands, in case anything doesn't fit your setup.

Every prompt it asks can be preset with a `--flag` or env var instead, so you can rerun the same
test deployment without retyping everything each time — `--yes` accepts the suggested default
for anything you didn't explicitly preset:

```bash
node scripts/quickstart.mjs --space devtest --domain devtest.your-domain.example --admin-email you@example.com --yes
```

See the header comment in `scripts/quickstart.mjs` for the full flag/env var list. Space names
are auto-sanitized into something DNS- and stack-name-safe (lowercase, hyphens, starts with a
letter) — `"My Test Space!"` becomes `my-test-space` — since that name feeds the CloudFormation
stack names, the Cognito domain prefix, and (once you add a domain) DNS labels.

When you're done with a test space, tear it down (deletes the backend/frontend/SES stacks by the
naming convention above, or from `deploy.config.<space>.json` if present):

```bash
node scripts/teardown.mjs --space devtest --yes
```

It refuses to run against anything that looks like prod (`stage: "prod"` in the config, or a
space literally named `prod`) unless you type a literal confirmation phrase first — there's no
flag to skip that part.

- Auth: **Cognito** — sign in with **Google**, **Facebook**, *or* **email + password**
  (all via the Cognito hosted UI; email/password users self-register through the invite
  gate and verify their address with a one-time code). Email/password always works;
  the Google/Facebook buttons only appear on the Login page once you've actually
  configured that provider (step 1) — the frontend checks `GET /config` at load and
  hides whichever ones aren't wired up, rather than showing a button that dead-ends
  at a Cognito error.
- First admin(s): whichever email(s) you list in `bootstrapAdminEmails` in your deploy config —
  they're auto-promoted to admin on first sign-in, no manual setup needed
- Admins invite other users by email; invitees go to the site and "Sign in with
  Google", "Sign in with Facebook", or "Sign in with email" → "Sign up"
- Admins configure **mounts** — a URL path (e.g. `/roms`) mapped to an S3 prefix (e.g. `s3://your-bucket/Video_Game_ROMs/`). The Admin page has an **Explore bucket** browser that lists the real S3 layout so a directory can be turned into a mount in one click.

### Features

- **Auth:** Google + Facebook + email/password (all via the Cognito hosted UI, themed to match the site).
- **Mounts** with per-mount access control (`allowedEmails`; blank = admins-only). **Add/modify** a mount or manage its users from the Admin page (with email autocomplete + auto-invite of anyone granted who isn't invited yet).
- **Invites/Access** — invite users; the list shows everyone with access (active users + pending invites).
- **Admin bucket explorer** — browse the raw bucket, **create** a directory, **delete** a directory (type-name + "confirm" guard), and per-file Public / Download / Delete.
- **Browse** any mount you can see: **download** (presigned), **upload** files, admins can **delete**, and admins can toggle a file **Public** (opaque token → presigned redirect, revocable, bucket stays private).
- **Image/video thumbnails and an in-browser player** — image and video files (detected by extension) get a lazy-loaded thumbnail in Browse, the admin explorer, and search results; clicking a video or audio file opens it in a streaming player instead of forcing a download (useful on mobile, where triggering a file download is often awkward).
- **Global file search** across every mount you can access.
- **Profile** page + a user dropdown menu.

> **One email = one sign-in method.** Because the pool uses the email as the
> username, a given address should use **exactly one** of Google, Facebook, or a
> password — never a mix. Signing in with a second method for an email that
> already exists under another collides in Cognito (`already found an entry for
> username`). Automatic account-linking is not configured, so pick one method per
> invitee.
- Everything behind a single CloudFront distribution on your domain (e.g. `slapchop.vinceoffer.com`)

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
 slapchop.vinceoffer.com ─▶│ CloudFront distribution   │
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
                        │ S3: your-    │◀───────────┘
                        │ bucket/...   │   presigned GETs
                        └──────────────┘
```

## 1. Create the OAuth clients (Google + Facebook)

### Google

1. Go to https://console.cloud.google.com/ → pick (or create) a project.
2. **APIs & Services → OAuth consent screen**: create one (External, add your email as a test user if you leave it in Testing; publish later).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `https://slapchop.vinceoffer.com`
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
  --name /slapchop/prod/google/client_id \
  --type String \
  --value '<google-client-id>'

aws ssm put-parameter \
  --name /slapchop/prod/google/client_secret \
  --type SecureString \
  --value '<google-client-secret>'

# --- Facebook (client_id = App ID, client_secret = App Secret) ---
aws ssm put-parameter \
  --name /slapchop/prod/facebook/client_id \
  --type String \
  --value '<facebook-app-id>'

aws ssm put-parameter \
  --name /slapchop/prod/facebook/client_secret \
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
- `resourcePrefix` — **must be unique from every other deployment in the same
  AWS account** (or use a different `stage`) — it names the DynamoDB tables
  and the auto-generated Cognito domain, both of which collide silently
  with another deployment's if this matches (SAM's own early-validation will
  catch the DynamoDB case with a clear error before changing anything; a
  Cognito domain collision is caught the same way). Usually just your space
  name — different from `stackName`/`functionNamePrefix` on purpose, since
  those two need to differ from a still-live *pre-SAM* deployment's names in
  adopt mode, while `resourcePrefix` needs to *match* one.
- `sharesBucket` / `siteOrigin` / `allowedOrigins` / `appDisplayName` /
  `bootstrapAdminEmails` / `mailFrom` — your space's basics. `bootstrapAdminEmails`
  is who gets auto-promoted to admin on first sign-in — no manual user/group setup needed.
- `oauth` — omit entirely for email/password-only. When present, only SSM
  *parameter names* go in the file (see step 2) — the actual secret values
  are pulled from SSM at deploy time, never written to this file.
- `adopt` — omit for a brand-new space (this creates a fresh Cognito pool +
  tables). Only needed if you're pointing a new compute stack at an existing
  pool.
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

## 4. Deploy the frontend infra (SPA hosting)

`infrastructure/frontend-infra.yml` creates:

- ACM certificate for your chosen domain (DNS-validated)
- CloudFront Origin Access Control (OAC)
- CloudFront distribution, single origin: your existing shares bucket,
  scoped to the `web/` prefix
- Route 53 A-alias `<your domain> → CloudFront`

**Recommended: the SPA goes at your bare/apex domain** (e.g. `vinceoffer.com`,
not `slapchop.vinceoffer.com`) — see "Custom domains" below for why (the API and
Cognito get their *own* subdomains instead, so nothing needs to share the
apex with path-based routing). `DomainName` accepts anything, though; use a
subdomain if you'd rather.

The SPA lives at `s3://your-bucket/web/`. No dedicated site bucket is created — one bucket hosts both the SPA (`web/`) and the shared files (`Video_Game_ROMs/`, etc.). CloudFront's OAC is scoped to `web/*` only, so the distribution cannot serve anything outside that prefix. The API is **not** proxied through this distribution — see "Custom domains" for how it's reached instead.

> [!CAUTION]
> **DNS model — read this first.** **You only need the parent hosted zone**
> (e.g. `vinceoffer.com`) — there is **no** separate hosted zone needed for a
> subdomain. Subdomains are just records inside the parent zone. This stack
> adds a temporary CNAME for ACM validation (removed after the cert issues)
> and a permanent A-alias for whatever `DomainName` you give it.

If your domain isn't in Route 53 yet:

```bash
aws route53 create-hosted-zone \
  --name your-domain.example \
  --caller-reference "$(date +%s)"
# then point your domain registrar at the 4 nameservers it prints
```

### Deploy

**Must be deployed in `us-east-1`** — CloudFront requires its ACM cert in that region.

Easiest: use the helper script (auto-discovers the hosted zone ID):

```bash
cd infrastructure
DOMAIN=your-domain.example ./deploy.sh
```

Or run it manually:

```bash
HOSTED_ZONE_ID=ZXXXXXXXXXXXXX

aws cloudformation deploy \
  --region us-east-1 \
  --stack-name your-space-name-frontend \
  --template-file infrastructure/frontend-infra.yml \
  --parameter-overrides \
      DomainName=your-domain.example \
      HostedZoneId=$HOSTED_ZONE_ID \
      SiteBucket=your-bucket \
      SitePrefix=web \
      SiteBucketRegion=us-east-1 \
  --capabilities CAPABILITY_IAM
```

Outputs:
- `SiteBucketName` — your bucket name
- `SitePrefix` — `web`
- `SiteUploadPath` — `s3://your-bucket/web/` (sync target)
- `DistributionId` — for cache invalidation
- `Url` — `https://slapchop.vinceoffer.com`

> **Heads-up on bucket policy:** this stack now owns the bucket policy on
> your shares bucket (the OAC grant). Don't set a bucket policy manually or
> via another tool — put any additional statements in `SiteBucketPolicy`
> inside `frontend-infra.yml` and redeploy. Lambda access to shared files
> uses IAM (not the bucket policy), so this doesn't affect the backend.

## 4b. Deploy the SES email stack (for invite emails)

`infrastructure/email-infra.yml` creates the SES sending identity for your
domain so the backend can email invitees from `noreply@vinceoffer.com`.
It coexists with an existing mail provider (Google Workspace, etc.) on the
same root domain because:

- DKIM uses unique selector subdomains (`<token>._domainkey.vinceoffer.com`),
  not your existing provider's DKIM selector. They don't collide.
- The custom **MAIL FROM** lives on a *subdomain* (`mail.vinceoffer.com`), with
  its own MX (`feedback-smtp.us-east-1.amazonses.com`) and SPF
  (`v=spf1 include:amazonses.com ~all`). The root domain's MX and
  any root SPF stay untouched.
- Outbound mail still says `From: noreply@vinceoffer.com` and is DKIM-signed
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
  --stack-name your-space-name-email \
  --template-file infrastructure/email-infra.yml \
  --parameter-overrides \
      Domain=your-domain.example \
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
  --identities your-domain.example \
  --query 'VerificationAttributes."your-domain.example".VerificationStatus' \
  --output text
```

`Success` means you're good to send.

### Sandbox mode (one-time gate)

A brand-new SES account is in **sandbox**: you can only send to *verified*
recipient addresses (max 200 messages/day, 1/sec). For initial testing,
verify your own inbox:

```bash
aws ses verify-email-identity --region us-east-1 \
  --email-address you@example.com
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

## Custom domains (recommended)

**Recommended layout** — three independent pieces, each on its own
subdomain, none of them proxying through another:

| Piece | Domain | Why its own subdomain |
|---|---|---|
| SPA (step 4) | `your-domain.example` (apex) | The main thing people visit and bookmark. |
| API | `sharing-api.your-domain.example` | Called cross-origin directly from the SPA — no CloudFront path-routing to keep in sync, no `/api` prefix-stripping function, no ambiguity for API clients (mobile app discovery, `curl`, etc.) about whether a bare path or a `/api`-prefixed one is correct. |
| Cognito Hosted UI | `sharing-auth.your-domain.example` | Otherwise it's the auto-generated `*.amazoncognito.com` address — functional, but reads as an unfamiliar/untrusted domain to real users on the sign-in screen. |

Both the API and Cognito domains are **optional** — omit `apiCustomDomain`/`cognitoCustomDomain`
from your config to keep the raw `execute-api.amazonaws.com` URL and the
auto-generated `amazoncognito.com` domain instead. Neither is part of
`deploy.mjs`'s automated flow, and deliberately so:

> [!CAUTION]
> **Read this first.** Both need a domain only *you* control (can't be
> scripted generically), and the Cognito swap specifically **interrupts
> sign-in for everyone** while it's mid-flight — a user pool has exactly one
> domain at a time, so switching means deleting the old one and creating the
> new one, with a real gap in between (the new domain's CloudFront
> distribution typically takes 15–60 min to go live). Do these when it's
> fine for sign-in to be briefly unavailable, not as a side effect of a
> routine redeploy.

### API custom domain

1. **Request an ACM cert** for `sharing-api.your-domain.example`, in the
   **same region your API runs in** (regional API Gateway custom domains
   don't need `us-east-1` the way CloudFront/Cognito do):
   ```bash
   aws acm request-certificate --domain-name sharing-api.your-domain.example \
     --validation-method DNS --region <your-region>
   ```
   Add the DNS validation CNAME (`aws acm describe-certificate
   --certificate-arn <arn> --region <your-region> --query
   "Certificate.DomainValidationOptions[0].ResourceRecord"`), wait for
   `Status` to become `ISSUED`.

2. **Set `apiCustomDomain` + `apiCustomDomainCertArn`** in your
   `deploy.config.<name>.json` and redeploy (`node scripts/deploy.mjs
   deploy.config.<name>.json`) — this creates the `ApiGatewayV2::DomainName`
   + `ApiMapping` resources and prints two new outputs: `ApiCustomDomainTarget`
   (the regional domain to alias) and `ApiCustomDomainHostedZoneId`.

3. **Alias your subdomain to it**:
   ```bash
   aws route53 change-resource-record-sets --hosted-zone-id <your-zone-id> --change-batch '{
     "Changes": [{
       "Action": "UPSERT",
       "ResourceRecordSet": {
         "Name": "sharing-api.your-domain.example.",
         "Type": "A",
         "AliasTarget": { "HostedZoneId": "<ApiCustomDomainHostedZoneId>", "DNSName": "<ApiCustomDomainTarget>.", "EvaluateTargetHealth": false }
       }
     }]
   }'
   ```
   (Unlike CloudFront's fixed `Z2FDTNDATAQYW2`, the API Gateway alias-target
   hosted zone ID is domain-specific — always use the `ApiCustomDomainHostedZoneId`
   output, not a hardcoded constant.)

4. **Rebuild + redeploy the frontend** (step 3's `frontend` block) — its
   bundle has the API URL baked in at build time and won't pick up the new
   domain just because the backend redeployed.

### Cognito custom domain

1. **Request an ACM cert** for `sharing-auth.your-domain.example`, **in
   `us-east-1`** regardless of where your stack runs (Cognito custom domains
   are always served via CloudFront):
   ```bash
   aws acm request-certificate --domain-name sharing-auth.your-domain.example \
     --validation-method DNS --region us-east-1
   ```
   Validate the same way as above, wait for `ISSUED`.

2. **Gotcha:** Cognito requires your domain's *parent* to already resolve
   (have an A record) before it'll create a subdomain custom domain — even
   though the record isn't otherwise related to Cognito at all. If your
   apex domain has no A record yet (e.g. you haven't done step 4), add one
   (alias it to any CloudFront distribution you already have) first, or
   `create-user-pool-domain` fails with "Was not able to resolve a DNS A
   record for the parent domain."

3. **Swap the domain** (this is the disruptive step):
   ```bash
   aws cognito-idp delete-user-pool-domain --domain <old-domain-prefix> --user-pool-id <pool-id>
   aws cognito-idp create-user-pool-domain --domain sharing-auth.your-domain.example \
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
         "Name": "sharing-auth.your-domain.example.",
         "Type": "A",
         "AliasTarget": { "HostedZoneId": "Z2FDTNDATAQYW2", "DNSName": "<CloudFrontDomain>.", "EvaluateTargetHealth": false }
       }
     }]
   }'
   ```
   Poll `aws cognito-idp describe-user-pool-domain --domain sharing-auth.your-domain.example`
   until `Status` is `ACTIVE`.

4. **Point the backend at it**: set `cognitoCustomDomain` in your
   `deploy.config.<name>.json` to the new domain and redeploy — this updates
   `GET /config` (for the mobile app) and the `CognitoDomain` stack output
   (for the frontend build).

5. **Rebuild + redeploy the frontend** — same reason as above, its bundle
   has the *old* domain baked in from the last build.

6. **Update Google/Facebook redirect URIs**: Cognito sends `<new-domain>/oauth2/idpresponse`
   as the callback to each IdP now, not the old domain — add that URL in
   both consoles (see step 1) or federated sign-in breaks. Email/password
   sign-in is unaffected (no external IdP redirect involved).

## 5. First sign-in + configure a mount

1. Open `https://slapchop.vinceoffer.com`
2. Click **Sign in with Google** (or Facebook, or email) → sign in as one of your `bootstrapAdminEmails`
3. You should land on the Home page. Click **Admin** in the nav.
4. Scroll to **Add a shared directory (mount)**. Defaults are pre-filled:
   - Path: `roms`
   - Display name: `Video Game ROMs`
   - S3 prefix: `Video_Game_ROMs/`
   - Bucket: *(leave blank; defaults to your configured shares bucket)*
5. Click **Add mount**.
6. Head back to Home → click **Video Game ROMs** → browse and download.

## 6. Inviting another user

In Admin → **Invite a user**:

- Email must match the account they'll sign in with (Google/Facebook email, or the address they'll use for email/password)
- Pick a TTL (14 days default)
- Optionally check **Make admin** to give them admin rights on first sign-in
- **Send invite email** is on by default — the invitee gets an email from
  `noreply@vinceoffer.com` with the signup link. Uncheck it if you want to
  share the link out-of-band (Slack, etc.). If SES is still in sandbox
  and the recipient isn't verified, the form shows a warning + the link
  so you can paste it yourself.

They go to `https://slapchop.vinceoffer.com` and use **Sign in with Google**, **Sign in
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

Pushes to `main` deploy via `.github/workflows/deploy.yml` — no
long-lived AWS keys (GitHub OIDC → a scoped IAM role). The workflow writes a
repo secret's contents to `backend/deploy.config.json` (the file itself is
gitignored — see step 3) and runs `node scripts/deploy.mjs deploy.config.json`,
which does everything: SAM build+deploy, Cognito wiring, and the frontend
build+sync+invalidation.

**One-time setup:**

1. Create the deploy role (the only step needing your hands, since it grants deploy access).
   `infrastructure/github-oidc.yml`'s IAM policy resource ARNs (CloudFormation
   stack, Lambda, DynamoDB, log groups, SSM path, the serverless deployment
   bucket) and its role name are all derived from `ResourcePrefix`/`Stage`
   parameters — pass the same `resourcePrefix`/`stage` values you used (or
   will use) in your `deploy.config.<name>.json` so the role actually has
   permission to touch your stack's resources:
   ```bash
   aws cloudformation deploy \
     --region us-east-1 \
     --stack-name your-space-name-gha \
     --template-file infrastructure/github-oidc.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides ResourcePrefix=your-space-name Stage=prod
   ```
   The defaults (`schuit-sharing`/`prod`) match this project's own
   deployment, so omitting `--parameter-overrides` entirely is only correct
   if you kept those same names. The role is named
   `<ResourcePrefix>-gha-deploy` unless you also override `RoleName`.
2. Add a repo secret named `DEPLOY_CONFIG_PROD` containing your real
   `deploy.config.<name>.json` file's full contents (secrets that need
   real OAuth client secrets pulled from SSM still work fine — the deploy
   role just needs `ssm:GetParameter` on those paths, which it already has).

The CloudFormation deploy above creates `<ResourcePrefix>-gha-deploy`
(`schuit-sharing-gha-deploy` with the defaults), trusted only by your fork's
`<owner>/<your-repo-name>` on `main` (via your account's GitHub OIDC
provider). Update the role ARN referenced in `deploy.yml` to match your
fork's role name before relying on it. After the role exists and the
secret's set, push to `main` (or run the workflow manually from the Actions
tab).

> The role's policy is scoped by resource for S3/IAM/SSM/CloudFront/DynamoDB but
> broad (service-level) for CloudFormation/Lambda/API Gateway/Cognito, which are
> hard to resource-scope for a SAM deploy. Tighten later if desired.
>
> The bucket's Public Access Block + CORS are set out-of-band and are **not**
> touched by CI. First-ever admin bootstrap (a real sign-in) also can't be done
> by CI — do that yourself once the stack is live.

## Security notes

- **Cognito is the trust boundary.** The API Gateway JWT authorizer validates every request. Lambdas extract `email`, `sub`, and `cognito:groups` from verified claims.
- **Provisioning runs in the `preTokenGen` trigger**, not `postAuth` — the Post Authentication trigger does *not* fire for hosted-UI/federated sign-ins, so admin-bootstrap, group assignment, and invite-redemption live in Pre Token Generation (which does fire) and it overrides `cognito:groups` so the current token is correct.
- **Invites live in DynamoDB with TTL**; expired rows are removed automatically by DynamoDB TTL.
- **Bucket is fully private.** S3 **Public Access Block is on** (legacy public object ACLs are ignored). Authenticated downloads are 1-hour presigned GETs minted per-request (logged to CloudWatch with caller email, mount, key) — long enough to stream/scrub a video via the in-browser player without the link expiring mid-playback. The public per-file share resolver (`/public/{token}`) still mints its own separate 5-minute presigned GET. The only public path is that explicit per-file share: an opaque token in `public-shares` that the unauthenticated `/public/{token}` endpoint resolves to a fresh presigned GET (revocable).
- **Writes are code-gated.** Upload/create-dir/delete use `s3:PutObject`/`s3:DeleteObject` on the shares bucket, restricted in code to a mount's prefix (with `..`/`\` traversal guards). File/directory **delete is admin-only**; the bucket is unversioned so deletes are permanent.
- **Directory traversal** (`..`, `\`) is rejected in `backend/src/lib/mounts.ts` and the explorer/upload/delete handlers.
- **CloudFront → S3** uses OAC; the bucket policy allows only the distribution. **CloudFront → API** uses `AllViewerExceptHostHeader` so `Authorization` is forwarded and Host is rewritten to API Gateway.
- **One email = one sign-in method** (Google *or* password) — the pool keys on email as username; mixing collides.

## Tighten for production

- Change `httpApi.cors.allowedOrigins` from `*` to `https://slapchop.vinceoffer.com`.
- Publish the Google OAuth consent screen out of **Testing** so invitees can sign in without being test users.
- Add a WAF web ACL to the CloudFront distribution.
- Add CloudWatch alarms on Lambda errors/throttles and DynamoDB throttles.
- Turn on MFA in Cognito (`MfaConfiguration: OPTIONAL`) for the email/password accounts.
- Request SES production access (see 4b) so invite mail isn't limited to sandbox-verified recipients.
- Consider CloudFront signed URLs for very large files; S3 presigned GETs are fine up to a few hundred MB.
- Set up GitHub Actions CD (see above) once you're happy with a config and want pushes to `main` to deploy automatically.

## How long does this take?

Budget about **an hour** for a full first-time deployment, start to finish — OAuth client
setup, backend + frontend deploys, DNS/ACM certificate validation, and SES DKIM verification.
Most of that hour is *waiting* (DNS propagation, ACM issuance, SES verification), not active
work, so it's a good excuse to get coffee partway through rather than something you need to
babysit.
