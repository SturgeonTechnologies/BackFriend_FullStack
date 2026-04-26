# Open items

This file is a hand-off note between sessions. Resolve items here, or
delete the line, when they're done.

## Active

- [ ] **SES invite emails not working yet.** Code is deployed
      (`4848be9 Send invite emails via SES from noreply@schuit.io`), but
      the actual end-to-end send hasn't succeeded. Pick this up next
      session — see the diagnostic checklist below before assuming any
      particular failure mode.

      Diagnostic checklist (run these first):
      ```bash
      # 1. Did the email-infra stack deploy cleanly?
      aws cloudformation describe-stacks --region us-east-1 \
        --stack-name rom-hub-email \
        --query 'Stacks[0].StackStatus' --output text

      # 2. Is the SES domain identity verified?
      aws ses get-identity-verification-attributes --region us-east-1 \
        --identities schuit.io \
        --query 'VerificationAttributes."schuit.io".VerificationStatus'

      # 3. Are the DKIM tokens verified?
      aws ses get-identity-dkim-attributes --region us-east-1 \
        --identities schuit.io \
        --query 'DkimAttributes."schuit.io".DkimVerificationStatus'

      # 4. Did the backend redeploy land MAIL_FROM + ses:SendEmail IAM?
      aws lambda get-function-configuration --region us-east-1 \
        --function-name rom-hub-dev-createInvite \
        --query 'Environment.Variables.MAIL_FROM' --output text

      # 5. Sandbox status (until we request production access, only
      #    verified recipients can receive mail)
      aws sesv2 get-account --region us-east-1 \
        --query 'ProductionAccessEnabled'

      # 6. The actual error from the last attempted send:
      cd backend && npx serverless logs -f createInvite --stage dev \
        --startTime 1h
      ```

      Likely culprits in rough probability order:
        1. SES still in *sandbox* and the recipient address isn't verified.
           Fix: `aws ses verify-email-identity --region us-east-1
           --email-address <recipient>` and click the link AWS sends, OR
           request production access via the SES console.
        2. DKIM CNAMEs not yet verified (5–60 min wait after stack deploy).
           Fix: just wait, then re-poll #3.
        3. Backend wasn't redeployed since the SES commit, so the Lambdas
           don't have `MAIL_FROM`/`MAIL_REGION` env vars or the
           `ses:SendEmail` IAM grant. Fix: `cd backend && npx serverless
           deploy --stage dev`.
        4. `MailFromAttributes.BehaviorOnMxFailure: REJECT_MESSAGE` is set
           in `email-infra.yml` — if the `mail.schuit.io` MX/SPF didn't
           propagate, SES will refuse to send. Fix: confirm the records
           landed: `dig mail.schuit.io MX` and `dig mail.schuit.io TXT`.

## Done in last session (for context)

- `a2f3a5e` Per-mount allowedEmails access control + SPA asset routing
- `b616904` Document /api same-origin pattern in .env.example
- `90ee5b1` Attach SPA rewrite function to /api/* behavior too
- `4848be9` Send invite emails via SES from noreply@schuit.io (build
  complete, end-to-end send not yet verified — see Active above)
