# Migrate from the cloud deployment

Moves files, invites, mounts and public links. Run it after the
[Kubernetes](kubernetes.md) or [Compose](compose.md) steps up to DNS, so the site is deployed but
still not receiving traffic.

**What doesn't move:** Cognito accounts. Passwords can't be exported and account IDs change, so
everyone signs in fresh. The import reopens redeemed invites for a year for that reason. Each is
used up again at that person's first on-prem sign-in. Public links keep their tokens and keep working.

## 1. Copy the files

Object keys become paths under `data/`, so mount prefixes carry over unchanged. If the web app
shares the bucket, as `web/` does on `schuit-sharing`, exclude it. Run this as the owner of the
share, or fix ownership afterwards:

```bash
aws s3 sync s3://<shares-bucket>/ /mnt/user/sharing_schuit_io/data/ --exclude 'web/*'
chown -R nobody:users /mnt/user/sharing_schuit_io/data
```

Run it again just before the DNS change to pick up anything new.

## 2. Export the tables

```bash
aws dynamodb list-tables --query 'TableNames[?contains(@, `sharing`)]'
aws dynamodb scan --table-name <invites-table> > invites.json
aws dynamodb scan --table-name <mounts-table> > mounts.json
aws dynamodb scan --table-name <public-shares-table> > shares.json
```

Each file must be a single scan result, so check for `NextToken` on large tables.

## 3. Import

`SHARES_BUCKET` must be `content`, the app's name for `data/`.

```bash
# Kubernetes
POD=$(kubectl -n backfriend get pod -l app=backfriend -o name)
for f in invites mounts shares; do kubectl -n backfriend exec -i $POD -- sh -c "cat > /tmp/$f.json" < $f.json; done
kubectl -n backfriend exec $POD -- env SHARES_BUCKET=content CONTENT_ROOT=/data/content \
  node import-aws.mjs /tmp/invites.json /tmp/mounts.json /tmp/shares.json

# Compose, from deploy/compose
for f in invites mounts shares; do docker compose exec -T app sh -c "cat > /tmp/$f.json" < $f.json; done
docker compose exec -e SHARES_BUCKET=content app node import-aws.mjs /tmp/invites.json /tmp/mounts.json /tmp/shares.json
```

It prints the number of rows imported. The `/tmp` copies are gone when the pod restarts.

## 4. Switch over

1. Do a final `aws s3 sync`. Uploads made after this stay on AWS.
2. Point DNS at the new deployment. The certificate issues within a minute or two, and the site
   shows a certificate warning until then.
3. Sign in as a bootstrap admin, open a mount and a public link.
4. Tell users to sign in again with the same email address.

**Keep the AWS stacks for a while.** To roll back, point DNS at CloudFront again. Anything uploaded
on-prem in the meantime won't be there. Once you're confident, tear them down with
`node scripts/teardown.mjs`, after turning off `.github/workflows/deploy.yml` so `main` stops deploying to AWS.

The mobile app talks to Cognito, so it won't work against the on-prem deployment until it supports Keycloak.
