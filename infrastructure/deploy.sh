#!/usr/bin/env bash
# Deploys the sharing.schuit.io front-door CloudFormation stack.
#
# Looks up the parent `schuit.io` hosted zone, reads the API Gateway host
# from the deployed backend stage, and runs `aws cloudformation deploy` in
# us-east-1.
#
# The SPA is served from an existing bucket (default: schuit-sharing) under
# a prefix (default: web). Override with SITE_BUCKET / SITE_PREFIX /
# SITE_BUCKET_REGION env vars.
#
# Usage:
#   ./deploy.sh                       # stage=dev
#   STAGE=prod ./deploy.sh
#   PROFILE=my-aws-profile ./deploy.sh
#   SITE_BUCKET=my-bucket SITE_PREFIX=app ./deploy.sh

set -euo pipefail

STAGE="${STAGE:-dev}"
DOMAIN="${DOMAIN:-sharing.schuit.io}"
PARENT_ZONE="${PARENT_ZONE:-schuit.io}"
STACK_NAME="${STACK_NAME:-rom-hub-frontend}"
SITE_BUCKET="${SITE_BUCKET:-schuit-sharing}"
SITE_PREFIX="${SITE_PREFIX:-web}"
SITE_BUCKET_REGION="${SITE_BUCKET_REGION:-us-east-1}"

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

echo "==> Looking up API Gateway host from backend stack (stage=$STAGE) in us-east-1"
BACKEND_STACK="rom-hub-${STAGE}"
# Backend stack lives in us-east-1 regardless of your aws CLI default region.
API_ENDPOINT="$(
  aws cloudformation describe-stacks \
    --region us-east-1 \
    --stack-name "$BACKEND_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl' || OutputKey=='ServiceEndpoint' || OutputKey=='ApiEndpoint'].OutputValue | [0]" \
    --output text $PROFILE_FLAG 2>/dev/null || true
)"
if [[ -z "$API_ENDPOINT" || "$API_ENDPOINT" == "None" ]]; then
  echo "ERROR: could not find API endpoint from stack $BACKEND_STACK" >&2
  echo "Deploy the backend first: cd ../backend && npx serverless deploy --stage $STAGE" >&2
  exit 1
fi
# Strip https:// and any trailing /stage-name
API_HOST="$(echo "$API_ENDPOINT" | sed -E 's#^https?://##; s#/.*$##')"
echo "    ApiGatewayDomain=$API_HOST"

echo "==> Deploying $STACK_NAME to us-east-1"
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --parameter-overrides \
      DomainName="$DOMAIN" \
      HostedZoneId="$HOSTED_ZONE_ID" \
      ApiGatewayDomain="$API_HOST" \
      SiteBucket="$SITE_BUCKET" \
      SitePrefix="$SITE_PREFIX" \
      SiteBucketRegion="$SITE_BUCKET_REGION" \
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
  - Add "https://<CognitoDomain>/oauth2/idpresponse" to your Google OAuth
    client's authorized redirect URIs (if not already).
  - Fill in frontend/.env.local with the CloudFront URL + Cognito values.
  - Build and sync the frontend:
      cd ../frontend
      npm install && npm run build
      aws s3 sync dist/ s3://$SITE_BUCKET/$SITE_PREFIX/ --delete
      aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
  - Open https://$DOMAIN and sign in with Google.
EOF
