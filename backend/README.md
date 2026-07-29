# Backend deployment

Serverless Framework app — API Gateway (HTTP API) + Lambda (Node 20) + Cognito User Pool + DynamoDB + S3.

## Prereqs

- Node 20, npm
- Serverless Framework v3: `npm i -g serverless`
- AWS CLI configured with a profile that can deploy to the target account/region
- Google OAuth client ID + secret (see `../README.md` step 1)
- Facebook App ID + App Secret (Meta for Developers → your app → Settings → Basic)

## 1. Store Google + Facebook creds in SSM

The stack reads both providers' OAuth creds from SSM Parameter Store at deploy time.

```bash
STAGE=prod   # 'prod' is the live deployment; 'dev' is reserved for a future personal sandbox

# --- Google ---
aws ssm put-parameter \
  --name /schuit-sharing/$STAGE/google/client_id \
  --type String \
  --value '<google-client-id>' \
  --overwrite

aws ssm put-parameter \
  --name /schuit-sharing/$STAGE/google/client_secret \
  --type SecureString \
  --value '<google-client-secret>' \
  --overwrite

# --- Facebook (client_id = App ID, client_secret = App Secret) ---
aws ssm put-parameter \
  --name /schuit-sharing/$STAGE/facebook/client_id \
  --type String \
  --value '<facebook-app-id>' \
  --overwrite

aws ssm put-parameter \
  --name /schuit-sharing/$STAGE/facebook/client_secret \
  --type SecureString \
  --value '<facebook-app-secret>' \
  --overwrite
```

## 2. Install & deploy

```bash
cd backend
npm install

npx serverless deploy --stage prod
```

This provisions:

- `UserPool` — Cognito User Pool with **`COGNITO` (email/password) + Google + Facebook** as IdPs (created **without** Lambda triggers — see step 3)
- `UserPoolClient` — OAuth code + PKCE, callback URLs wired to both prod (`https://sharing.schuit.io/auth/callback`) and dev (`http://localhost:5173/auth/callback`)
- `UserPoolDomain` — hosted UI domain (Amazon-provided: `schuit-sharing-<stage>-<acct>.auth.<region>.amazoncognito.com`)
- `InvitesTable` (DynamoDB, email PK, TTL), `MountsTable` (mountPath PK), `PublicSharesTable` (mountPath+path PK, `TokenIndex` GSI on the token)
- Lambdas:
  - *triggers:* `preSignUp`, `postAuth`, `preTokenGen`
  - *admin:* `createInvite`, `listInvites`, `revokeInvite`, `listAccess`, `createMount`, `updateMount`, `deleteMount`, `exploreBucket`, `createFolder`, `deleteDirectory`, `exploreDownloadUrl`, `exploreDeleteFile`, `explorePublic`, `setPublic`, `unsetPublic`
  - *user:* `listMounts`, `search`, `browseList`, `browseDownloadUrl`, `uploadUrl`, `deleteFile`
  - *public (no authorizer):* `resolvePublic` (`GET /public/{token}`)
- HTTP API with a JWT authorizer pointing at the User Pool (the `/public/{token}` route is intentionally unauthenticated)

## 3. Wire the Cognito Lambda triggers (and hosted-UI theme)

The `preSignUp`, `postAuth`, and `preTokenGen` Lambdas can't be wired into the
UserPool's `LambdaConfig` from CloudFormation — doing so creates a circular
dependency (UserPool → trigger Lambdas → IAM role + HttpApi authorizer →
UserPool). Instead, run the post-deploy script. It also applies the hosted-UI
dark-theme CSS (`SetUICustomization`, which has no CloudFormation resource).
It's idempotent — safe to re-run after every deploy.

> **Which trigger does what:** `preSignUp` gates who may sign up (bootstrap
> admin or an active invite). **`preTokenGen`** does the real provisioning —
> bootstrap-admin promotion, invite group assignment, and marking the invite
> redeemed — because it fires for hosted-UI/federated sign-ins. `postAuth` does
> *not* fire for the hosted UI (it stays wired for completeness only).

```bash
npm run wire-triggers:prod     # the live deployment
# or, for a future sandbox:
npm run wire-triggers          # stage=dev (default)
```

Output:

```
==> Looking up resources from stack schuit-sharing-prod in us-east-1
    UserPoolId       = us-east-1_XXXXXXXXX
    PreSignUp ARN    = ...:function:schuit-sharing-prod-preSignUp
    PostAuth ARN     = ...:function:schuit-sharing-prod-postAuth
    PreTokenGen ARN  = ...:function:schuit-sharing-prod-preTokenGen
==> Applying hosted-UI customization (dark theme)
==> Fetching current UserPool config
==> Updating UserPool with new LambdaConfig
==> Done. Triggers are now wired:
    PreSignUp / PostAuthentication / PreTokenGeneration
```

The script reads the current pool config and re-passes everything (because
`UpdateUserPool` resets fields you don't include) plus the new `LambdaConfig`.
Lambda `InvokeFunction` permissions for the Cognito principal are already
granted by the CloudFormation stack — the script only sets the `LambdaConfig`.

> **You must run this once after the first deploy.** Until the triggers are
> wired, sign-up isn't gated by invites and no one gets provisioned (no admin
> bootstrap, no group/invite handling) — because `preSignUp`/`preTokenGen`
> aren't attached to the pool yet.

If you re-run `serverless deploy` and the trigger ARNs don't change (they
won't unless you rename the functions or change the stage), `UpdateUserPool`
won't be called.

## 4. Capture outputs

```bash
npx serverless info --stage prod
```

Write these down — they're needed by the frontend `.env.local` and the CloudFormation stack:

| Output              | Used by                            |
|---------------------|------------------------------------|
| `UserPoolId`        | (diagnostic)                       |
| `UserPoolClientId`  | `frontend/.env.local`              |
| `CognitoDomain`     | `frontend/.env.local` + Google Cloud **and** Facebook OAuth redirect URIs |
| `ApiEndpoint`       | `infrastructure/frontend-infra.yml` `ApiGatewayDomain` param (use host portion only) |
| `SharesBucketName`  | (diagnostic — this is the external bucket the app reads from, defaults to `schuit-sharing`) |

## 5. Finish OAuth wiring (Google + Facebook)

Both providers redirect back to the **same** Cognito endpoint. Copy the
`CognitoDomain` host and register this URL with each provider:

```
https://<cognito-domain>/oauth2/idpresponse
```

**Google** — Google Cloud Console → OAuth client → *Authorized redirect URIs*.
Without this, "Sign in with Google" fails with `redirect_uri_mismatch`.

**Facebook** — Meta for Developers → your app → *Facebook Login → Settings →
Valid OAuth Redirect URIs* (add the same `idpresponse` URL). Also:

- Add **Facebook Login** as a product on the app if it isn't already.
- The app must be switched **Live** (App Review → toggle from *Development* to
  *Live*) so users outside your dev/test roles can sign in. The
  `public_profile` and `email` permissions are granted by default and do **not**
  require App Review.
- Facebook only allows **HTTPS** redirect URIs, so local `http://localhost`
  testing goes through the deployed Cognito domain regardless of stage — the
  callback lands on Cognito (HTTPS), which then returns to your app.

Without this, "Sign in with Facebook" fails with a "URL blocked" / redirect-URI
error on Facebook's consent screen.

## 6. Bootstrap admin (automatic)

`riley.schuit@gmail.com` is set as the bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS` in `serverless.yml`. On first sign-in:

- The `preSignUp` trigger allows the user in (bootstrap list bypasses the invite check).
- The `preTokenGen` trigger adds them to the `admins` Cognito group (and overrides the token's `cognito:groups` so the first token already carries it).

To change the bootstrap admin, edit `custom.bootstrapAdmins` in `serverless.yml` and redeploy.

## Removing the stack

```bash
npx serverless remove --stage prod
```

This tears down Lambdas, API Gateway, the User Pool, and all three DynamoDB tables. It does **not** touch the shared `schuit-sharing` S3 bucket (by design).

## Local invocation

```bash
npx serverless invoke local \
  --function listMounts \
  --path test/events/listMounts.json
```

(You'd need to create fake event JSON mimicking an API Gateway JWT event — easier to just deploy to `prod` and hit the real API.)

## Logs

```bash
npx serverless logs --function browseList --stage prod --tail
```

## Env vars consumed by Lambdas

Set in `serverless.yml` → `provider.environment`:

- `INVITES_TABLE`, `MOUNTS_TABLE`, `PUBLIC_SHARES_TABLE`
- `ADMIN_GROUP` (default `admins`)
- `SHARES_BUCKET` (default `schuit-sharing`)
- `BOOTSTRAP_ADMIN_EMAILS` (comma-separated, lowercase)
- `SITE_ORIGIN` (used only to compose the signup URL returned by `createInvite`)
- `MAIL_FROM` — visible From: address for invite emails (default `noreply@schuit.io`). Must live inside a verified SES identity provisioned by the `schuit-sharing-email` stack.
- `MAIL_REGION` — SES region (default `us-east-1`); must match the email-infra stack's region.
- `STAGE`

`USER_POOL_ID` is intentionally **not** injected as an env var — it would
make every Lambda DependOn `UserPool`, recreating the circular dependency
that step 3 exists to break. The Cognito trigger Lambdas read the pool ID
from `event.userPoolId` (which Cognito provides on every invocation).

## IAM surface

The Lambda execution role has the minimum needed:

- `dynamodb:*Item`, `Query`, `Scan` on `InvitesTable` + `MountsTable` + `PublicSharesTable` (and its `TokenIndex`)
- `s3:ListBucket` on `arn:aws:s3:::schuit-sharing`; `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `/*` (Put/Delete are used by create-dir, upload, and delete; code-gated to mount prefixes)
- `cognito-idp:AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `AdminGetUser`, `ListUsers`, `ListUsersInGroup` scoped to `userpool/*` (wildcard — using `!GetAtt UserPool.Arn` would create a circular dependency)
- `ses:SendEmail`, `ses:SendRawEmail` scoped to `arn:aws:ses:us-east-1:<acct>:identity/*` (wildcard for the same coupling reason — the SES identity lives in a separate `schuit-sharing-email` CFN stack)
- `ssm:GetParameter` (only during deploy, for the Google creds)

The **S3 Public Access Block** on the shares bucket is set out-of-band (`aws s3api
put-bucket-cors` / `put-public-access-block`), not by this stack. Browser uploads
need a bucket CORS rule allowing `PUT` from the site origin — also set out-of-band.

## SES email identity

Outbound invite emails go through SES. The identity is provisioned by a
**separate** CloudFormation stack (`infrastructure/email-infra.yml`,
deployed by `infrastructure/email-deploy.sh`) so it can be shared across
backend stages without pulling DNS records into this stack.

Quick reference (full instructions in `../README.md` step 4b):

```bash
cd ../infrastructure
./email-deploy.sh
# wait 5–60 min for DKIM CNAMEs to verify
aws ses get-identity-verification-attributes \
  --region us-east-1 --identities schuit.io
```

This account already has **SES production access** (invite mail sends to any
recipient, 50k/day). A brand-new account would start in sandbox; request
production access via `aws sesv2 put-account-details --production-access-enabled
--mail-type TRANSACTIONAL ...` (or the SES console) once DKIM is Verified.
