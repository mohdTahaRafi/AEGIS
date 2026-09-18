#!/usr/bin/env bash
# architecture §13.2 / phase_5_measurement.md §7, T-5.11 — a self-signed internal certificate for
# Caddy's TLS termination in the fully offline deployment, where Caddy's normal automatic-HTTPS
# path (which needs a real ACME CA over the internet) is unavailable by definition. Genuinely run
# and verified in this environment (`openssl` is installed here, unlike `docker`) — see
# docs/HISTORY.md's Phase 5 entry.

set -euo pipefail

OUT_DIR="${1:-./internal-cert}"
COMMON_NAME="${2:-aegis.internal}"
DAYS="${3:-825}"

mkdir -p "${OUT_DIR}"

openssl req -x509 -newkey rsa:4096 -sha256 -days "${DAYS}" -nodes \
  -keyout "${OUT_DIR}/internal.key" \
  -out "${OUT_DIR}/internal.crt" \
  -subj "/CN=${COMMON_NAME}" \
  -addext "subjectAltName=DNS:${COMMON_NAME}"

chmod 600 "${OUT_DIR}/internal.key"

echo "generate-internal-cert.sh: wrote ${OUT_DIR}/internal.{key,crt} for CN=${COMMON_NAME}, valid ${DAYS} days"
echo "Point Caddyfile's tls directive at these two files instead of automatic HTTPS for the offline deployment."
