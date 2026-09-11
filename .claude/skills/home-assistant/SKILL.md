---
name: home-assistant
description: Interact with Riley's self-hosted Home Assistant instance (ha.schuit.io) via its REST API — check or change device/entity state (lights, switches, sensors, climate, locks, etc.), call services like light.turn_on, pull history/logbook/error logs, or answer "what's the state of X" / "turn on/off Y" / "is the garage door open" style questions. Use this whenever Home Assistant, HA, smart home devices/entities, or specific entity IDs (e.g. light.*, switch.*, sensor.*, binary_sensor.*) come up, even if the user doesn't say "Home Assistant" by name — e.g. "turn off the living room lights" or "what's the temp sensor reading in the garage." Credentials live in AWS Secrets Manager, never hardcoded — this skill covers fetching them and picking a reachable base URL.
---

# Home Assistant

Talks to Riley's Home Assistant over its REST API. Credentials are never
hardcoded — they live in AWS Secrets Manager and get fetched at call time.

## Quick start

Use the bundled helper — it fetches the secret, finds a reachable base URL,
and wraps the auth headers so you don't have to re-derive any of this:

```bash
.claude/skills/home-assistant/scripts/ha.sh get /api/states
.claude/skills/home-assistant/scripts/ha.sh get /api/states/light.living_room
.claude/skills/home-assistant/scripts/ha.sh post /api/services/light/turn_on '{"entity_id":"light.living_room"}'
```

Requires `curl` and `jq`, plus either the `aws` CLI or `python3` with
`boto3` installed, for the secret lookup. If none of those are available,
fall back to the manual steps below.

## Where the credentials live

Secrets Manager, **us-west-2**, secret id `home-assistant/api`:

```json
{ "url": "https://ha.schuit.io", "token": "<long-lived access token>" }
```

Manual fetch if you're not using `ha.sh`:

```bash
aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id home-assistant/api --query SecretString --output text
```

Then call the API with `Authorization: Bearer <token>` and
`Content-Type: application/json`. **Never print, log, or echo the token** —
pipe it straight into the `Authorization` header.

The IAM identity calling this needs only `secretsmanager:GetSecretValue`
scoped to that one secret's ARN — nothing else:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-west-2:<account-id>:secret:home-assistant/api-*"
}
```

## Reachability — this matters

HA is exposed three ways, and **which ones work depends on where this
session is running**:

| Base URL | Reachable from |
|---|---|
| `http://192.168.0.10:8123` | Local network only, or a session on Tailscale/VPN into the home network |
| internal k8s DNS (e.g. `home-assistant.<namespace>.svc.cluster.local`) | Only from inside that k8s cluster |
| `https://ha.schuit.io` | Anywhere with internet access, including cloud/remote Claude Code sessions |

`ha.sh` tries the LAN address first and falls through to the public URL, so
it works unmodified in both environments — on a cloud/remote session the
LAN probe just fails fast (no route to that network) and it uses the public
URL instead. If you're running inside the k8s cluster and know the internal
DNS name, pass it via `HA_EXTRA_CANDIDATE` to try it before the public URL.

## Core endpoints

All paths are relative to the resolved base URL.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/` | Health check — 200 means the API is up and the token is valid |
| GET | `/api/config` | Instance config (location, unit system, components loaded) |
| GET | `/api/states` | Every entity's current state — this is the big one for "what's on/off/reading X" |
| GET | `/api/states/<entity_id>` | One entity's current state, e.g. `light.living_room` |
| POST | `/api/states/<entity_id>` | Force-set an entity's state directly (rare — prefer calling a service below) |
| GET | `/api/services` | Every domain/service pair available to call |
| POST | `/api/services/<domain>/<service>` | **Call a service** — this is how you actually change something. Body is JSON with at least `entity_id`, e.g. `{"entity_id":"light.living_room","brightness":180}` for `light/turn_on` |
| GET | `/api/history/period/<timestamp>?filter_entity_id=<entity_id>` | State history since `<timestamp>` (ISO 8601) for one or more entities |
| GET | `/api/logbook/<timestamp>` | Human-readable logbook entries since `<timestamp>` |
| GET | `/api/events` | Event types HA can fire, with listener counts |
| POST | `/api/events/<event_type>` | Fire a custom event |
| GET | `/api/error_log` | Full HA error log as plain text — useful when something's misbehaving |
| GET | `/api/camera_proxy/<entity_id>` | Current camera image (binary JPEG) |

Full reference (attributes, filters, less-common params) is at
https://developers.home-assistant.io/docs/api/rest/ — check there before
guessing at a field name.

## Common recipes

**"What's on/off right now" for a domain:**
```bash
ha.sh get /api/states '[.[] | select(.entity_id | startswith("light.")) | {entity_id, state}]'
```

**Turn something on/off:**
```bash
ha.sh post /api/services/light/turn_off '{"entity_id":"light.living_room"}'
ha.sh post /api/services/switch/turn_on  '{"entity_id":"switch.garage_door_opener"}'
```
Domain (`light`, `switch`, `lock`, `climate`, `media_player`, …) and the
exact service name come from the entity's `entity_id` prefix and
`/api/services` — don't assume `turn_on`/`turn_off` exists for every
domain (locks use `lock`/`unlock`, covers use `open_cover`/`close_cover`).

**Read one sensor:**
```bash
ha.sh get /api/states/sensor.garage_temperature '.state'
```

**Recent history for troubleshooting:**
```bash
ha.sh get "/api/history/period/$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)?filter_entity_id=binary_sensor.garage_door"
```

## Notes

- Prefer calling a **service** (`/api/services/...`) over POSTing to
  `/api/states/...` directly — the latter only overwrites HA's internal
  state record and doesn't actually command the device.
- Entity IDs are always `domain.object_id` (lowercase, underscores). If
  unsure of the exact id, `GET /api/states` and filter/grep rather than
  guessing.
- Don't commit the secret value, a fetched token, or `ha.sh` output
  containing a token anywhere in this repo.
