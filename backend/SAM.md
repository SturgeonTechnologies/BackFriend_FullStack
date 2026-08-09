# schuit-sharing backend — AWS SAM

This backend is being migrated from **Serverless Framework v3** to **AWS SAM**.
Both stacks describe the *same* AWS resources; the SAM template
([`template.yaml`](./template.yaml)) is a faithful translation of
[`serverless.yml`](./serverless.yml) with resource **names** and stack
**outputs** preserved exactly, so:

- [`scripts/wire-cognito-triggers.mjs`](./scripts/wire-cognito-triggers.mjs) runs
  unchanged against either stack, and
- the live prod stack can be adopted by SAM via **resource import** (below)
  instead of a destructive recreate.

Both toolchains are kept in the repo during the transition. `serverless.yml`
remains the source of truth for **prod** until the cutover is done.

## Prerequisites

- **AWS SAM CLI** ≥ 1.163 — https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
- **Node.js 22+** and npm
- **esbuild** — `sam build` bundles each function with esbuild. It is a normal
  `dependency` (so `npm ci` installs it), but if `sam build` reports
  *"Cannot find esbuild"*, install it on the PATH as a fallback:
  ```bash
  npm install -g esbuild
  ```
- AWS credentials with permission to deploy CloudFormation, Lambda, API Gateway,
  Cognito, DynamoDB, IAM, and S3.

```bash
cd backend
npm ci
```

## Layout

| File | Purpose |
|---|---|
| `template.yaml` | The SAM template (25 functions, HTTP API + Cognito JWT authorizer, Cognito pool/IdPs/clients, 3 DynamoDB tables, one shared IAM role). |
| `samconfig.toml` | Per-stage deploy config. **No secrets** — OAuth secrets are passed at deploy time (see below). |
| `scripts/wire-cognito-triggers.mjs` | Post-deploy: attaches the 3 Cognito triggers + applies the hosted-UI theme. Idempotent. Runs unchanged from the Serverless setup. |

### Why triggers are wired post-deploy

Putting `LambdaConfig` on the `AWS::Cognito::UserPool` while the same pool is the
HTTP API's JWT authorizer creates an unbreakable CloudFormation circular
dependency. The pool is created without triggers; the script wires them after.
(Same reason the Lambda IAM role uses a wildcard Cognito userpool ARN and no
`USER_POOL_ID` env var is injected.)

## Stages & config

`samconfig.toml` defines two environments:

- **`samtest`** — an isolated throwaway stack (`schuit-sharing-samtest`) with its
  own fresh Cognito pool + tables. Safe to deploy/delete freely; touches nothing
  in prod. Comes up with **email/password only** — the federated Google/Facebook
  IdPs are skipped unless their client ids are supplied (the `Has*` template
  conditions).
- **`prod`** — the live environment (`sharing.schuit.io`). **Do not** `sam deploy`
  this blindly (see *Prod cutover*).

All stages deploy to **us-east-1** (the SES identity, the OAuth-secret SSM
params, and the wire-triggers default region are all us-east-1).

## Deploy to the test stage

```bash
cd backend
sam build   --config-env samtest
sam deploy  --config-env samtest        # non-interactive; email/password only
STAGE=samtest AWS_REGION=us-east-1 node scripts/wire-cognito-triggers.mjs
```

The deploy needs an artifact S3 bucket. `samconfig.toml` points `samtest` at
`schuit-sharing-sam-artifacts-<accountId>`; create it once (any region-appropriate
bucket works), or switch that line back to `resolve_s3 = true`.

Smoke-test the outputs:

```bash
API=$(aws cloudformation describe-stacks --stack-name schuit-sharing-samtest \
  --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
curl -s -w '\n%{http_code}\n' "$API/mounts"                 # 401 (authorizer enforced)
curl -s -w '\n%{http_code}\n' "$API/public/nope"           # 404 (public Lambda -> DynamoDB)
```

### Tear down the test stage

```bash
sam delete --config-env samtest
# then remove the (external, unmanaged) shares + artifact buckets if you made them:
aws s3 rb s3://schuit-sharing-samtest --force --region us-east-1
```

## OAuth secrets (gotcha)

CloudFormation cannot resolve an `ssm-secure` dynamic reference inside a Cognito
IdP's `ProviderDetails`, so the Google/Facebook **client secrets** are template
**parameters** (`NoEcho`), not SSM lookups. Keep them out of `samconfig.toml`.
Pass them at deploy time from the existing SSM SecureStrings, e.g.:

```bash
GID=$(aws ssm get-parameter --region us-east-1 --name /schuit-sharing/prod/google/client_id       --query Parameter.Value --output text)
GSEC=$(aws ssm get-parameter --region us-east-1 --with-decryption --name /schuit-sharing/prod/google/client_secret --query Parameter.Value --output text)
sam deploy --config-env <stage> \
  --parameter-overrides "GoogleClientId=$GID GoogleClientSecret=$GSEC ..."
```

## Prod cutover (NOT done yet — separate, deliberate step)

The live pool holds real users, mounts, and invites. A plain `sam deploy --config-env prod`
would try to **create** a UserPool + DynamoDB tables that already exist and fail
(or replace and wipe them). The safe path is **CloudFormation resource import**:

1. Deploy an empty-ish SAM stack, then `sam deploy`/`aws cloudformation create-change-set
   --change-set-type IMPORT` to import the existing prod Cognito pool + the 3
   DynamoDB tables (matched by their real names, which this template already
   reproduces) into the SAM-managed stack.
2. Set each imported resource's `DeletionPolicy: Retain` first so a mistake can't
   delete user data.
3. Re-point `sharing.schuit.io`'s `/api` if the HTTP API id changes (same
   mechanic as the earlier rom-hub cutover), or keep the SF API until verified.
4. Run `wire-cognito-triggers.mjs` with `STAGE=prod`.
5. Verify, then retire the Serverless Framework stack.

Until then, prod continues to be deployed with `serverless deploy --stage prod`.

## Mobile client

`template.yaml` adds a second Cognito app client (`schuit-sharing-<stage>-mobile`)
— a public PKCE client with a `sharingpoc://` callback — for the Expo mobile POC
(`sharing_app_POC_mobile`). Its id is exported as the `UserPoolClientMobileId`
stack output. The HTTP API's JWT authorizer accepts tokens from both the web and
mobile clients.
