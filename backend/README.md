# Backend deployment

Serverless Framework app — API Gateway (HTTP API) + Lambda (Node 20) + Cognito User Pool + DynamoDB + S3.

## Prereqs

- Node 20, npm
- Serverless Framework v3: `npm i -g serverless`
- AWS CLI configured with a profile that can deploy to the target account/region
- Google OAuth client ID + secret (see `../README.md` step 1)

## 1. Store Google creds in SSM

The stack reads Google OAuth creds from SSM Parameter Store at deploy time.

```bash
STAGE=prod   # 'prod' is the live deployment; 'dev' is reserved for a future personal sandbox

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
```

## 2. Install & deploy

```bash
cd backend
npm install

npx serverless deploy --stage prod
```

This provisions:

- `UserPool` — Cognito User Pool with Google as external IdP (created **without** Lambda triggers — see step 3)
- `UserPoolClient` — OAuth code + PKCE, callback URLs wired to both prod (`https://sharing.schuit.io/auth/callback`) and dev (`http://localhost:5173/auth/callback`)
- `UserPoolDomain` — hosted UI domain (Amazon-provided: `schuit-sharing-<stage>-<acct>.auth.<region>.amazoncognito.com`)
- `InvitesTable` (DynamoDB, email PK, TTL)
- `MountsTable` (DynamoDB, mountPath PK)
- Lambdas: `preSignUp`, `postAuth`, `createInvite`, `listInvites`, `revokeInvite`, `createMount`, `deleteMount`, `listMounts`, `browseList`, `browseDownloadUrl`
- HTTP API with a JWT authorizer pointing at the User Pool

## 3. Wire the Cognito Lambda triggers

The `preSignUp` and `postAuth` Lambdas can't be wired into the UserPool's
`LambdaConfig` from CloudFormation — doing so creates a circular dependency
(UserPool → trigger Lambdas → IAM role + HttpApi authorizer → UserPool).
Instead, run the post-deploy script. It's idempotent — safe to re-run after
every deploy.

```bash
npm run wire-triggers:prod     # the live deployment
# or, for a future sandbox:
npm run wire-triggers          # stage=dev (default)
```

Output:

```
==> Looking up resources from stack schuit-sharing-prod in us-east-1
    UserPoolId       = us-east-1_XXXXXXXXX
    PreSignUp ARN    = arn:aws:lambda:us-east-1:...:function:schuit-sharing-prod-preSignUp
    PostAuth ARN     = arn:aws:lambda:us-east-1:...:function:schuit-sharing-prod-postAuth
==> Fetching current UserPool config
==> Updating UserPool with new LambdaConfig
==> Done. Triggers are now wired:
    PreSignUp:          arn:aws:lambda:us-east-1:...:schuit-sharing-prod-preSignUp
    PostAuthentication: arn:aws:lambda:us-east-1:...:schuit-sharing-prod-postAuth
```

The script reads the current pool config and re-passes everything (because
`UpdateUserPool` resets fields you don't include) plus the new `LambdaConfig`.
Lambda `InvokeFunction` permissions for the Cognito principal are already
granted by the CloudFormation stack — the script only sets the `LambdaConfig`.

> **You must run this once after the first deploy** for sign-in to work.
> Sign-in will succeed on the Cognito side but no admins will be auto-bootstrapped
> (and any future invite-based users won't be gated) until the triggers are wired.

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
| `CognitoDomain`     | `frontend/.env.local` + Google Cloud OAuth client redirect URI |
| `ApiEndpoint`       | `infrastructure/frontend-infra.yml` `ApiGatewayDomain` param (use host portion only) |
| `SharesBucketName`  | (diagnostic — this is the external bucket the app reads from, defaults to `schuit-sharing`) |

## 5. Finish Google OAuth wiring

Copy the `CognitoDomain` host. In Google Cloud Console → OAuth client, add to authorized redirect URIs:

```
https://<cognito-domain>/oauth2/idpresponse
```

Without this, the "Sign in with Google" flow will fail with `redirect_uri_mismatch`.

## 6. Bootstrap admin (automatic)

`riley.schuit@gmail.com` is set as the bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS` in `serverless.yml`. On first sign-in:

- The `preSignUp` trigger allows the user in (bootstrap list bypasses the invite check).
- The `postAuth` trigger adds them to the `admins` Cognito group.

To change the bootstrap admin, edit `custom.bootstrapAdmins` in `serverless.yml` and redeploy.

## Removing the stack

```bash
npx serverless remove --stage prod
```

This tears down Lambdas, API Gateway, the User Pool, and both DynamoDB tables. It does **not** touch the shared `schuit-sharing` S3 bucket (by design).

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

- `INVITES_TABLE`, `MOUNTS_TABLE`
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

- `dynamodb:*Item`, `Query`, `Scan` on `InvitesTable` + `MountsTable`
- `s3:ListBucket`, `s3:GetObject` on `arn:aws:s3:::schuit-sharing` + `/*`
- `cognito-idp:AdminAddUserToGroup`, `AdminListGroupsForUser`, `AdminGetUser` scoped to `userpool/*` (wildcard — using `!GetAtt UserPool.Arn` would create a circular dependency)
- `ses:SendEmail`, `ses:SendRawEmail` scoped to `arn:aws:ses:us-east-1:<acct>:identity/*` (wildcard for the same coupling reason — the SES identity lives in a separate `schuit-sharing-email` CFN stack)
- `ssm:GetParameter` (only during deploy, for the Google creds)

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
# new SES accounts start in sandbox: verify a recipient first if testing
aws ses verify-email-identity --region us-east-1 \
  --email-address riley.schuit@gmail.com
# then request production access from the SES console once DKIM is Verified
```
