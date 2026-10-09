#!/usr/bin/env bash
# Tiny benchmark: one non-streamed generation, report tokens/sec from Ollama's
# own timing fields. Rough guide: GPU = 30-150+ tok/s, CPU = 2-15 tok/s.
#   ./bench.sh [model] [prompt]
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] && set -a && . ./.env && set +a

MODEL="${1:-${MODEL:-llama3.2:3b}}"
PROMPT="${2:-Explain idempotency to a junior SRE in three sentences.}"
URL="http://localhost:${OLLAMA_PORT:-11434}/api/generate"

body=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"prompt":sys.argv[2],"stream":False}))' "$MODEL" "$PROMPT")

printf '\033[1;36m==>\033[0m Prompt (%s): %s\n\n' "$MODEL" "$PROMPT"
curl -fsS "$URL" -d "$body" | python3 -c '
import json, sys
r = json.load(sys.stdin)
print(r["response"].strip(), "\n")
load = r.get("load_duration", 0) / 1e9
pe   = r.get("prompt_eval_count", 0); pd = r.get("prompt_eval_duration", 1) / 1e9
ec   = r.get("eval_count", 0);        ed = r.get("eval_duration", 1) / 1e9
print(f"  load:     {load:6.2f}s  (first run includes moving weights into VRAM)")
print(f"  prompt:   {pe:4d} tok @ {pe/pd:7.1f} tok/s")
print(f"  generate: {ec:4d} tok @ {ec/ed:7.1f} tok/s   <- the number that matters")
'
