#!/usr/bin/env bash
# Builds and deploys the SPA to s3://<SITE_BUCKET>/<SITE_PREFIX>/, then
# invalidates the CloudFront distribution.
#
# Auto-discovers SiteUploadPath and DistributionId from the
# `schuit-sharing-frontend` CloudFormation stack.
#
# Usage:
#   ./scripts/deploy.sh                # uses your default AWS profile
#   AWS_PROFILE=my-profile ./scripts/deploy.sh
#   STACK_NAME=schuit-sharing-frontend ./scripts/deploy.sh

set -euo pipefail

STACK_NAME="${STACK_NAME:-schuit-sharing-frontend}"
REGION="${AWS_REGION:-us-east-1}"

PROFILE_FLAG=""
if [[ -n "${AWS_PROFILE:-}" ]]; then
  PROFILE_FLAG="--profile $AWS_PROFILE"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$FRONTEND_DIR"

if [[ ! -f .env.local ]]; then
  echo "ERROR: $FRONTEND_DIR/.env.local is missing." >&2
  echo "Copy .env.example and fill in the values from \`serverless info\` and the CFN outputs." >&2
  exit 1
fi

echo "==> Looking up upload target + distribution from stack $STACK_NAME"
SITE_UPLOAD_PATH="$(
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteUploadPath'].OutputValue | [0]" \
    --output text $PROFILE_FLAG
)"
DISTRIBUTION_ID="$(
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue | [0]" \
    --output text $PROFILE_FLAG
)"

if [[ -z "$SITE_UPLOAD_PATH" || "$SITE_UPLOAD_PATH" == "None" ]]; then
  echo "ERROR: SiteUploadPath output missing on $STACK_NAME. Has the infrastructure stack been deployed?" >&2
  echo "Run: cd ../infrastructure && ./deploy.sh" >&2
  exit 1
fi
if [[ -z "$DISTRIBUTION_ID" || "$DISTRIBUTION_ID" == "None" ]]; then
  echo "ERROR: DistributionId output missing on $STACK_NAME." >&2
  exit 1
fi

echo "    SiteUploadPath = $SITE_UPLOAD_PATH"
echo "    DistributionId = $DISTRIBUTION_ID"

echo "==> Building (vite + tsc)"
npm run build

echo "==> Syncing dist/ to $SITE_UPLOAD_PATH"
aws s3 sync dist/ "$SITE_UPLOAD_PATH" --delete $PROFILE_FLAG

echo "==> Invalidating CloudFront distribution $DISTRIBUTION_ID"
INVALIDATION_ID="$(
  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text $PROFILE_FLAG
)"

echo "==> Invalidation $INVALIDATION_ID submitted. Live in ~60s at:"
URL="$(
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue | [0]" \
    --output text $PROFILE_FLAG
)"
echo "    $URL"
