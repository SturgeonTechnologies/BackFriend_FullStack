# Infrastructure deployment

CloudFormation template that provisions the `sharing.schuit.io` front door:

- ACM certificate (DNS-validated against the Route 53 hosted zone)
- Private S3 bucket for the SPA (OAC, no public access)
- CloudFront distribution with two origins:
  - Default → S3 site
  - `/api/*` → API Gateway (CloudFront Function strips `/api` prefix before forwarding)
- Route 53 A-alias `sharing.schuit.io → CloudFront`

## How DNS works here

> **You don't need a separate Route 53 hosted zone for `sharing.schuit.io`.**
> Subdomains live as records *inside* the parent zone. This stack uses the
> existing `schuit.io` hosted zone and adds two things to it:
>
> 1. A CNAME created temporarily by ACM to validate the cert (removed automatically after issuance).
> 2. An A-alias `sharing.schuit.io → CloudFront` (the permanent record).
>
> If the `schuit.io` hosted zone doesn't exist yet, create it once:
> ```bash
> aws route53 create-hosted-zone \
>   --name schuit.io \
>   --caller-reference "$(date +%s)"
> ```
> then point your registrar at the four nameservers it prints. That's a
> one-time setup per root domain, not per subdomain.

## Prereqs

- Backend deployed (see `../backend/README.md`) — you need the API Gateway host
- The Route 53 hosted zone for `schuit.io` already exists in this account (see note above)
- AWS CLI configured for the same account

## 1. Gather inputs

```bash
# Hosted zone ID for schuit.io
aws route53 list-hosted-zones-by-name --dns-name schuit.io \
  --query 'HostedZones[0].Id' --output text | sed 's#/hostedzone/##'
# e.g. ZXXXXXXXXXXXXX

# API Gateway execute-api host (strip the https:// and /dev/ from ApiEndpoint)
# e.g. abc123def.execute-api.us-east-1.amazonaws.com
cd ../backend && npx serverless info --stage dev | grep 'ApiEndpoint:'
```

## 2. Deploy

**Must be deployed in `us-east-1`** — CloudFront requires its ACM cert in that region.

### Option A — one-liner via helper script (recommended)

```bash
cd infrastructure
./deploy.sh                  # stage=dev
# or
STAGE=prod ./deploy.sh
PROFILE=my-aws-profile ./deploy.sh
```

`deploy.sh` auto-discovers the parent `schuit.io` hosted zone and the API Gateway host from the already-deployed backend stage, then runs `aws cloudformation deploy` for you.

### Option B — manual

```bash
HOSTED_ZONE_ID=ZXXXXXXXXXXXXX
API_HOST=abc123def.execute-api.us-east-1.amazonaws.com

cd infrastructure

aws cloudformation deploy \
  --region us-east-1 \
  --stack-name rom-hub-frontend \
  --template-file frontend-infra.yml \
  --parameter-overrides \
      DomainName=sharing.schuit.io \
      HostedZoneId=$HOSTED_ZONE_ID \
      ApiGatewayDomain=$API_HOST \
  --capabilities CAPABILITY_IAM
```

DNS validation for ACM takes 2–5 minutes. The stack won't finish until the cert is issued.

## 3. Capture outputs

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name rom-hub-frontend \
  --query 'Stacks[0].Outputs' --output table
```

| Output               | Used by                   |
|----------------------|---------------------------|
| `SiteBucketName`     | `frontend/` deploy        |
| `DistributionId`     | `frontend/` invalidation  |
| `DistributionDomain` | (diagnostic)              |
| `Url`                | https://sharing.schuit.io |

## 4. Upload the initial site

See `../frontend/README.md` step 5. After `aws s3 sync`, visit https://sharing.schuit.io.

## Updating

### If you change `frontend-infra.yml`

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name rom-hub-frontend \
  --template-file frontend-infra.yml \
  --parameter-overrides DomainName=sharing.schuit.io HostedZoneId=$HOSTED_ZONE_ID ApiGatewayDomain=$API_HOST \
  --capabilities CAPABILITY_IAM
```

CloudFormation diffs and applies only what changed. Distribution updates take 5–15 min to fully propagate.

### If the API Gateway host changes

(This happens if you `serverless remove` and redeploy.) Rerun step 2 with the new `API_HOST`.

## Teardown

```bash
# Empty the site bucket first
aws s3 rm s3://<SiteBucketName>/ --recursive

aws cloudformation delete-stack \
  --region us-east-1 \
  --stack-name rom-hub-frontend
```

ACM certificates are deleted automatically when no longer in use. The Route 53 hosted zone itself is **not** touched — the stack only created one A-alias record within it.

## What the CloudFront Function does

```js
function handler(event) {
  var req = event.request;
  if (req.uri.indexOf('/api/') === 0) {
    req.uri = req.uri.substring(4); // drop "/api"
  }
  return req;
}
```

So:

- Browser asks `GET https://sharing.schuit.io/api/mounts`
- CloudFront matches the `/api/*` cache behavior → forwards to `api-gw` origin
- The function rewrites `/api/mounts` → `/mounts` before CloudFront hits API Gateway
- API Gateway sees a clean `/mounts` path (matching `serverless.yml` routes)

Origin request policy `AllViewerExceptHostHeader` is used so `Authorization` and CORS headers pass through, but Host is rewritten to API Gateway's expected domain.

## Costs (rough, us-east-1)

- CloudFront: $0.085/GB (first 10TB) + per-request (negligible for this usage)
- ACM: free
- Route 53 hosted zone: $0.50/month
- S3 site bucket: a few cents/month for a small SPA

Likely <$2/mo for a personal deployment.
