# schuit-sharing backend — AWS SAM

This backend is being migrated from **Serverless Framework v3** to **AWS SAM**.
Both stacks describe the *same* AWS resources; the SAM template
([`template.yaml`](./template.yaml)) is a faithful translation of
[`serverless.yml`](./serverless.yml) with resource **names** and stack
**outputs** preserved exactly, so:

- [`scripts/wire-cognito-triggers.mjs`](./scripts/wire-cognito-triggers.mjs) runs
  unchanged against either stack, and
- the live prod pool + tables can be **adopted** by a SAM compute stack (see
  *Prod cutover*) instead of being recreated or migrated.

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

### Create mode vs adopt mode

The template runs in one of two modes, chosen by the `ExistingUserPoolId` param:

- **Create mode** (default; `ExistingUserPoolId` blank) — creates the full **data
  plane** (Cognito pool, web client, IdPs, domain, admins group, 3 DynamoDB
  tables) plus the compute. Used by `samtest` and by forkers standing up a fresh
  environment.
- **Adopt mode** (`ExistingUserPoolId` set) — creates only the **compute plane**
  (25 Lambdas, HTTP API, IAM role, mobile client) and **references** an existing
  pool + tables by id/name. Nothing stateful is created or touched. This is how
  prod moves to SAM. `FunctionNamePrefix` must be set to avoid colliding with the
  live Serverless function names; `MobileIdentityProviders` lists the IdPs the
  adopted pool already has.

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

## Prod cutover — DONE (2026-08-09)

`sharing.schuit.io` (CloudFront `rom-hub-frontend`) now routes `/api/*` to
`schuit-sharing-prod-sam`'s API (`6oweubywx9.execute-api.us-east-1.amazonaws.com`).
The old Serverless stack (`schuit-sharing-prod`) was deleted the same day. `prod`
deploys now mean `sam build --config-env prod && sam deploy --config-env prod`
— `serverless deploy --stage prod` no longer has a stack to deploy to. The
runbook below is kept for reference (and because it's still exactly the
procedure to follow if `prod-sam` ever needs a from-scratch redo).

## Prod cutover runbook (historical — already executed)

Approach: a **parallel SAM compute stack** (`schuit-sharing-prod-sam`, adopt mode)
runs alongside the live Serverless stack referencing the same pool + tables; the
switch is a **single CloudFront origin flip**. No CloudFormation import — the pool
+ tables are **retained** on the Serverless stack and orphaned when it's removed,
then referenced by the SAM stack (exactly how the S3 bucket + SES identity are
already handled). Every step is reversible. Adopt mode is proven end-to-end on
throwaway resources (a compute stack adopting the samtest pool: authed reads work;
deleting it leaves the pool/tables/objects intact).

**Live facts:** pool `us-east-1_8Zf0FwRVl`, web client `mai2ubk9ca9apj335bth8os2g`,
current HttpApi `g35h6wblu7`, front-door CloudFront stack `rom-hub-frontend`
(param `ApiGatewayDomain` = the API origin — the thing we flip).

1. **Protect** — add `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` to the
   pool, web client, both IdPs, domain, admins group, and 3 tables in
   `serverless.yml`; `serverless deploy --stage prod`. (Metadata only — no resource
   changes.) *This is already staged in `serverless.yml`.*
2. **Deploy the parallel SAM stack** — read the OAuth params from SSM and
   `sam build --config-env prod && sam deploy --config-env prod` (adopt params live
   in `samconfig.toml`; pass the 4 OAuth params + secrets on the CLI). Creates a new
   HttpApi + `schuit-sharing-prod-sam-*` Lambdas pointed at the existing pool/tables.
3. **Test** the new API URL directly against real data (401 unauth; authed
   `/mounts` + `/browse` with a real bearer) before any switch.
4. **Cutover window** — (a) wire triggers to the SAM Lambdas:
   `STACK_NAME=schuit-sharing-prod-sam FUNCTION_PREFIX=schuit-sharing-prod-sam STAGE=prod AWS_REGION=us-east-1 node scripts/wire-cognito-triggers.mjs`;
   (b) update `rom-hub-frontend`'s `ApiGatewayDomain` to the new API host, redeploy,
   invalidate `/api/*`.
5. **Verify** live on sharing.schuit.io (sign-in, browse, download, public link,
   admin actions).
6. **Soak 24–72h, then** `serverless remove --stage prod` — retain policies keep the
   pool + tables; only the SF Lambdas/API/role are removed.

**Rollback:** flip `ApiGatewayDomain` back to `g35h6wblu7.execute-api.us-east-1.amazonaws.com`
and re-wire triggers with `FUNCTION_PREFIX=schuit-sharing-prod STACK_NAME=schuit-sharing-prod`.


## Mobile client

`template.yaml` adds a second Cognito app client (`schuit-sharing-<stage>-mobile`)
— a public PKCE client with a `sharingpoc://` callback — for the Expo mobile POC
(`sharing_app_POC_mobile`). Its id is exported as the `UserPoolClientMobileId`
stack output. The HTTP API's JWT authorizer accepts tokens from both the web and
mobile clients.
