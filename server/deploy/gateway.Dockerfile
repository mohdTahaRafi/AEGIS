# architecture.md §13.2 (T-2.43/T-2.44) — the gateway image, shared by both compose files
# (live and replay). Builds from the repo root so it can COPY packages/protocol/schema/ alongside
# the gateway's own source (see model_client/vllm.py's doc comment: the action-plan schema is
# loaded from a fixed path this Dockerfile controls, not guessed from relative directory depth).

FROM python:3.12-slim AS base

WORKDIR /app

COPY server/gateway/pyproject.toml /app/server/gateway/pyproject.toml
COPY server/gateway/src /app/server/gateway/src
COPY packages/protocol/schema/action-plan.schema.json /app/protocol-schema/action-plan.schema.json
# common.schema.json must live alongside it: model_client/vllm.py's load_action_plan_schema()
# inlines action-plan.schema.json's external `common.schema.json#/$defs/...` refs before sending
# the schema to vLLM (a real bug fix, 2026-09-25 — vLLM has no way to resolve a $ref into a file
# it was never sent, so those fields were silently unconstrained during structured decoding).
COPY packages/protocol/schema/common.schema.json /app/protocol-schema/common.schema.json

RUN pip install --no-cache-dir /app/server/gateway

ENV AEGIS_ACTION_PLAN_SCHEMA_PATH=/app/protocol-schema/action-plan.schema.json
ENV PYTHONUNBUFFERED=1

EXPOSE 8787

CMD ["uvicorn", "aegis_gateway.main:app", "--host", "0.0.0.0", "--port", "8787"]
