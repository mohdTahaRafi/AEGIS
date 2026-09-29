#!/usr/bin/env bash
# Starts the AEGIS gateway against the live VLM (Groq, OpenAI-compatible).
# The API key comes from the environment only: AEGIS_MODEL_API_KEY, else server/deploy/model.env,
# else GROQ_API_KEY in the repo's gitignored .env. It is never printed.
#   server/deploy/run-gateway.sh            # live, http://127.0.0.1:8787
#   AEGIS_PORT=9000 server/deploy/run-gateway.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# model.env fills in only what the caller's environment has not already set.
if [ -f "$ROOT/server/deploy/model.env" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -n "${!key+x}" ] && continue
    value="${value%%#*}"
    value="${value%"${value##*[![:space:]]}"}"
    export "$key=$value"
  done < "$ROOT/server/deploy/model.env"
fi
if [ -z "${AEGIS_MODEL_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  AEGIS_MODEL_API_KEY="$(sed -n 's/^GROQ_API_KEY=//p' "$ROOT/.env" | head -n1 | tr -d "\"' \r")"
  export AEGIS_MODEL_API_KEY
fi
if [ -z "${AEGIS_MODEL_API_KEY:-}" ]; then
  echo "AEGIS_MODEL_API_KEY is not set (nor GROQ_API_KEY in $ROOT/.env)" >&2
  exit 1
fi

export AEGIS_MODE="${AEGIS_MODE:-live}"
export AEGIS_MODEL_URL="${AEGIS_MODEL_URL:-https://api.groq.com/openai/v1}"
export AEGIS_MODEL_NAME="${AEGIS_MODEL_NAME:-qwen/qwen3.8-27b}"
export AEGIS_MODEL_RESPONSE_FORMAT="${AEGIS_MODEL_RESPONSE_FORMAT:-json_object}"
export AEGIS_MODEL_CHAT_TEMPLATE_KWARGS="${AEGIS_MODEL_CHAT_TEMPLATE_KWARGS:-false}"
export AEGIS_MODEL_TIMEOUT_S="${AEGIS_MODEL_TIMEOUT_S:-45}"
# Qwen on Groq: thinking off (hidden reasoning tokens count against the daily quota), a completion
# budget with room for a typed reply (the unused part is refunded to the budget), and the measured
# click_point convention.
export AEGIS_MODEL_REASONING_EFFORT="${AEGIS_MODEL_REASONING_EFFORT:-none}"
export AEGIS_MODEL_MAX_TOKENS="${AEGIS_MODEL_MAX_TOKENS:-900}"
# Deterministic sampling: at Groq's default the model often opened a "report" answer in prose,
# which JSON mode rejects (400 json_validate_failed).
export AEGIS_MODEL_TEMPERATURE="${AEGIS_MODEL_TEMPERATURE:-0}"
export AEGIS_MODEL_POINT_FORMAT="${AEGIS_MODEL_POINT_FORMAT:-rel1000_long_side}"
# Groq's 7K input tokens/minute and ~6.7K-token steps: the next call within a minute (the next
# step, or the corrective retry right after a rejected plan) gets a 429 asking to wait 10-60 s.
# Waiting here keeps that retry alive (the extension allows 150 s per step: two waits + calls).
export AEGIS_MODEL_RETRY_MAX_WAIT_S="${AEGIS_MODEL_RETRY_MAX_WAIT_S:-60}"
# Every step goes to a VISION model with its screenshot. Groq serves one (qwen/qwen3.8-27b), so
# there is no fallback by default; AEGIS_MODEL_FALLBACKS may list other vision models only. The
# gateway waits for the model's per-minute budget (a screenshot costs ~3.6K of Groq's 8K/min)
# rather than sending into a 429, up to AEGIS_MODEL_BUDGET_MAX_WAIT_S.
export AEGIS_MODEL_FALLBACKS="${AEGIS_MODEL_FALLBACKS-}"
export AEGIS_MODEL_IMAGE_BUDGET_TOKENS="${AEGIS_MODEL_IMAGE_BUDGET_TOKENS:-3600}"
export AEGIS_MODEL_BUDGET_MAX_WAIT_S="${AEGIS_MODEL_BUDGET_MAX_WAIT_S:-60}"
export AEGIS_TOKEN="${AEGIS_TOKEN:-dev-token}"

cd "$ROOT/server/gateway"
exec .venv/bin/uvicorn aegis_gateway.main:app --host 127.0.0.1 --port "${AEGIS_PORT:-8787}"
