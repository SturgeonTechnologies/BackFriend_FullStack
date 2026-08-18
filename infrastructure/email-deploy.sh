#!/usr/bin/env bash
# Deploys the SES email-infra CloudFormation stack.
#
# What this does:
#   - Looks up the Route 53 hosted zone for the parent domain (yours -- no
#     default, see DOMAIN below) the same way deploy.sh does.
#   - Deploys email-infra.yml in us-east-1, which creates an SES domain
#     identity for that domain plus the DKIM CNAMEs and MAIL FROM MX/SPF
#     records on a subdomain (default: mail.${DOMAIN}).
#   - Prints the stack outputs (FromAddress, MailFromDomain, IdentityArn).
#
# After this script:
#   - DKIM verification is asynchronous. Run `email-status.sh` (or the
#     SES console) to poll status. Typical wait is 5–60 minutes.
#   - The SES account is in *sandbox* mode by default. Until production
#     access is requested + granted, sends only succeed to verified
#     recipient addresses (verify your own inbox via the console first if
#     testing in sandbox).
#
# Usage:
#   DOMAIN=your-domain.example ./email-deploy.sh
#   DOMAIN=your-domain.example PARENT_ZONE=your-domain.example ./email-deploy.sh
#   PROFILE=my-aws-profile ./email-deploy.sh

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=your-domain.example ./email-deploy.sh}"
PARENT_ZONE="${PARENT_ZONE:-$DOMAIN}"
MAIL_FROM_SUB="${MAIL_FROM_SUB:-mail}"
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-email-infra}"

PROFILE_FLAG=""
if [[ -n "${PROFILE:-}" ]]; then
  PROFILE_FLAG="--profile $PROFILE"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/email-infra.yml"

echo "==> Looking up Route 53 hosted zone for $PARENT_ZONE"
HOSTED_ZONE_ID="$(
  aws route53 list-hosted-zones-by-name \
    --dns-name "$PARENT_ZONE" \
    --query "HostedZones[?Name=='${PARENT_ZONE}.'].Id | [0]" \
    --output text $PROFILE_FLAG \
  | sed 's#/hostedzone/##'
)"
if [[ -z "$HOSTED_ZONE_ID" || "$HOSTED_ZONE_ID" == "None" ]]; then
  echo "ERROR: no Route 53 hosted zone found for $PARENT_ZONE" >&2
  exit 1
fi
echo "    HostedZoneId=$HOSTED_ZONE_ID"
echo "    Domain=$DOMAIN"
echo "    MailFromSubdomain=$MAIL_FROM_SUB (final: ${MAIL_FROM_SUB}.${DOMAIN})"
echo "    Region=$REGION"

echo "==> Deploying $STACK_NAME to $REGION"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --parameter-overrides \
      Domain="$DOMAIN" \
      MailFromSubdomain="$MAIL_FROM_SUB" \
      HostedZoneId="$HOSTED_ZONE_ID" \
      Region="$REGION" \
  --capabilities CAPABILITY_IAM \
  $PROFILE_FLAG

echo "==> Outputs"
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table \
  $PROFILE_FLAG

cat <<EOF

Done.

Next steps:

  1. Wait for DKIM verification (5–60 min). Check status:
       aws ses get-identity-verification-attributes \\
         --region $REGION \\
         --identities $DOMAIN \\
         --query 'VerificationAttributes."${DOMAIN}".VerificationStatus' \\
         --output text

  2. SES sandbox: until production access is granted, only verified
     recipients can receive mail. Verify your test recipient (one-time):
       aws ses verify-email-identity --region $REGION --email-address you@example.com

  3. Request production access (one-click form) in the console:
       https://console.aws.amazon.com/ses/home?region=$REGION#/account

  4. Backend Lambdas pick up the env vars MAIL_FROM and MAIL_REGION from
     your deploy.config.<name>.json (mailFrom/mailRegion); redeploy the
     backend so the new IAM grant + envs land:
       cd ../backend && node scripts/deploy.mjs deploy.config.<name>.json

EOF
