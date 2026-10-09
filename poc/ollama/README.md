# Ollama local GPU POC

Run open-weight LLMs on your own video card: **Ollama** (model runtime + API) and
**Open WebUI** (a ChatGPT-style front end), in Docker, with one idempotent command.

```
 browser ──► Open WebUI :3000 ──► Ollama :11434 ──► GPU (VRAM)
 curl / code ───────────────────────┘   (native API + OpenAI-compatible /v1)
```

## TL;DR

| You have | Run |
|---|---|
| Windows + NVIDIA | Docker Desktop (WSL2 engine) → `.\up.ps1` |
| Linux + NVIDIA | Docker + [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) → `./up.sh` |
| Linux + AMD | Docker + amdgpu driver → `./up.sh` (uses the `ollama/ollama:rocm` image) |
| Windows + AMD | Skip Docker. Install [native Ollama](https://ollama.com/download), it supports Radeon directly |
| Mac (Apple Silicon) | Skip Docker (no Metal in containers). Native Ollama uses the GPU |

`up.sh` / `up.ps1`:
1. Detect the GPU and **check that Docker can actually attach it** (fails fast with the fix instead of quietly running on CPU).
2. Pick a model that fits your VRAM (override with `MODEL=` / `-Model`).
3. Write `.env` (records which compose override is active, so plain `docker compose ...` keeps working).
4. Start the stack, pull the model only if it isn't cached, then run a benchmark.
5. Print `ollama ps`. **`PROCESSOR` should say `100% GPU`.** If it says `CPU`, or a split like `40%/60% CPU/GPU`, the model doesn't fit in VRAM, so drop to a smaller one.

Re-running is safe: it re-detects, regenerates `.env`, and skips anything already done.

## Default model by VRAM

| VRAM | Model | Notes |
|---|---|---|
| < 7 GB | `llama3.2:3b` | Fast, fine for basic chat |
| 7–10 GB | `llama3.1:8b` | Solid all-rounder |
| 10–14 GB | `gemma3:12b` | Noticeably smarter |
| 14–22 GB | `qwen2.5:14b` | Strong at code/reasoning |
| 22 GB+ | `qwen2.5:32b` | 3090/4090 territory |

Rule of thumb: a 4-bit quantized model needs about **0.6 GB per billion params**, plus headroom for context.
Browse others at <https://ollama.com/library> and try one with
`docker compose exec ollama ollama pull <name>`.

## Things to try

```bash
# Interactive CLI chat
docker compose exec -it ollama ollama run llama3.1:8b

# Benchmark any model (generate tok/s: GPU ≈ 30–150+, CPU ≈ 2–15)
./bench.sh qwen2.5:14b

# Watch VRAM while it generates (separate terminal)
nvidia-smi -l 1            # NVIDIA
watch -n1 rocm-smi         # AMD

# OpenAI-compatible endpoint: any OpenAI SDK works by swapping base_url
curl http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "llama3.1:8b",
  "messages": [{"role": "user", "content": "Write an ansible task that installs htop"}]
}'
```

## Day-2 ops

| Task | Command |
|---|---|
| Stop (keep models) | `docker compose down` |
| Start again | `docker compose up -d` (or re-run `up.sh`) |
| Logs | `docker compose logs -f ollama` |
| List / remove models | `docker compose exec ollama ollama list` / `... ollama rm <name>` |
| Update images | `docker compose pull && docker compose up -d` |
| Wipe everything incl. models | `docker compose down -v` |
| Pin versions | set `OLLAMA_TAG=` / `OLLAMA_ROCM_TAG=` / `OPEN_WEBUI_TAG=` in your shell or `.env` (defaults track latest) |

## Troubleshooting

- **`Docker can't attach the GPU`** (NVIDIA/Linux): `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
  Windows: Docker Desktop → Settings → General → *Use the WSL 2 based engine*, and update the NVIDIA driver (the Windows driver covers WSL, so don't install a Linux driver inside WSL).
- **`ollama ps` shows CPU on a GPU box:** the model is too big for VRAM, or another app is using it. Check `nvidia-smi`.
- **AMD: `no compatible GPUs`:** consumer cards often need `HSA_OVERRIDE_GFX_VERSION` (commented example in `gpu.amd.yml`).
- **Port in use:** `OLLAMA_PORT=11435 WEBUI_PORT=3001 ./up.sh`.
- **Open WebUI has no login:** on purpose for a localhost POC (`WEBUI_AUTH=False`). Set it to `True` before exposing it anywhere.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Base stack (CPU-safe) |
| `gpu.nvidia.yml` / `gpu.amd.yml` | GPU overrides layered on via `COMPOSE_FILE` |
| `up.sh` / `up.ps1` | Detect → size → start → pull → verify |
| `bench.sh` | Tokens/sec benchmark |
| `.env` | Generated, git-ignored |
