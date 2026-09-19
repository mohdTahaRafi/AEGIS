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
- `AEGIS_MODE` — `replay` (offline) or `inference` (live model)
- `AEGIS_RECORD_DIR` — directory with pre-recorded `.json` files
- `AEGIS_TOKEN` — bearer token for auth
- `AEGIS_GATEWAY_PORT` — default 8000

## 3. Live (Production)

Requires vLLM + GPU + model weights (~15 GB). This is the full topology.

### Prerequisites
- NVIDIA GPU with ≥24GB VRAM (H100, A100, or better)
- vLLM Docker image pulled: `vllm/vllm-openai:latest`
- Model weights for an open-weights model (e.g., Llama 2 70B)

### Setup

```bash
cd server

# Build gateway image
podman build -f deploy/gateway.Dockerfile -t aegis-gateway:latest .

# Start Caddy (reverse proxy)
podman run -d \
  --name caddy \
  -p 443:443 \
  -p 80:80 \
  -v $(pwd)/deploy/Caddyfile:/etc/caddy/Caddyfile \
  caddy:latest

# Start vLLM
podman run -d \
  --name vllm \
  --gpus all \
  -e VLLM_API_KEY=vllm-secret-key \
  -p 8001:8000 \
  vllm/vllm-openai:latest \
  --model meta-llama/Llama-2-70b-chat-hf \
  --dtype float16 \
  --max-model-len 2048

# Start gateway
podman run -d \
  --name gateway \
  -e AEGIS_MODE=inference \
  -e AEGIS_MODEL_URL=http://vllm:8000 \
  -e AEGIS_MODEL_API_KEY=vllm-secret-key \
  -e AEGIS_TOKEN=$(openssl rand -hex 32) \
  -e AEGIS_GATEWAY_PORT=8000 \
  -p 8000:8000 \
  aegis-gateway:latest

# Verify all running
podman ps
curl http://127.0.0.1:8000/healthz
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
