# Serverless POC — Friends App Direction

Status: **proposal** (branch `Serverless_POC`). Nothing in here is wired up yet;
it's the plan for taking the patterns this repo already proves out and pointing
them at a friends/social app POC, with a real CI/CD pipeline and a local dev
loop that doesn't require deploying to AWS to see a change.

---

## TL;DR

- **Keep the stack.** This repo is already a working AWS serverless app: SAM,
  Cognito (hosted UI + PKCE), HTTP API with a JWT authorizer, DynamoDB, S3
  presigned URLs, SES, CloudFront, and GitHub OIDC deploys. Those are the right
  bones for a friends app. Don't rewrite them, reuse them.
- **Change the shape of the backend.** Go from one Lambda per route (34 handlers
  today) to **one Lambda per domain** (`users`, `friends`, `posts`, `media`)
  with a tiny router, a **single-table DynamoDB** design for the social graph,
  and **events** (DynamoDB Streams to EventBridge) for side effects like
  notifications.
- **Add the missing CI.** Today CI only deploys prod on push to `main`. There
  are no PR checks, no tests, and no non-prod environments. The plan below
  adds `ci.yml` (PR gates), `preview.yml` (an ephemeral stack per PR), and a
  `deploy.yml` that promotes dev to prod behind a GitHub Environment approval.
- **Make local dev real.** Today "local dev" means running Vite against a
  deployed `samtest` stack. The plan adds four tiers: unit tests, then Docker
  (DynamoDB Local / LocalStack) plus `sam local`, then the Vite proxy, then a
  personal cloud sandbox with `sam sync --watch`. All of it sits behind
  `make` targets so onboarding is `make bootstrap && make dev`.

---

## 1. What's in the repo today (and what carries over)

| Area | Today | Carry to POC? |
|---|---|---|
| IaC | `backend/template.yaml` (SAM, ~1.5k lines), `infrastructure/*.yml` (CloudFront/ACM/R53, SES, GHA OIDC role) | ✅ Yes. SAM stays the source of truth. |
| Auth | Cognito user pool, hosted UI, Google/Facebook/email, PKCE SPA client + mobile client, `preSignUp`/`preTokenGen` triggers for invite gating and group provisioning | ✅ Yes. Invite gating is a natural "friends-only beta" gate. |
| API | HTTP API (v2) + Cognito JWT authorizer, claims parsed in `src/lib/auth.ts` | ✅ Yes. |
| Compute | 34 handlers, **one `AWS::Serverless::Function` per route**, esbuild-bundled TS, `nodejs24.x` | ⚠️ Consolidate (see §2.2). |
| Data | 3 DynamoDB tables (`invites`, `mounts`, `public-shares`), one per entity | ⚠️ Go single-table for the social graph (see §2.3). |
| Files | Private S3 + presigned GET/PUT, public share tokens | ✅ Yes. This is exactly what photo/media posts need. |
| Email | SES identity + DKIM stack | ✅ Yes (friend requests, invites). |
| Deploy | `backend/scripts/deploy.mjs` driven by `deploy.config.<space>.json`; idempotent | ✅ Yes. The config-file pattern is good. |
| CI/CD | `.github/workflows/deploy.yml`: push to `main` deploys **prod only** via OIDC | ❌ Needs PR checks, non-prod stages, and promotion. |
| Tests | **None.** No test runner in either `package.json`. | ❌ Add. |
| Local dev | Vite dev server against a *deployed* `samtest` stack | ❌ Add an offline loop. |

### Paper cuts worth fixing on the way (cheap, high value)

- **Node version drift.** The workflow uses Node `20`, `SAM.md` says `22+`,
  and Lambda runs `nodejs24.x` while the esbuild target is `node20`. Pin one
  version in `.nvmrc` and read it everywhere (`actions/setup-node` supports
  `node-version-file`).
- **Stale `serverless.yml` references.** `SAM.md`, `TODO.md`, and template
  comments still point at `serverless.yml`, which no longer exists.
- **CORS is `*` in `src/lib/response.ts`**, but the HTTP API already has
  `AllowedOrigins`. Let API Gateway own CORS and drop the hardcoded headers.
- **Account IDs are hardcoded** in `samconfig.toml` and `deploy.yml`. Move
  them to GitHub Environment variables or the deploy config so a fork or new
  account doesn't need code edits.

---

## 2. Target architecture

```
                 ┌──────────────── CloudFront ────────────────┐
  app.example ──▶│  /*  → S3 (SPA, OAC)                        │
                 └─────────────────────────────────────────────┘
  api.example ──▶ API Gateway HTTP API ── Cognito JWT authorizer
                    │
       ┌────────────┼──────────────┬───────────────┐
       ▼            ▼              ▼               ▼
   users-fn     friends-fn      posts-fn        media-fn        (one Lambda per domain,
       │            │              │               │              internal router)
       └────────────┴──────┬───────┴───────────────┘
                           ▼
                 DynamoDB (single table, PK/SK + GSI1)
                           │ Streams
                           ▼
                 EventBridge bus  ──▶ notify-fn (SES email / push)
                                  ──▶ fanout-fn (feed materialization, later)
   S3 media bucket ── ObjectCreated ──▶ thumbnail-fn (sharp, arm64)

   Cognito: hosted UI + PKCE, preSignUp (invite gate), preTokenGen (groups)
```

### 2.1 Principles

1. **Managed over managed-by-us.** No VPC, no NAT gateway, no RDS for the POC.
   Everything should scale to zero so an idle POC costs roughly $0.
2. **Stages are cheap, so make many.** Every stage is a full stack, named
   `<prefix>-<stage>`. The current template already does this via
   `ResourcePrefix`/`Stage`. Keep doing it and add `pr-<n>` and `dev-<user>`.
3. **Idempotent everything.** `deploy.mjs`, seed scripts, and teardown should
   all be safe to re-run. That's already the house style here.

### 2.2 Compute: one Lambda per domain, not per route

34 functions means 34 cold-start pools, 34 log groups, slow `sam build`, and a
template that's mostly boilerplate. For the POC, group routes by domain:

```yaml
# template.yaml (sketch)
Globals:
  Function:
    Runtime: nodejs24.x
    Architectures: [arm64]        # ~20% cheaper, usually faster
    MemorySize: 512
    Timeout: 10
    Tracing: Active

Resources:
  FriendsFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: friends.handler
      Events:
        Any:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /friends/{proxy+}, Method: ANY }
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/domains/friends/index.ts], Target: node24 }
```

Each domain's `index.ts` is a small router keyed on `event.routeKey`, with no
framework needed. Handlers stay plain `(event) => result` functions, so unit
tests don't care about the routing.

Add **Powertools for AWS Lambda (TypeScript)** for structured logs, metrics,
and tracing, and for idempotency on write routes (accepting a friend request
twice shouldn't double-write).

### 2.3 Data: single-table DynamoDB for the social graph

The current one-table-per-entity layout is fine for config-like data. A friends
app is all relationships, so model them as items in one table:

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| User profile | `USER#<sub>` | `PROFILE` | `EMAIL#<email>` | `USER#<sub>` |
| Friendship (both directions written in one transaction) | `USER#<a>` | `FRIEND#<b>` | `USER#<b>` | `FRIEND#<a>` |
| Friend request | `USER#<to>` | `REQ#<ts>#<from>` | `USER#<from>` | `SENT#<ts>#<to>` |
| Post | `USER#<author>` | `POST#<ulid>` | `POST#<ulid>` | `POST#<ulid>` |
| Comment / reaction | `POST#<ulid>` | `CMT#<ulid>` / `RXN#<sub>` | | |
| Invite (reuse today's logic) | `INVITE#<email>` | `INVITE` | | |

These cover the main access patterns: get a profile, list friends, list
pending requests (inbound and sent), list a user's posts, and list a post's
comments.

**Feed strategy for the POC: fan-out-on-read.** Query the last N posts of each
friend and merge them. That's fine up to a few hundred friends. When it stops
being fine, the Streams to EventBridge to `fanout-fn` path in the diagram
materializes `FEED#<sub>` items. Same table, no schema migration.

Turn on **PITR** and `DeletionPolicy: Retain` for `prod` only, so ephemeral
stages tear down clean.

### 2.4 Media

Reuse `src/lib/s3.ts`'s presigned pattern. The client asks `media-fn` for a
presigned PUT, uploads straight to S3, and an `ObjectCreated` event triggers
`thumbnail-fn`. Use a **separate media bucket per stage**. TODO.md already
flags that the shared bucket is a problem once write paths exist.

### 2.5 Later, not now

- **Realtime** (chat, live notifications): API Gateway WebSocket API, or
  AppSync Events. Defer until the POC proves people use it.
- **Push notifications**: SNS mobile push or Expo push via `notify-fn`.
- **Multi-account** (AWS Organizations with separate dev and prod accounts):
  the right end state, but for a POC one account plus strict stage naming is
  enough.

---

## 3. CI/CD

### 3.1 Pipeline shape

```
 PR opened/updated ──▶ ci.yml ─────────▶ lint · typecheck · unit · sam validate --lint
                                         · cfn-lint · frontend build · integration (docker)
                   └─▶ preview.yml ───▶ deploy stack  <prefix>-pr-<n>  ▶ smoke test ▶ PR comment w/ URLs
 PR closed ─────────▶ preview.yml ───▶ sam delete  <prefix>-pr-<n>
 push to main ──────▶ deploy.yml ────▶ dev  (auto)  ▶ smoke test
                                      ▶ prod (GitHub Environment "prod": required reviewer) ▶ smoke test
 tag v*  (optional) ─▶ deploy.yml ────▶ prod only
```

**Auth:** GitHub OIDC everywhere, no long-lived keys. Extend
`infrastructure/github-oidc.yml` into **two roles**:

- `gha-deploy-nonprod`: trusted for `pull_request` and `refs/heads/main`, and
  allowed to touch only `<prefix>-pr-*` / `<prefix>-dev*` resources.
- `gha-deploy-prod`: trusted only for `environment:prod`. This is the key
  trick: the `sub` claim includes the environment name, so prod credentials
  are literally unobtainable without passing the approval gate.

Per-stage deploy configs live as **GitHub Environment secrets**
(`DEPLOY_CONFIG` in environments `dev`, `prod`). That's the same pattern
`DEPLOY_CONFIG_PROD` uses today, just scoped by environment instead of by
secret name.

### 3.2 `ci.yml` (PR gate)

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: backend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: backend/package-lock.json }
      - uses: aws-actions/setup-sam@v2
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage           # vitest + aws-sdk-client-mock
      - run: sam validate --lint               # cfn-lint is bundled
      - run: sam build                         # proves every esbuild entry point bundles

  integration:
    runs-on: ubuntu-latest
    needs: backend
    services:
      dynamodb:
        image: amazon/dynamodb-local:2.5.2
        ports: ["8000:8000"]
    env:
      AWS_ENDPOINT_URL_DYNAMODB: http://localhost:8000
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: local
      AWS_SECRET_ACCESS_KEY: local
    defaults: { run: { working-directory: backend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
      - run: npm run db:create && npm run db:seed
      - run: npm run test:integration

  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run build                     # tsc -b && vite build
```

> `AWS_ENDPOINT_URL_DYNAMODB` is honored natively by AWS SDK v3, and
> `src/lib/db.ts` constructs `new DynamoDBClient({})` with no hardcoded
> endpoint, so **zero code changes** are needed to point the existing code at
> DynamoDB Local.

### 3.3 `preview.yml` (ephemeral stack per PR)

```yaml
name: preview
on:
  pull_request: { types: [opened, synchronize, reopened, closed] }
permissions: { id-token: write, contents: read, pull-requests: write }
concurrency: { group: preview-${{ github.event.number }}, cancel-in-progress: false }

jobs:
  deploy:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    environment: preview
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - uses: aws-actions/setup-sam@v2
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}, aws-region: us-east-1 }
      - run: npm ci
        working-directory: backend
      - name: Render per-PR config from template
        working-directory: backend
        run: node scripts/render-config.mjs --stage pr-${{ github.event.number }} > deploy.config.json
      - run: node scripts/deploy.mjs deploy.config.json
        working-directory: backend
      - run: node scripts/smoke.mjs --stage pr-${{ github.event.number }}
        working-directory: backend
      # then: actions/github-script to upsert a PR comment with ApiEndpoint + Cognito domain

  teardown:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    environment: preview
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}, aws-region: us-east-1 }
      - run: node scripts/teardown.mjs --space pr-${{ github.event.number }} --yes
```

Preview stacks run **email/password only** (no OAuth IdPs, no custom domains,
no CloudFront). The SPA for a preview runs locally against the preview API,
or gets synced to an `s3://<artifacts>/previews/pr-<n>/` prefix later if
that's wanted. A nightly `cron` job deletes any `*-pr-*` stack older than
7 days as a backstop for missed teardowns.

### 3.4 `deploy.yml` (main to dev to prod)

```yaml
name: deploy
on:
  push: { branches: [main] }
  workflow_dispatch: {}
permissions: { id-token: write, contents: read }
concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }

jobs:
  dev:
    uses: ./.github/workflows/_deploy-stage.yml
    with: { environment: dev }
    secrets: inherit

  prod:
    needs: dev
    uses: ./.github/workflows/_deploy-stage.yml
    with: { environment: prod }    # GitHub Environment with required reviewers
    secrets: inherit
```

`_deploy-stage.yml` is the current `deploy.yml` body made reusable: checkout,
OIDC, `npm ci`, write `secrets.DEPLOY_CONFIG` to `deploy.config.json`, run
`deploy.mjs`, then **smoke test**. It's the same job for every stage, which
also closes the "CI should own multi-space deploys" item in `TODO.md`.

### 3.5 Smoke tests (`backend/scripts/smoke.mjs`)

These are deliberately boring checks that fail CI on config typos (the
`beeks-sharing` relative-`redirectUri` bug from TODO.md would have been caught
here):

1. `GET /config` returns 200 with non-empty `cognitoDomain`, `cognitoClientId`,
   and `apiBaseUrl`, and every redirect URI is absolute `https://` (or
   `http://localhost`).
2. `GET /friends` with no token returns **401** (proves the authorizer is
   attached).
3. `GET <cognitoDomain>/oauth2/authorize?...` returns **302/200, not 400**
   (proves the client and callback match).
4. *(dev/preview only)* Create a throwaway Cognito user with
   `AdminCreateUser` + `AdminSetUserPassword`, get a token with
   `AdminInitiateAuth`, hit one authed route, then delete the user. This
   needs `ALLOW_ADMIN_USER_PASSWORD_AUTH` on a **CI-only app client** that
   exists only when `Stage != prod`.

### 3.6 Required repo settings (one-time, documented here so it isn't tribal knowledge)

- Branch protection on `main`: require `ci / backend`, `ci / integration`,
  and `ci / frontend`.
- GitHub Environments: `preview` (no approval), `dev` (no approval), `prod`
  (required reviewer: you). Each holds `DEPLOY_ROLE_ARN` (var) and
  `DEPLOY_CONFIG` (secret).
- Dependabot for `npm` (backend, frontend) and `github-actions`.

---

## 4. Local development

Goal: a new contributor goes from `git clone` to a running app in under 10
minutes, **without an AWS account** for tiers 0 to 2.

### Tier 0: unit tests (seconds, no Docker)

- **vitest** + **aws-sdk-client-mock**. Handlers are already plain functions
  of an `APIGatewayProxyEventV2WithJWTAuthorizer`, so a test builds an event
  fixture with claims and asserts on the result.
- One helper, `test/fixtures/event.ts`:
  `makeEvent({ routeKey, body, claims: { sub, email, groups } })`.
- `getCaller()` in `src/lib/auth.ts` is the highest-value thing to test first.
  It parses four observed `cognito:groups` shapes and is security-critical.

```bash
make test          # → cd backend && npm test
make test-watch
```

### Tier 1: full backend offline (Docker + `sam local`)

`docker-compose.yml` at the repo root:

```yaml
services:
  dynamodb:
    image: amazon/dynamodb-local:2.5.2
    command: "-jar DynamoDBLocal.jar -sharedDb -inMemory"
    ports: ["8000:8000"]
  localstack:                       # S3 + SES (+ EventBridge later)
    image: localstack/localstack:3.8
    environment: { SERVICES: "s3,ses,events" }
    ports: ["4566:4566"]
  dynamodb-admin:                   # optional GUI at :8001
    image: aaronshaf/dynamodb-admin
    environment: { DYNAMO_ENDPOINT: http://dynamodb:8000 }
    ports: ["8001:8001"]
```

Then `sam local start-api --env-vars env.local.json --docker-network <compose-net> --warm-containers EAGER`.

`env.local.json` sets `AWS_ENDPOINT_URL_DYNAMODB=http://dynamodb:8000`,
`AWS_ENDPOINT_URL_S3=http://localstack:4566`, table names, and
`AUTH_MODE=local`.

**The one real gap: `sam local` does not run the HTTP API's Cognito JWT
authorizer**, so `requestContext.authorizer.jwt.claims` is empty and every
authed route sees an anonymous caller. Fix it with a small, explicit dev shim
in `getCaller()`:

```ts
// Local-only: sam local doesn't emulate JWT authorizers. Never true in AWS —
// AUTH_MODE is not a template parameter, so it cannot be set on a deployed stack.
if (process.env.AUTH_MODE === "local" && !event.requestContext.authorizer) {
  return devCallerFromHeader(event.headers["x-dev-user"]); // e.g. "alice@example.com;admins"
}
```

Add a unit test asserting the shim is unreachable unless `AUTH_MODE=local`,
plus a `cfn-lint`/grep check in CI that `AUTH_MODE` never appears in
`template.yaml`.

Seed data is idempotent (`PutItem` with deterministic keys) and lives in
`backend/scripts/seed.mjs`. It sets up three users (alice, bob, carol), one
friendship, one pending request, and a few posts.

```bash
make up            # docker compose up -d && npm run db:create && npm run db:seed
make api           # sam build && sam local start-api ...   (http://127.0.0.1:3000)
make down
```

> `sam build` per change is slow-ish. For a tight loop on a single domain,
> `sam local invoke FriendsFn -e events/list-friends.json` or the vitest
> integration suite (Tier 0 tests pointed at DynamoDB Local) is faster.

### Tier 2: frontend against local backend (no CORS pain)

Add a dev proxy to `frontend/vite.config.ts` so the SPA calls `/api/*`
same-origin:

```ts
server: {
  port: 5173,
  proxy: { "/api": { target: "http://127.0.0.1:3000", rewrite: p => p.replace(/^\/api/, "") } },
},
```

`frontend/.env.development` then sets `VITE_API_BASE=/api` and
`VITE_AUTH_MODE=local`. In local auth mode the Login page shows a "pick a seed
user" dropdown instead of redirecting to Cognito, and `api.ts` sends
`x-dev-user` instead of a bearer token.

```bash
make dev           # make up + make api + (cd frontend && npm run dev), via a Procfile/concurrently
```

### Tier 3: personal cloud sandbox (real Cognito, real IAM)

Some behavior can't be emulated: Cognito triggers, hosted UI theming, SES,
IAM policy mistakes. For those, each developer gets their own stack:

```bash
make sandbox       # renders deploy.config.dev-$USER.json, deploys <prefix>-dev-$USER (email/password only)
make sync          # sam sync --stack-name <prefix>-dev-$USER --watch   (code-only changes hot-swap in ~seconds)
make sandbox-down  # teardown.mjs --space dev-$USER --yes
```

`sam sync --watch` skips CloudFormation for code-only changes and updates the
Lambda directly. It's the closest thing to hot reload against real AWS.
**Never point it at prod.** `samconfig.toml` should have no `sync` profile for
prod, and `teardown.mjs` already refuses prod-looking spaces.

### Onboarding kit

| File | Purpose |
|---|---|
| `.nvmrc` | Single Node version for local, CI, and the esbuild target |
| `Makefile` | `bootstrap`, `test`, `up`, `api`, `dev`, `sandbox`, `sync`, `deploy STAGE=…`, `down`. All idempotent. |
| `.devcontainer/devcontainer.json` | Node + SAM CLI + AWS CLI + Docker-in-Docker, so Codespaces or VS Code works with zero host setup |
| `docker-compose.yml` | DynamoDB Local, LocalStack, dynamodb-admin |
| `backend/env.local.json` | Committed, no secrets, local endpoints only |
| `docs/LOCAL_DEV.md` | The tier table above, plus troubleshooting |

---

## 5. Cost (POC, idle to light use)

Everything here scales to zero. Idle cost is basically **Route 53 hosted zone
($0.50/mo)** plus pennies of S3. Light use (a few friends) stays inside the
Lambda, DynamoDB on-demand, API Gateway, and Cognito free tiers (Cognito: 10k
MAU on the Lite tier). The things that *would* cost real money (NAT gateway,
RDS, always-on containers) are deliberately absent.

Add an **AWS Budgets** alert at $10/mo in `infrastructure/` as a guardrail.

---

## 6. Phased plan

Ordered so each phase is independently mergeable and leaves `main` deployable.

### Phase 0: hygiene (½ day)
- [ ] Add `.nvmrc`; point workflow and esbuild `Target` at it
- [ ] Remove stale `serverless.yml` references from `SAM.md` / `TODO.md` / template comments
- [ ] Let API Gateway own CORS; drop `*` headers from `src/lib/response.ts`
- [ ] Move hardcoded account IDs out of `deploy.yml` / `samconfig.toml`

### Phase 1: tests + PR gate (1 day)
- [ ] vitest + aws-sdk-client-mock in `backend/`; first tests for `getCaller()` and `mounts.ts` traversal guards
- [ ] ESLint for backend + frontend
- [ ] `.github/workflows/ci.yml` (§3.2); branch protection on `main`

### Phase 2: local dev (1 to 2 days)
- [ ] `docker-compose.yml`, `env.local.json`, `seed.mjs`, `db:create`
- [ ] `AUTH_MODE=local` shim + tests; Vite proxy + dev-user picker
- [ ] `Makefile`, `.devcontainer/`, `docs/LOCAL_DEV.md`

### Phase 3: environments + CD (1 to 2 days)
- [ ] Split OIDC role into `gha-deploy-nonprod` / `gha-deploy-prod` (environment-scoped `sub`)
- [ ] GitHub Environments `preview` / `dev` / `prod`
- [ ] `_deploy-stage.yml` + `deploy.yml` (dev auto, prod gated) + `smoke.mjs`
- [ ] `preview.yml` + nightly stale-stack reaper

### Phase 4: friends domain (the actual POC)
- [ ] Single-table `AppTable` + GSI1 in `template.yaml` (Retain/PITR on prod only)
- [ ] `users`, `friends`, `posts`, `media` domain Lambdas (arm64, Powertools)
- [ ] Media bucket per stage + `thumbnail-fn`
- [ ] Frontend pages: Friends (list/requests), Feed, Profile
- [ ] DynamoDB Streams → EventBridge → `notify-fn` (friend-request email via existing SES stack)

### Open questions (need a human)
1. **Same repo or new repo?** This doc assumes the POC is built *here* on
   `Serverless_POC` and reuses the deploy tooling. A fresh repo (e.g.
   `ourcaption`) seeded from this template is equally valid and keeps
   BackFriend's history clean.
2. **Same AWS account as BackFriend prod?** Fine for a POC with distinct
   `ResourcePrefix`. A separate account is safer if friends' data is involved.
3. **Web-first or mobile-first?** The Cognito mobile client and the
   `apple-app-site-association` file already exist. If mobile-first, Expo
   plus the same API is the path, and Tier 2 local dev gets an Expo variant.
