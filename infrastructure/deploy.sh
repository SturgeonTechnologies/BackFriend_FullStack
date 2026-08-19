#!/usr/bin/env bash
# Deploys the SPA's front-door CloudFormation stack (CloudFront + ACM + DNS).
#
# Looks up the hosted zone for PARENT_ZONE and runs `aws cloudformation
# deploy` in us-east-1. This is a one-time step per domain -- once it
# exists, `node ../backend/scripts/deploy.mjs` builds + syncs the SPA to it
# on every deploy (see the "frontend" block in deploy.config.<name>.json).
#
# The SPA is served from an existing bucket (yours -- no default, see
# SITE_BUCKET below) under a prefix (default: web). Override with
# SITE_BUCKET / SITE_PREFIX / SITE_BUCKET_REGION env vars.
#
# Usage:
#   DOMAIN=your-domain.example PARENT_ZONE=your-domain.example SITE_BUCKET=your-bucket ./deploy.sh
#   PROFILE=my-aws-profile ./deploy.sh
#   SITE_BUCKET=my-bucket SITE_PREFIX=app ./deploy.sh

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=your-domain.example ./deploy.sh}"
PARENT_ZONE="${PARENT_ZONE:-$DOMAIN}"
STACK_NAME="${STACK_NAME:-frontend-infra}"
SITE_BUCKET="${SITE_BUCKET:?Set SITE_BUCKET to your shares bucket, e.g. SITE_BUCKET=your-bucket ./deploy.sh}"
SITE_PREFIX="${SITE_PREFIX:-web}"
SITE_BUCKET_REGION="${SITE_BUCKET_REGION:-us-east-1}"
# Optional: hostname only (no scheme) of the backend's API -- the backend
# stack's ApiEndpoint output with "https://" stripped, or its ApiCustomDomain.
# Wires up the /config passthrough (see frontend-infra.yml ApiOriginDomain)
# so a client can discover this backend from just DOMAIN, not a separate API
# subdomain. Leave unset to skip it.
API_ORIGIN_DOMAIN="${API_ORIGIN_DOMAIN:-}"

PROFILE_FLAG=""
if [[ -n "${PROFILE:-}" ]]; then
  PROFILE_FLAG="--profile $PROFILE"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/frontend-infra.yml"

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
  echo "Create one first: aws route53 create-hosted-zone --name $PARENT_ZONE --caller-reference \$(date +%s)" >&2
  exit 1
fi
echo "    HostedZoneId=$HOSTED_ZONE_ID"

echo "==> Verifying site bucket $SITE_BUCKET exists"
if ! aws s3api head-bucket --bucket "$SITE_BUCKET" $PROFILE_FLAG >/dev/null 2>&1; then
  echo "ERROR: bucket $SITE_BUCKET not found or not accessible." >&2
  echo "Create it first, or set SITE_BUCKET to an existing bucket name." >&2
  exit 1
fi
echo "    SiteBucket=$SITE_BUCKET"
echo "    SitePrefix=$SITE_PREFIX"
echo "    SiteBucketRegion=$SITE_BUCKET_REGION"

echo "==> Deploying $STACK_NAME to us-east-1"
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --parameter-overrides \
      DomainName="$DOMAIN" \
      HostedZoneId="$HOSTED_ZONE_ID" \
      SiteBucket="$SITE_BUCKET" \
      SitePrefix="$SITE_PREFIX" \
      SiteBucketRegion="$SITE_BUCKET_REGION" \
      ApiOriginDomain="$API_ORIGIN_DOMAIN" \
  --capabilities CAPABILITY_IAM \
  $PROFILE_FLAG

echo "==> Outputs"
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table \
  $PROFILE_FLAG

cat <<EOF

Done. Next steps:
  - Set "distributionStackName": "$STACK_NAME" in your deploy.config.<name>.json's
    "frontend" block, then run:
      cd ../backend && node scripts/deploy.mjs deploy.config.<name>.json
    which builds + syncs the SPA here (and everything else) in one shot.
  - Open https://$DOMAIN once that's done.
EOF
