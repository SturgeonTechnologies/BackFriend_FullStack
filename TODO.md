# Open items

This file is a hand-off note between sessions. Resolve items here, or
delete the line, when they're done.

## Active

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
      creds at `/rom-hub/staging/google/{client_id,client_secret}`
      and `/rom-hub/prod/...`.

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
      (`rom-hub-frontend-staging`, `rom-hub-frontend-prod`) can
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
        5. Deploy `frontend-infra.yml` as `rom-hub-frontend-staging`.
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
