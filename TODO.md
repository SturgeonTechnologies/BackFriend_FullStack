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
