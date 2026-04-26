# Open items

This file is a hand-off note between sessions. Resolve items here, or
delete the line, when they're done.

## Active

- [ ] **Migrate the live deployment from `rom-hub-dev` to
      `schuit-sharing-prod`.** Code is renamed (this commit). The AWS
      resources still need cutover. Runbook below — do all of it in
      one sitting if possible since the old + new stacks coexist
      until step 9.

      **Pre-flight.** New SSM path is `/schuit-sharing/prod/google/*`
      (was `/rom-hub/dev/google/*`). New Cognito hosted-UI domain
      will be `schuit-sharing-prod-<acct>.auth.us-east-1.
      amazoncognito.com`. Stack names: `schuit-sharing-prod`
      (backend), `schuit-sharing-email` (SES). The frontend stack
      stays `rom-hub-frontend` for now — its rename is an optional
      later step (#11) since it requires CloudFront re-create.

      ```bash
      # 1. Copy Google creds to the new SSM path (same values)
      CID=$(aws ssm get-parameter --region us-east-1 \
        --name /rom-hub/dev/google/client_id \
        --query 'Parameter.Value' --output text)
      CSEC=$(aws ssm get-parameter --region us-east-1 --with-decryption \
        --name /rom-hub/dev/google/client_secret \
        --query 'Parameter.Value' --output text)
      aws ssm put-parameter --region us-east-1 \
        --name /schuit-sharing/prod/google/client_id \
        --type String --value "$CID" --overwrite
      aws ssm put-parameter --region us-east-1 \
        --name /schuit-sharing/prod/google/client_secret \
        --type SecureString --value "$CSEC" --overwrite

      # 2. Replace the email stack. Single SES identity per domain,
      #    so old + new stacks would conflict — must delete first.
      #    Expect 5–60 min DKIM revalidation gap after redeploy.
      aws cloudformation delete-stack --region us-east-1 \
        --stack-name rom-hub-email
      aws cloudformation wait stack-delete-complete --region us-east-1 \
        --stack-name rom-hub-email
      cd infrastructure && ./email-deploy.sh

      # 3. Re-verify the SES sandbox recipient (the old verification
      #    is tied to the prior identity, so this needs redoing).
      aws ses verify-email-identity --region us-east-1 \
        --email-address riley.schuit@gmail.com
      # (click the link AWS emails you)

      # 4. Wait for DKIM to verify before continuing — otherwise
      #    every send will fail with REJECT_MESSAGE on MX failure.
      aws ses get-identity-dkim-attributes --region us-east-1 \
        --identities schuit.io \
        --query 'DkimAttributes."schuit.io".DkimVerificationStatus' \
        --output text   # repeat until "Success"

      # 5. Deploy the new backend stack.
      cd backend
      npx serverless deploy --stage prod
      npm run wire-triggers:prod
      npx serverless info --stage prod   # capture the outputs

      # 6. Add the NEW Cognito hosted-UI redirect URI to the Google
      #    OAuth client (Google Cloud Console → APIs & Services →
      #    Credentials → your OAuth client → Authorized redirect URIs).
      #    Add:
      #      https://schuit-sharing-prod-<acct>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
      #    Leave the old rom-hub-dev-* URI registered until step 10.

      # 7. Point CloudFront at the new API Gateway. The frontend
      #    stack (still named `rom-hub-frontend`) just needs its
      #    ApiGatewayDomain parameter updated. deploy.sh now reads
      #    BACKEND_STACK=schuit-sharing-${STAGE}, so STAGE=prod
      #    points at the new backend automatically.
      cd ../infrastructure
      STACK_NAME=rom-hub-frontend STAGE=prod ./deploy.sh

      # 8. Sign in once at https://sharing.schuit.io to bootstrap
      #    admin on the new User Pool. The postAuth trigger sees
      #    riley.schuit@gmail.com in BOOTSTRAP_ADMIN_EMAILS and
      #    adds you to the admins group.

      # 9. Smoke test: create a mount, create an invite to your
      #    verified address, confirm email arrives.

      # 10. Tear down the old backend stack. We can't use
      #     `serverless remove` since the service was renamed —
      #     delete via raw CFN.
      aws cloudformation delete-stack --region us-east-1 \
        --stack-name rom-hub-dev
      aws cloudformation wait stack-delete-complete --region us-east-1 \
        --stack-name rom-hub-dev

      # 11. Cleanup: delete old SSM params and remove the old Cognito
      #     redirect URI from the Google OAuth client.
      aws ssm delete-parameter --region us-east-1 \
        --name /rom-hub/dev/google/client_id
      aws ssm delete-parameter --region us-east-1 \
        --name /rom-hub/dev/google/client_secret
      ```

      **Optional later step — rename the frontend stack.** Currently
      `rom-hub-frontend` owns CloudFront + the Route53 A-alias for
      `sharing.schuit.io` + the ACM cert. CFN doesn't support stack
      renames; the only path is delete + recreate. Expect ~20–30 min
      of user-visible downtime (CloudFront propagation). Defer until
      convenient — the only cost of leaving it is the legacy name in
      the AWS console.

      ```bash
      aws cloudformation delete-stack --region us-east-1 \
        --stack-name rom-hub-frontend
      aws cloudformation wait stack-delete-complete --region us-east-1 \
        --stack-name rom-hub-frontend
      cd infrastructure && ./deploy.sh
      # default STACK_NAME=schuit-sharing-frontend, STAGE=prod
      ```

- [ ] **SES is still in sandbox.** End-to-end send works
      (`riley.schuit+serverlesstest@gmail.com` received an invite on
      2026-04-26), but only verified recipients can receive mail until
      we request production access. To open it up: SES console →
      Account dashboard → "Request production access". That bumps the
      24-hour sending quota from 200 to ~50,000 and removes the
      verified-recipient restriction.

- [ ] **Hosted-UI logout requires an exact LogoutURLs match.** The
      registered URLs both end with `/`
      (`http://localhost:5173/`, `https://sharing.schuit.io/`), so a
      `logout_uri=https://sharing.schuit.io` (no trailing slash) is
      rejected by Cognito with "Required String parameter
      'redirect_uri' is not present". If the in-app logout sends a URL
      without the trailing slash, either fix the client to include it
      or relax LogoutURLs in `serverless.yml` to register both forms.

- [ ] **Stand up a real staging environment + GitHub Actions CD.**
      Decision pending — Riley wants to think about it. Captured plan:

      **Domain layout.** Keep `sharing.schuit.io` as prod. Add a
      sibling `sharing-staging.schuit.io` for staging. Sibling
      (rather than `staging.sharing.schuit.io`) keeps cookie/storage
      isolation simple and avoids a wildcard cert. Two ACM certs in
      us-east-1 (one per CloudFront distribution) is the cleanest
      blast-radius split; a single multi-SAN cert across both also
      works.

      **Backend.** Already mostly stage-aware (User Pool, DDB tables,
      Cognito domain prefix all stage-suffixed). Per-stage maps in
      `serverless.yml custom.*` need staging entries:
      `allowedOrigins`, `siteOrigin`, `bootstrapAdmins`,
      `cognitoCallbackURLs`, `cognitoLogoutURLs`. Per-stage SSM Google
      creds at `/schuit-sharing/staging/google/{client_id,client_secret}`
      (the live `prod` SSM keys already exist after the rename).

      **The "dev = prod" naming problem.** The existing `dev` stage
      is what's serving sharing.schuit.io publicly. Two paths: (a)
      relabel `dev` as prod going forward (no migration; ugly name),
      or (b) deploy a fresh `prod` stage and migrate DNS + Google
      OAuth redirects + bootstrap-admin sign-in (clean; one-time
      pain). Recommendation was (a) for pragmatism.

      **Frontend infra.** `infrastructure/frontend-infra.yml` is the
      gating change — currently has hardcoded values for the prod
      domain/cert/Route53 record. Needs to accept `Domain`,
      `AcmCertArn`, `ApiGatewayDomain` parameters so two stacks
      (`schuit-sharing-frontend-staging`,
      `schuit-sharing-frontend-prod`) can
      deploy from the same template.

      **SES.** Stays as one shared identity on `schuit.io`. Both
      stages send `From: noreply@schuit.io`. (Optional later: SES
      configuration sets to tag staging sends.)

      **GitHub Actions.** Use AWS OIDC (no long-lived secrets in
      Actions secrets). One IAM Identity Provider for GitHub, two
      roles: `gha-deploy-staging` trusted from `refs/heads/main`,
      `gha-deploy-prod` trusted from `refs/tags/v*` (tag-driven prod
      deploys with manual approval). Two workflows under
      `.github/workflows/`: `deploy-staging.yml` (push to main →
      auto-deploy) and `deploy-prod.yml` (tag push or manual
      dispatch). Each runs `serverless deploy --stage X`,
      `wire-triggers:X`, `aws s3 sync` for the SPA, and a
      CloudFront invalidation.

      **Per-stage gotchas worth flagging when picking this up:**
        - Each User Pool needs its own Google OAuth redirect URIs
          registered in Google Cloud Console (the staging Cognito
          hosted UI's `/oauth2/idpresponse` plus the staging app's
          `/auth/callback`).
        - `wire-triggers` is a per-stage post-deploy step. Add
          `wire-triggers:staging` to backend `package.json`.
        - First sign-in to staging in a browser is required to fire
          `postAuth` and bootstrap admin — CI can't do this for you.
        - Frontend `ApiGatewayDomain` must point at the matching
          stage's API Gateway. Easy to mis-wire silently. Worth a
          smoke test in CI that calls `/api/mounts` after deploy.
        - The S3 `schuit-sharing` bucket is shared across stages. OK
          today (read-only). If write paths are added later, make
          this per-stage.

      **Suggested order of operations:**
        1. Issue ACM cert(s) in us-east-1 with DNS validation.
        2. Parameterize `frontend-infra.yml`. Re-deploy prod stack
           with parameters set to current values (no-op diff).
        3. Add staging entries to `serverless.yml` custom maps.
        4. Manual `serverless deploy --stage staging` from laptop
           once to confirm clean stand-up.
        5. Deploy `frontend-infra.yml` as
           `schuit-sharing-frontend-staging`.
        6. Add staging redirect URIs to Google OAuth client.
        7. Wire OIDC + GitHub Actions, staging workflow first.
        8. Once staging CD is stable, add prod workflow with
           manual approval.

## Done in last session (for context)

- `4848be9` Send invite emails via SES from noreply@schuit.io
- `c632bb6` Add TODO.md hand-off note
- `44625b4` README: flag SES end-to-end send as not yet verified
- `a9a927d` email-infra: shorten Description to fit CFN's 1024-char limit
- `bc708a4` email-infra: fix invalid !GetAtt EmailIdentity.Arn (build
  ARN with !Sub instead) — unblocked the email stack create
- `9d5a473` auth: parse space-delimited cognito:groups from HTTP API
  v2 authorizer (initial parser fix — but still emitted single-token
  output for the bracketed Java-toString format)
- `3e64c91` auth: log raw cognito:groups shape and broaden parser
  (added DIAG_AUTH_GROUPS log + JSON.parse-first strategy + regex
  fallback that strips brackets/quotes/braces and splits on commas
  OR whitespace) — confirmed format is `"[<pool>_Google admins]"`
  (Java Object[].toString) and the broadened parser handles it. The
  diagnostic log was removed in the follow-up commit.
- End-to-end verified: admin gate passes, invite written to DDB,
  invite email delivered via SES.
