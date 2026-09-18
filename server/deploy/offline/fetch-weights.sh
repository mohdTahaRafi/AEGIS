#!/usr/bin/env bash
# architecture §13.2 / phase_5_measurement.md §7, T-5.11 — pre-downloads the model weights
# docker-compose.offline.yml expects to find on a local volume, so the actual `docker compose up`
# for AC-10's verification run needs no network access at all.
#
# DISCLOSED, NOT SILENTLY ASSUMED: not run in the environment this was written in — no GPU, no
# ~16GB of free disk/bandwidth for the pinned model's weights, and (per OQ-13, still open) no
# final decision on which model this actually needs to be. Written to the real, intended
# interface (the same `AEGIS_MODEL_NAME` `vllm.env` already defines) so it runs unchanged once
# OQ-13 closes and a real GPU host is available.

set -euo pipefail

MODEL_NAME="${AEGIS_MODEL_NAME:-Qwen/Qwen3-VL-8B-Instruct}"
WEIGHTS_DIR="${1:-./weights}"

if ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "fetch-weights.sh: huggingface-cli not found. Install with: pip install huggingface_hub" >&2
  exit 1
fi

mkdir -p "${WEIGHTS_DIR}"
echo "fetch-weights.sh: downloading ${MODEL_NAME} into ${WEIGHTS_DIR} (this needs real network access; offline.env's HF_HUB_OFFLINE=1 must NOT be set for this step itself)"
huggingface-cli download "${MODEL_NAME}" --local-dir "${WEIGHTS_DIR}/${MODEL_NAME}"

echo "fetch-weights.sh: done. Mount ${WEIGHTS_DIR} into the vllm service (docker-compose.offline.yml) as a read-only volume."
