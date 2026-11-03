#!/bin/bash
# Deploys deploy/kubernetes to a throwaway kind cluster, following docs/onprem/kubernetes.md,
# with a real NFS server, Traefik, cert-manager and enforced NetworkPolicies, then runs
# e2e.mjs through the Ingress. Exports squash to 99:100, like a fresh Unraid share.
# Needs Docker, kind, kubectl, kustomize, helm, Node, and sudo for the NFS server. It
# installs and changes system services, so it's meant for CI.
set -euo pipefail
cd "$(dirname "$0")/k8s"
K="kubectl"

sudo apt-get update -qq
sudo apt-get install -y -qq nfs-kernel-server
# One exported share with config/ and data/ inside, mounted by subdirectory like Unraid.
sudo mkdir -p /srv/nfs/sharing_schuit_io/data /srv/nfs/sharing_schuit_io/config
sudo chown -R 99:100 /srv/nfs
sudo chmod -R 775 /srv/nfs
echo '/srv/nfs/sharing_schuit_io *(rw,sync,no_subtree_check,insecure,all_squash,anonuid=99,anongid=100)' | sudo tee /etc/exports
sudo exportfs -ra
sudo systemctl restart nfs-kernel-server

kind create cluster --name backfriend --config kind.yaml --wait 120s
docker exec backfriend-control-plane sh -c 'apt-get update -qq && apt-get install -y -qq nfs-common' >/dev/null
docker build -q -t backfriend:e2e -f ../../docker/Dockerfile ../../..
kind load docker-image backfriend:e2e --name backfriend

dump() {
  $K get pods,pv,pvc,ingress,certificate -A -o wide || true
  $K -n backfriend describe pods || true
  for d in backfriend keycloak postgres; do $K -n backfriend logs "deploy/$d" --tail=60 || true; done
}
trap dump ERR

helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo add traefik https://traefik.github.io/charts >/dev/null
helm repo update >/dev/null
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true --wait --timeout 5m
helm install traefik traefik/traefik -n traefik --create-namespace --wait --timeout 5m \
  --set service.type=NodePort \
  --set ports.web.nodePort=30080 --set ports.websecure.nodePort=30443
$K apply -f selfsigned-issuer.yml

# The docs' secret step, unchanged.
BOOTSTRAP_ADMIN_EMAILS=admin@e2e.test SMTP_HOST=smtp-sink SMTP_PORT=1025 SMTP_FROM=noreply@e2e.test \
  SMTP_AUTH=false SMTP_STARTTLS=false SMTP_URL=smtp://smtp-sink:1025 ../../kubernetes/gen-secret.sh

NFS_SERVER=$(docker network inspect kind -f '{{(index .IPAM.Config 0).Gateway}}')
kustomize build . | sed "s/NFS_SERVER/$NFS_SERVER/" | $K apply -f -

# Every pod restricted by the namespace's Pod Security level has to schedule, start and stay up.
$K -n backfriend rollout status deploy/postgres --timeout=300s
$K -n backfriend rollout status deploy/keycloak --timeout=420s
$K -n backfriend rollout status deploy/backfriend --timeout=180s
$K -n backfriend wait certificate/backfriend-tls --for=condition=Ready --timeout=120s

echo '127.0.0.1 sharing.test' | sudo tee -a /etc/hosts
$K -n backfriend port-forward svc/smtp-sink 1080:1080 >/dev/null 2>&1 &
PF=$!
sleep 3
BASE=https://sharing.test SINK=http://127.0.0.1:1080 ADMIN_EMAIL=admin@e2e.test NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node ../e2e.mjs
kill $PF

# The files and the database each landed in their own directory on the share.
test -n "$(sudo find /srv/nfs/sharing_schuit_io/data -type f -print -quit)"
sudo test -f /srv/nfs/sharing_schuit_io/config/postgres/data/PG_VERSION
echo "kubernetes: data landed in data/ and config/ on the share"

# Network policy is enforced: the app can reach Postgres, but the backup pod can't reach Keycloak.
$K -n backfriend create job backup-check --from=cronjob/database-backup
$K -n backfriend wait job/backup-check --for=condition=Complete --timeout=120s
sudo test -s "/srv/nfs/sharing_schuit_io/config/backups/backfriend-$(date +%F).dump"
echo "kubernetes: backup job OK"
$K -n backfriend run np-check --image=node:22-alpine --restart=Never \
  --labels=app=database-backup \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"np-check","image":"node:22-alpine","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"command":["node","-e","fetch(\"http://keycloak:8080/idp/\",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))"]}]}}'
$K -n backfriend wait pod/np-check --for=jsonpath='{.status.phase}'=Succeeded --timeout=60s
echo "kubernetes: network policy blocks what it should"
