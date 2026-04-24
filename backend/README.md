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
STAGE=dev   # or prod

aws ssm put-parameter \
  --name /rom-hub/$STAGE/google/client_id \
  --type String \
  --value '<google-client-id>' \
  --overwrite

aws ssm put-parameter \
  --name /rom-hub/$STAGE/google/client_secret \
  --type SecureString \
  --value '<google-client-secret>' \
  --overwrite
```

## 2. Install & deploy

```bash
cd backend
npm install

npx serverless deploy --stage dev
```

This provisions:

- `UserPool` — Cognito User Pool with Google as external IdP
- `UserPoolClient` — OAuth code + PKCE, callback URLs wired to both prod (`https://sharing.schuit.io/auth/callback`) and dev (`http://localhost:5173/auth/callback`)
- `UserPoolDomain` — hosted UI domain (Amazon-provided: `rom-hub-<stage>-<acct>.auth.<region>.amazoncognito.com`)
- `InvitesTable` (DynamoDB, email PK, TTL)
- `MountsTable` (DynamoDB, mountPath PK)
- Lambdas: `preSignUp`, `postAuth`, `createInvite`, `listInvites`, `revokeInvite`, `createMount`, `deleteMount`, `listMounts`, `browseList`, `browseDownloadUrl`
- HTTP API with a JWT authorizer pointing at the User Pool

## 3. Capture outputs

```bash
npx serverless info --stage dev
```

Write these down — they're needed by the frontend `.env.local` and the CloudFormation stack:

| Output              | Used by                            |
|---------------------|------------------------------------|
| `UserPoolId`        | (diagnostic)                       |
| `UserPoolClientId`  | `frontend/.env.local`              |
| `CognitoDomain`     | `frontend/.env.local` + Google Cloud OAuth client redirect URI |
| `ApiEndpoint`       | `infrastructure/frontend-infra.yml` `ApiGatewayDomain` param (use host portion only) |
| `SharesBucketName`  | (diagnostic — this is the external bucket the app reads from, defaults to `schuit-sharing`) |

## 4. Finish Google OAuth wiring

Copy the `CognitoDomain` host. In Google Cloud Console → OAuth client, add to authorized redirect URIs:

```
https://<cognito-domain>/oauth2/idpresponse
```

Without this, the "Sign in with Google" flow will fail with `redirect_uri_mismatch`.

## 5. Bootstrap admin (automatic)

`riley.schuit@gmail.com` is set as the bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS` in `serverless.yml`. On first sign-in:

- The `preSignUp` trigger allows the user in (bootstrap list bypasses the invite check).
- The `postAuth` trigger adds them to the `admins` Cognito group.

To change the bootstrap admin, edit `custom.bootstrapAdmins` in `serverless.yml` and redeploy.

## Removing the stack

```bash
npx serverless remove --stage dev
```

This tears down Lambdas, API Gateway, the User Pool, and both DynamoDB tables. It does **not** touch the shared `schuit-sharing` S3 bucket (by design).

## Local invocation

```bash
npx serverless invoke local \
  --function listMounts \
  --path test/events/listMounts.json
```

(You'd need to create fake event JSON mimicking an API Gateway JWT event — easier to just deploy to `dev` and hit the real API.)

## Logs

```bash
npx serverless logs --function browseList --stage dev --tail
```

## Env vars consumed by Lambdas

Set in `serverless.yml` → `provider.environment`:

- `INVITES_TABLE`, `MOUNTS_TABLE`
- `USER_POOL_ID`
- `SHARES_BUCKET` (default `schuit-sharing`)
- `BOOTSTRAP_ADMIN_EMAILS` (comma-separated, lowercase)
- `SITE_ORIGIN` (used only to compose the signup URL returned by `createInvite`)

## IAM surface

The Lambda execution role has the minimum needed:

- `dynamodb:*Item`, `Query`, `Scan` on `InvitesTable` + `MountsTable`
- `s3:ListBucket`, `s3:GetObject` on `arn:aws:s3:::schuit-sharing` + `/*`
- `cognito-idp:AdminAddUserToGroup`, `AdminListGroupsForUser`, `AdminGetUser` on the User Pool
- `ssm:GetParameter` (only during deploy, for the Google creds)
