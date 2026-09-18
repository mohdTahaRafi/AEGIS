# Offline deployment (AC-10, T-5.11)

FR-46 / NFR-13: the same stack `../docker-compose.yml` describes, running fully air-gapped.

## Steps (on a machine WITH network access, before disconnecting)

1. `docker build -f ../gateway.Dockerfile -t aegis-gateway:offline ../../..`
2. `docker pull caddy:2-alpine && docker pull vllm/vllm-openai:latest`
3. `./save-images.sh ./images` — saves all three images to `.tar` files
4. `./fetch-weights.sh ./weights` — pre-downloads the model weights named in `AEGIS_MODEL_NAME`
5. `./generate-internal-cert.sh ./internal-cert aegis.internal` — self-signed cert for Caddy's TLS
   (verified working in this repo's build environment — see `docs/HISTORY.md`'s Phase 5 entry)
6. Copy `images/`, `weights/`, `internal-cert/` and this directory onto the offline machine.

## Steps (on the offline machine, network disconnected — AC-10)

1. `for f in images/*.tar; do docker load -i "$f"; done`
2. `docker compose -f docker-compose.offline.yml up`

`offline.env` sets `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1` so any accidental network attempt
inside the containers fails loudly (a missing local file) rather than silently succeeding if the
machine actually still had connectivity.

## What is NOT verified here

This project's build environment has no `docker` CLI at all (the same gap `../docker-compose.yml`
has carried since Phase 2) and no way to physically disconnect a network cable from a sandboxed
session. `generate-internal-cert.sh` is the one script in this directory that has actually been
run and its output checked (a real `openssl x509` certificate, correct CN and validity window).
The compose file's YAML is validated as parseable and structurally consistent with the two
existing compose files; `docker compose up` itself, and everything GPU/vLLM-specific, is
unverified — see `docs/DECISIONS.md` (OQ-13) and `docs/HISTORY.md`'s Phase 5 entry.
