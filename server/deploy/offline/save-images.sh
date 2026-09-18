#!/usr/bin/env bash
# architecture §13.2 / phase_5_measurement.md §7, T-5.11 — `docker save`s every image
# docker-compose.offline.yml needs, so the images themselves need no registry pull at deploy time
# either (AC-10 is "verified with the machine's network physically disconnected," which rules out
# `docker compose pull` too, not just the model weights).
#
# DISCLOSED, NOT SILENTLY ASSUMED: not run in the environment this was written in — no `docker`
# CLI is installed here (established already in Phase 2's HISTORY entry for docker-compose.yml).
# Written to the real, intended interface; the image list mirrors docker-compose.yml/
# docker-compose.replay.yml exactly, so it stays correct as those files change only if this one is
# updated alongside them (a lint for that drift is future work, not built here).

set -euo pipefail

OUT_DIR="${1:-./images}"
mkdir -p "${OUT_DIR}"

IMAGES=(
  "caddy:2-alpine"
  "vllm/vllm-openai:latest"
  # The gateway image is built locally (server/deploy/gateway.Dockerfile), not pulled — built and
  # tagged before this script runs, per docker-compose.offline.yml's `image:` reference below.
  "aegis-gateway:offline"
)

for image in "${IMAGES[@]}"; do
  safe_name="$(echo "${image}" | tr '/:' '__')"
  echo "save-images.sh: saving ${image} -> ${OUT_DIR}/${safe_name}.tar"
  docker save "${image}" -o "${OUT_DIR}/${safe_name}.tar"
done

echo "save-images.sh: done. On the offline machine, run: for f in ${OUT_DIR}/*.tar; do docker load -i \"\$f\"; done"
