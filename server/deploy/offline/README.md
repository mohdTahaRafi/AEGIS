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

## What IS verified here (2026-09-18)

This build environment has no `docker` CLI, but `podman` (a real, working, largely CLI-compatible
substitute) is installed. Using it, the mechanism this whole README exists to prove was verified
for real, end to end, for the gateway's replay-only topology (`../docker-compose.replay.yml` — no
Caddy, no vLLM, no GPU needed): built `aegis-gateway:offline` from source, saved it to a tarball,
**deleted the local image entirely**, reloaded it purely from the tarball, ran it with
`--network=none` (kernel-level network isolation — stronger than a physically pulled cable, and
confirmed real: a `pip install` attempted inside the running container failed for lack of network),
and drove a genuine session-create → step → replay-hit HTTP flow through it, matching a real
pre-seeded entry exactly. `generate-internal-cert.sh` has also actually been run and its output
checked (a real `openssl x509` certificate, correct CN and validity window). Full details:
`docs/HISTORY.md`'s 2026-09-18 T-5.13 entry.

## What is NOT verified here

The full live topology this file's main steps describe (Caddy + gateway + vLLM, `AEGIS_MODE=live`)
remains unrun: it needs a multi-GB `vllm/vllm-openai` pull and 15GB+ of real pre-downloaded model
weights, and there is still no GPU in this environment for vLLM to serve real inference on even if
both downloaded successfully — a successful pull would prove only that the process launches, not a
working demo stack. The compose file's YAML is validated as parseable and structurally consistent
with the two existing compose files. Also unverified: physically disconnecting a network cable
(`--network=none` is the substitute used above, not literally the same thing AC-10's wording
describes, though it is a stronger isolation guarantee in practice). See `docs/DECISIONS.md`
(OQ-13) and `docs/HISTORY.md`'s Phase 5 entries.
