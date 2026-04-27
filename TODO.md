# Open items

This file is a hand-off note between sessions. Resolve items here, or
delete the line, when they're done.

## Active

- [ ] **Mid-migration: `rom-hub-dev` → `schuit-sharing-prod`.**
      Code rename is committed and pushed (`e627569`). AWS resources
      are partially cut over. Pick up at step 4 below.

      **Migration progress (as of 2026-04-26):**
        - [x] Step 1: SSM Google creds copied
              `/rom-hub/dev/google/*` → `/schuit-sharing/prod/google/*`.
        - [x] Step 2: Old `rom-hub-email` stack deleted; new
              `schuit-sharing-email` stack deployed. DKIM
              re-verification pending (asynchronous, 5–60 min).
        - [x] Step 3: `riley.schuit@gmail.com` re-verified as SES
              sandbox recipient (the prior verification was tied to
              the old SES identity).
        - [x] Step 4: DKIM verified.
        - [x] Step 5: New backend stack `schuit-sharing-prod`
              deployed (commit `4337069` fixed the SSM region/path
              resolution that was blocking it). API Gateway:
              `g35h6wblu7.execute-api.us-east-1.amazonaws.com`.
              Endpoints + 10 Lambdas live. `wire-triggers:prod`
              status — TBD; confirm it ran.
        - [ ] Step 6: Add new Cognito hosted-UI redirect URI to
              Google OAuth client. **Resume here.** Get the URL
              from `aws cloudformation describe-stacks
              --stack-name schuit-sharing-prod
              --query 'Stacks[0].Outputs[?OutputKey==\`CognitoDomain\`]'`.
              Add `<CognitoDomain>/oauth2/idpresponse` to the OAuth
              client's Authorized redirect URIs.
        - [ ] Step 7: Update CloudFront `ApiGatewayDomain` parameter
              on the existing `rom-hub-frontend` stack:
              `cd infrastructure && STACK_NAME=rom-hub-frontend
              STAGE=prod ./deploy.sh`. Also rebuild the SPA with
              the new VITE_USER_POOL_CLIENT_ID and VITE_COGNITO_DOMAIN
              from the new stack outputs, then `aws s3 sync` the
              dist + invalidate CloudFront.
        - [ ] Step 8: Sign in once to bootstrap admin on the new
              User Pool.
        - [ ] Step 9: Smoke test (mount + invite + email delivery).
        - [ ] Step 10: Tear down old `rom-hub-dev` backend stack.
        - [ ] Step 11: Cleanup — delete old SSM params + remove old
              Cognito redirect URI from Google OAuth client.
        - [ ] (Optional, later) Rename frontend stack
              `rom-hub-frontend` → `schuit-sharing-frontend`. Requires
              CloudFront re-create (~20–30 min downtime). Defer.

      **Resume runbook (steps 4–11):**

      ```bash
      # 4. Poll DKIM until "Success" (5–60 min after step 2 completed).
      #    Repeat manually or use the polling loop below.
      aws ses get-identity-dkim-attributes --region us-east-1 \
        --identities schuit.io \
        --query 'DkimAttributes."schuit.io".DkimVerificationStatus' \
        --output text

      # Polling loop:
      while true; do
        STATUS=$(aws ses get-identity-dkim-attributes --region us-east-1 \
          --identities schuit.io \
          --query 'DkimAttributes."schuit.io".DkimVerificationStatus' \
          --output text)
        echo "$(date +%T) DKIM=$STATUS"
        [[ "$STATUS" == "Success" ]] && break
        sleep 30
      done

      # 5. Deploy the new backend stack.
      cd backend
      npx serverless deploy --stage prod
      npm run wire-triggers:prod
      npx serverless info --stage prod   # capture CognitoDomain + ApiEndpoint

      # 6. Add the NEW Cognito hosted-UI redirect URI in Google Cloud
      #    Console → APIs & Services → Credentials → your OAuth client →
      #    Authorized redirect URIs:
      #      https://schuit-sharing-prod-<acct>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
      #    Leave the old rom-hub-dev-* URI registered until step 11.

      # 7. Point CloudFront at the new API Gateway. The frontend
      #    stack is still named `rom-hub-frontend`; we just update
      #    its ApiGatewayDomain parameter (no recreate needed).
      #    deploy.sh discovers BACKEND_STACK=schuit-sharing-${STAGE},
      #    so STAGE=prod points at the new backend automatically.
      cd ../infrastructure
      STACK_NAME=rom-hub-frontend STAGE=prod ./deploy.sh

      # 8. Sign in once at https://sharing.schuit.io. The postAuth
      #    trigger sees riley.schuit@gmail.com in
      #    BOOTSTRAP_ADMIN_EMAILS and adds you to the new admins
      #    group automatically.

      # 9. Smoke test: create a mount, send an invite to the
      #    verified address, confirm email delivery.

      # 10. Tear down the old backend stack via raw CFN (the
      #     renamed serverless service can't manage the old stack).
      aws cloudformation delete-stack --region us-east-1 \
        --stack-name rom-hub-dev
      aws cloudformation wait stack-delete-complete --region us-east-1 \
        --stack-name rom-hub-dev

      # 11. Cleanup.
      aws ssm delete-parameter --region us-east-1 \
        --name /rom-hub/dev/google/client_id
      aws ssm delete-parameter --region us-east-1 \
        --name /rom-hub/dev/google/client_secret
      # Then remove the old rom-hub-dev-*.amazoncognito.com/oauth2/idpresponse
      # entry from the Google OAuth client's Authorized redirect URIs.
      ```

      **Optional later — rename the frontend stack.** Currently
      `rom-hub-frontend` owns CloudFront + the Route53 A-alias for
      `sharing.schuit.io` + the ACM cert. CFN doesn't support stack
      renames; the only path is delete + recreate. Expect ~20–30 min
      of user-visible downtime (CloudFront propagation). The only
      cost of leaving it is the legacy name in the AWS console.

      ```bash
      aws cloudformation delete-stack --region us-east-1 \
        --stack-name rom-hub-frontend
      aws cloudformation wait stack-delete-complete --region us-east-1 \
        --stack-name rom-hub-frontend
      cd infrastructure && ./deploy.sh
      # default STACK_NAME=schuit-sharing-frontend, STAGE=prod
      ```

- [ ] **SES is still in sandbox.** End-to-end send was verified on
      the prior identity (2026-04-26). After the rename migration
      finishes, re-verify with a fresh send. To remove sandbox
      restrictions: SES console → Account dashboard → "Request
      production access". Bumps quota from 200/day to ~50,000/day
      and removes the verified-recipient restriction.

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

      **Frontend infra.** `infrastructure/frontend-infra.yml` is the
      gating change — currently has hardcoded values for the prod
      domain/cert/Route53 record. Needs to accept `Domain`,
      `AcmCertArn`, `ApiGatewayDomain` parameters so two stacks
      (`schuit-sharing-frontend-staging`,
      `schuit-sharing-frontend-prod`) can deploy from the same
      template.

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

## Done in this session

- `bc708a4` email-infra: fix invalid `!GetAtt EmailIdentity.Arn`
  (unblocked the original email stack create).
- `9d5a473` auth: first attempt at parsing space-delimited
  cognito:groups (insufficient on its own).
- `3e64c91` auth: log raw cognito:groups + broaden parser. Confirmed
  HTTP API v2 emits array claims as Java's `Object[].toString()`
  format, e.g. `"[<pool>_Google admins]"`. The broadened parser
  handles all observed shapes (true array, JSON-encoded array,
  comma-separated, space-separated).
- `bcdc392` auth: removed the diagnostic log; SES end-to-end
  verified on the original identity.
- `a74c150` docs: flipped SES status banner to "verified"; captured
  the staging + GitHub Actions CD plan in TODO.md.
- `e627569` Renamed `rom-hub` → `schuit-sharing` everywhere in
  code/docs (service name, stack names, SSM paths, package names,
  scripts). Added the migration runbook to TODO.md.
- Migration steps 1–3 executed live: SSM creds copied to the new
  path, old email stack deleted + new email stack deployed, sandbox
  recipient re-verified. Steps 4–11 still pending.
