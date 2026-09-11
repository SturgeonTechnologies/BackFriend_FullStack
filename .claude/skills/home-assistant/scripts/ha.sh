#!/usr/bin/env bash
# Home Assistant REST API helper.
#
# Resolves the base URL + long-lived token from AWS Secrets Manager, probes
# candidate base URLs (LAN first, then public), and wraps GET/POST calls so
# callers don't have to re-derive auth headers every time.
#
# Usage:
#   ha.sh get  <path> [jq-filter]
#   ha.sh post <path> <json-body>
#
# Examples:
#   ha.sh get  /api/states
#   ha.sh get  /api/states/light.living_room
#   ha.sh get  /api/states '[.[] | select(.entity_id | startswith("light."))]'
#   ha.sh post /api/services/light/turn_on '{"entity_id":"light.living_room"}'
#
# Env overrides:
#   HA_SECRET_ID     Secrets Manager secret id/ARN (default: home-assistant/api)
#   HA_SECRET_REGION AWS region for the secret       (default: us-west-2)
#   HA_URL / HA_TOKEN  set both to skip the secret lookup entirely
#   HA_EXTRA_CANDIDATE optional extra base URL to try before the public one
#                      (e.g. an internal k8s DNS name reachable from a pod)

set -euo pipefail

SECRET_ID="${HA_SECRET_ID:-home-assistant/api}"
SECRET_REGION="${HA_SECRET_REGION:-us-west-2}"

if [[ -z "${HA_TOKEN:-}" || -z "${HA_URL:-}" ]]; then
  if command -v aws >/dev/null 2>&1; then
    secret_json=$(aws secretsmanager get-secret-value \
      --region "$SECRET_REGION" \
      --secret-id "$SECRET_ID" \
      --query SecretString --output text)
  elif command -v python3 >/dev/null 2>&1; then
    secret_json=$(python3 - "$SECRET_ID" "$SECRET_REGION" <<'PY'
import sys, json, boto3
secret_id, region = sys.argv[1], sys.argv[2]
client = boto3.client("secretsmanager", region_name=region)
print(client.get_secret_value(SecretId=secret_id)["SecretString"])
PY
)
  else
    echo "error: need either the aws CLI or python3+boto3 to fetch the secret" >&2
    exit 1
  fi
  : "${HA_URL:=$(jq -r '.url' <<<"$secret_json")}"
  : "${HA_TOKEN:=$(jq -r '.token' <<<"$secret_json")}"
  unset secret_json
fi

# Probe candidate base URLs, closest/fastest first. A cloud/remote session
# will fail the LAN and internal-DNS probes almost instantly (no route to
# the network) and fall through to the public URL; a local or VPN'd session
# will usually hit the LAN address first.
candidates=("http://192.168.0.10:8123")
[[ -n "${HA_EXTRA_CANDIDATE:-}" ]] && candidates+=("$HA_EXTRA_CANDIDATE")
candidates+=("$HA_URL")

BASE=""
for c in "${candidates[@]}"; do
  if curl -fsS -m 2 -o /dev/null -H "Authorization: Bearer $HA_TOKEN" "$c/api/"; then
    BASE="$c"
    break
  fi
done
[[ -n "$BASE" ]] || { echo "error: no reachable Home Assistant base URL (tried: ${candidates[*]})" >&2; exit 1; }

method="${1:?usage: ha.sh <get|post> <path> [body|jq-filter]}"
path="${2:?path required, e.g. /api/states}"

case "$method" in
  get)
    resp=$(curl -fsS -H "Authorization: Bearer $HA_TOKEN" "${BASE}${path}")
    if [[ -n "${3:-}" ]]; then jq -r "$3" <<<"$resp"; else jq . <<<"$resp"; fi
    ;;
  post)
    body="${3:?json body required for post, e.g. '{\"entity_id\":\"light.living_room\"}'}"
    curl -fsS -X POST \
      -H "Authorization: Bearer $HA_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${BASE}${path}" | jq .
    ;;
  *)
    echo "error: method must be 'get' or 'post'" >&2
    exit 1
    ;;
esac
