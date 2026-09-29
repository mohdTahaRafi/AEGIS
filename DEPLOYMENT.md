# Deployment Guide

## Deployment Topologies

AEGIS supports three deployment modes:

| Mode | Use Case | GPU Required | Internet Required |
|---|---|---|---|
| **Live** | Production with real model inference | Yes (vLLM) | Needed for model pull |
| **Offline replay** | Demo/testing, no model server | No | No |
| **Development** | Local testing with hot-reload | Optional | Optional |

## 1. Development (Local)

```bash
# Extension
cd apps/extension
pnpm dev
# Open chrome://extensions > Load unpacked > .output/chrome-mv3-dev

# Gateway
cd server/gateway
uv sync
uv run uvicorn aegis_gateway.main:app --reload --port 8000

# Test connection
curl http://127.0.0.1:8000/healthz
```

## 2. Offline Replay (Demo/No GPU)

For conferences, demos, or CI without GPU access.

```bash
cd server

# Build gateway image
podman build -f deploy/gateway.Dockerfile -t aegis-gateway:offline .

# Record some steps first (or use pre-recorded)
RECORD_DIR=$(mktemp -d)
export AEGIS_MODE=record
export AEGIS_RECORD_DIR=$RECORD_DIR
# ... run through one task to create recordings ...

# Now run in replay mode
podman run \
  -e AEGIS_MODE=replay \
  -e AEGIS_RECORD_DIR=/app/recorded \
  -e AEGIS_TOKEN=demo-token \
  -v $RECORD_DIR:/app/recorded \
  -p 8000:8000 \
  aegis-gateway:offline

# Test
curl -H "Authorization: Bearer demo-token" http://127.0.0.1:8000/healthz
```

**Environment variables:**
- `AEGIS_MODE` — `replay` (offline), `live` (model), or `record` (live, and save responses for replay)
- `AEGIS_RECORD_DIR` — directory with pre-recorded `.json` files
- `AEGIS_TOKEN` — bearer token for auth
- `AEGIS_GATEWAY_PORT` — default 8000

## 3. Live (Production)

The server model is an open-weights Qwen VLM on **Groq's free tier** (R-1 decision, see
[docs/planning/bugs/R-1-vlm-endpoint.md](../docs/planning/bugs/R-1-vlm-endpoint.md)). Groq
exposes an OpenAI-compatible `/chat/completions`, so the gateway only changes its URL, model name
and key. No paid API, no GPU.

| | Endpoint | Model id | Status |
|---|---|---|---|
| **A. Groq free tier (demo + dev)** | `https://api.groq.com/openai/v1` | `qwen/qwen3.8-27b` | Gateway → Groq works (live check 2026-09-28, image step passed 2/3, third was rate-limited). **Preview** model. Reports in `tools/vlm/reports/r1-2026-09-28-groq*.json` |
| **Offline fallback** | Gateway `AEGIS_MODE=replay` (section 2) | — | Recorded from option A in R-6. Use it whenever Groq throttles |
| B. Self-hosted vLLM | `http://<gpu-host>:8000/v1` | `Qwen/Qwen3-VL-8B-Instruct` | Not used: needs a GPU, outside the free-tier constraint. Kept for reference |
| ~~OpenRouter free~~ | ~~`https://openrouter.ai/api/v1`~~ | ~~`qwen/qwen3.8-27b:free`~~ | Ruled out 2026-09-28: 1/30 calls succeeded (shared-pool 429s) |
| ~~Hugging Face → Featherless~~ | ~~`router.huggingface.co/v1`~~ | ~~`Qwen/Qwen3-VL-8B-Instruct:featherless-ai`~~ | Superseded 2026-09-28: free credits ran out. Kept in `tools/vlm/reports/r1-2026-09-28-hf-featherless.json` |

`qwen/qwen3.8-27b` is the only image-input model Groq serves (checked against
`GET /openai/v1/models` and console.groq.com/docs/vision on 2026-09-28).

### A. Groq free tier

1. **Key.** Create one at console.groq.com → API Keys (free tier, no billing). Put it in
   `server/deploy/model.env`, which is gitignored; never commit it or paste it anywhere else. If a
   key is ever exposed, delete it in the console, create a new one and replace it in the file.
   ```bash
   cp server/deploy/model.env.example server/deploy/model.env
   chmod 600 server/deploy/model.env        # then set AEGIS_MODEL_API_KEY=gsk_...
   ```
2. **Gateway.** The settings in `model.env.example` are the ones Groq needs: bearer key,
   image content part, `json_object` output, no `chat_template_kwargs`, one bounded retry.
   ```bash
   cd server/gateway
   set -a; . ../deploy/model.env; set +a
   AEGIS_TOKEN=$(openssl rand -hex 32) .venv/bin/uvicorn aegis_gateway.main:app --port 8787
   ```
3. **Checks.** Everything sent is synthetic. Each call spends from the shared daily budget
   (below), so run them before a demo, not on a loop:
   ```bash
   python3 tools/vlm/smoke.py --runs 10 --json-out tools/vlm/reports/r1-$(date +%F)-groq.json
   AEGIS_TOKEN=<same token> python3 server/gateway/scripts/r2_live_check.py --runs 3
   AEGIS_TOKEN=<same token> python3 server/gateway/scripts/r3_live_check.py --runs 10
   ```

**Gateway variables** (all optional; defaults in `server/gateway/src/aegis_gateway/config.py`):
`AEGIS_MODEL_API_KEY` (never logged; kept out of `repr`), `AEGIS_MODEL_VISION` (`true`; `false` is
refused at startup: every step's redacted screenshot goes to the vision model),
`AEGIS_MODEL_MAX_TOKENS` (`512`), `AEGIS_MODEL_RESPONSE_FORMAT` (`json_object`),
`AEGIS_MODEL_CHAT_TEMPLATE_KWARGS` (`false`), `AEGIS_MODEL_MAX_RETRIES` (`1`),
`AEGIS_MODEL_RETRY_MAX_WAIT_S` (`10`).

**How failures look.** An upstream failure is a `503 MODEL_UNAVAILABLE` whose message names the
reason: `upstream_429`, `upstream_4xx`, `upstream_5xx`, `unreachable` or `bad_body`. For
`upstream_429` it also carries Groq's `Retry-After`, and the side panel shows e.g.
`SERVER_ERROR: MODEL_UNAVAILABLE upstream_429 retry in 204 s`. A timeout is `504 MODEL_TIMEOUT`.
The gateway retries once only when Groq's `retry-after` is ≤ 10 s, or when the connection dropped;
never after a timeout, and never on a longer wait. The logs (one JSON line per event:
`model_call`, `model_retry`, `model_error`, `step_processed`) carry no body and no key.

**Free-tier limits** (docs, and the `x-ratelimit-*` headers): 30 RPM, 1,000 RPD, 8,000 TPM, and
**200,000 tokens per day, per organization** (every key in the org shares it, and the window
rolls). A step with an image is ~2.4 k prompt tokens, so the whole team gets **~80 image steps a
day**, and every measurement run spends from the same pool. On 2026-09-28 the R-1 probe runs used
it all up: the live gateway checks then got `tokens per day (TPD): Limit 200000, Used 199490`
with `Retry-After` of several minutes. Per minute, about 3 image steps fit.

**Measured 2026-09-28** (client: a laptop on Wi-Fi, end to end, network included; full numbers in
[R-1](../docs/planning/bugs/R-1-vlm-endpoint.md)):
- **Latency** (n=10, smoke probe): total p50 1.60 s / p95 17.47 s per successful call.
- **Vision:** WebP (what the extension sends) 11/14 exact code-word reads; PNG 6/6.
- **Grounding:** landscape 1280×720, 24/24 points inside the target (5 distinct targets) in 0–1000
  **of the longer side**; portrait 720×1280, **0/4 under every convention**. Don't rely on `click_point` for
  portrait viewports (R-12).
- **Structured output:** `json_object` works; `strict: true` json_schema is rejected.

**Before a demo:** check `GET /openai/v1/models` still lists the model (Preview models "may be
discontinued without notice"), and that the day's budget isn't spent. If Groq is down or
throttling, switch to `AEGIS_MODE=replay` (section 2).

**Privacy.** Only the guarded payload leaves the device, as with any server: the extension
sanitizes and composes the image before egress, and the gateway only relays it. Groq receives the
same sanitized JSON and WebP a self-hosted vLLM would. By default Groq does not retain inference
data, except temporary logging (up to 30 days) when troubleshooting errors or investigating
abuse. **To remove that exception, enable Zero Data Retention:** in the console.groq.com
settings, open **Data Controls** → turn on Zero Data Retention (it also disables
batch and fine-tuning). Whether it is on for the team account has **not** been verified; check it
there and note the date here once it is.

### B. Self-hosted vLLM (reference only)

Not part of the R-1 decision. Requires an NVIDIA GPU with ≥ 24 GB VRAM and the `vllm/vllm-openai` image.

```bash
cd server
podman build -f deploy/gateway.Dockerfile -t aegis-gateway:latest .

podman run -d --name vllm --gpus all -p 8001:8000 \
  -e VLLM_API_KEY=vllm-secret-key \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen3-VL-8B-Instruct \
  --max-model-len 16384 \
  --limit-mm-per-prompt '{"image":1}'

podman run -d --name gateway -p 8000:8000 \
  -e AEGIS_MODE=live \
  -e AEGIS_MODEL_URL=http://vllm:8000/v1 \
  -e AEGIS_MODEL_NAME=Qwen/Qwen3-VL-8B-Instruct \
  -e AEGIS_TOKEN=$(openssl rand -hex 32) \
  aegis-gateway:latest

curl http://127.0.0.1:8000/healthz
python3 ../tools/vlm/smoke.py --base-url http://127.0.0.1:8001/v1 --model Qwen/Qwen3-VL-8B-Instruct
```

### Docker Compose (Full Stack)

Instead of running individual containers:

```bash
cd server
podman-compose -f deploy/docker-compose.yml up -d
```

This starts all three (gateway + vLLM + Caddy) together, with shared networking.

**Check logs:**
```bash
podman-compose -f deploy/docker-compose.yml logs -f gateway
```

## Extension Deployment

### Chrome (Zip for Distribution)

```bash
cd apps/extension
pnpm build
pnpm zip

# Creates:
# - .output/chrome-mv3.zip (unpacked, for submission)
# - .output/chrome-mv3.zip (signed, if you have signing key)
```

Upload `.output/chrome-mv3.zip` to Chrome Web Store.

### Firefox (Zip for Distribution)

```bash
cd apps/extension
pnpm build:firefox
pnpm zip:firefox

# Creates:
# - .output/firefox-mv3.zip
# - .output/firefox-mv3/sources.zip (source code, required for AMO)
```

Upload to Mozilla Add-ons.

### Enterprise Deployment

For managed deployment to corporate machines:

1. Build both targets: `pnpm build`
2. Host the packed folders on an internal server
3. Use a manifest/GPO to install from your URL (Chrome/Firefox support this)

Example Firefox install manifest:
```json
{
  "install_sources": ["https://yourserver.com/extensions/"],
  "installations": [
    {
      "url": "https://yourserver.com/extensions/aegis-firefox.xpi"
    }
  ]
}
```

## Network Configuration

### Gateway behind Caddy (HTTPS)

The included `deploy/Caddyfile` handles TLS certificates (auto via Let's Encrypt).

```caddy
aegis.example.com {
  reverse_proxy localhost:8000
}
```

This requires:
- Domain name pointing to the server IP
- Port 80/443 accessible from the internet

### Without Caddy (Development)

```bash
# Plain HTTP (insecure, dev only)
uv run uvicorn aegis_gateway.main:app --host 0.0.0.0 --port 8000
```

## Monitoring

### Health Checks

```bash
# Every 30 seconds
curl http://127.0.0.1:8000/healthz

# Kubernetes-style readiness
curl http://127.0.0.1:8000/readyz
```

### Logs

```bash
# View structured logs
podman logs gateway | grep "error"

# Follow in real-time
podman logs -f gateway
```

### Metrics

Metrics are logged via `structured_log.py` with fields:
- `duration_ms` — per-request latency
- `status_code` — HTTP response code
- `model_latency_ms` — time spent in model inference (if applicable)
- `error` — error message if failed

Parse structured logs for monitoring:
```bash
podman logs gateway | jq 'select(.status_code >= 500)'  # errors only
```

## Scaling

### Horizontal

Run multiple gateway instances behind a load balancer:

```bash
# Instance 1
podman run ... -p 8001:8000 aegis-gateway:latest

# Instance 2
podman run ... -p 8002:8000 aegis-gateway:latest

# HAProxy or nginx in front
```

Each gateway shares the same vLLM instance (no per-instance model serving).

### Vertical

Increase vLLM's token budget (max concurrent tokens):

```bash
# More aggressive batching
podman run ... \
  --max-model-len 4096 \  # larger window
  --max-batch-size 256 \   # more sequences at once
  vllm/vllm-openai:latest
```

## Troubleshooting

| Problem | Diagnosis | Fix |
|---|---|---|
| `502 Bad Gateway` | vLLM not responding | Check vLLM container: `podman logs vllm` |
| `503 Service Unavailable` | Readiness probe failing | vLLM is booting or model loading. Wait 5 min. |
| `timeout` | Model inference too slow | Reduce `--max-model-len` or increase GPU VRAM |
| `OOM` (Out of Memory) | Not enough GPU VRAM | Reduce batch size, use a smaller model, or add GPUs |
| `401 Unauthorized` | Bad token | Check `AEGIS_TOKEN` matches extension config |
| Cannot reach gateway | Network issue | Check firewall, port binding, DNS |

## Database (Sessions)

Sessions are stored in-memory (no persistence). On restart, active sessions are lost.

For production:
- Add Redis backend (not currently implemented)
- Or add PostgreSQL (not currently implemented)

This is tracked as a forward dependency after Phase 7.

## Backups & Disaster Recovery

**What needs backup:**
- Recorded steps (if running in replay mode)
  - Store in version control or S3
  - Pre-recorded at demo time

**What doesn't need backup:**
- Sessions (ephemeral, ~1 hr TTL)
- Logs (immutable, can be shipped to log aggregator)
- Model weights (re-download from HuggingFace)

## Updating

### Extension

Push new version to Chrome/Firefox stores:
```bash
# Build & zip
pnpm build && pnpm zip

# Submit to Chrome Web Store / Mozilla Add-ons
# (manual or via their API)
```

Users auto-update within ~24 hours (can force via browser settings).

### Gateway

```bash
# Rebuild image
podman build -f deploy/gateway.Dockerfile -t aegis-gateway:latest .

# Stop old, run new
podman stop gateway
podman rm gateway
podman run -d ... aegis-gateway:latest

# Sessions on the old instance are lost (TTL ≤1 hr anyway)
```

Or use `podman-compose up -d --build` to rebuild all images.

## See Also

- [architecture.md §13.1-13.3](docs/architecture.md) — deployment topology (Section 13.1: Distribution, Section 13.3: Environments)
- [phase_5_measurement.md §9](docs/planning/phase_5_measurement.md) — AC-10 gateway topology verification
- `deploy/docker-compose.yml` — full example
- `deploy/Caddyfile` — reverse proxy config
