"""design.md §8.3/§12.1 (T-2.36) — an OpenAI-compatible async client to vLLM, with the action
schema passed as `response_format` for grammar-constrained structured decoding: a hallucinated
action becomes impossible to produce, not merely rejected after the fact (phase_2_spine.md §6.4's
AC: "A forced adversarial prompt cannot produce an out-of-schema action").

The schema is loaded from `packages/protocol/schema/action-plan.schema.json` directly —
`packages/protocol` is the project's single source of truth for anything crossing the network
(CLAUDE.md rule 6), and re-deriving an equivalent schema from the generated Pydantic model here
would risk drifting from it. `server/deploy/gateway.Dockerfile` copies that schema file alongside
the gateway's own source so this still works in the built image.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import httpx

from ..config import Settings
from ..errors import model_timeout, model_unavailable
from .adapters import DEFAULT_ADAPTER, ModelAdapter

_SCHEMA_CANDIDATES = [
    # repo checkout: server/gateway/src/aegis_gateway/model_client/vllm.py -> repo root
    Path(__file__).resolve().parents[5] / "packages" / "protocol" / "schema" / "action-plan.schema.json",
    # built image layout (server/deploy/gateway.Dockerfile copies it next to the source)
    Path(__file__).resolve().parents[2] / "protocol_schema" / "action-plan.schema.json",
]


@lru_cache(maxsize=1)
def load_action_plan_schema() -> dict:
    for candidate in _SCHEMA_CANDIDATES:
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise FileNotFoundError(f"action-plan.schema.json not found in any of {_SCHEMA_CANDIDATES}")


class VLLMClient:
    def __init__(self, settings: Settings, adapter: ModelAdapter = DEFAULT_ADAPTER) -> None:
        self._settings = settings
        self._adapter = adapter

    async def complete(self, messages: list[dict[str, str]]) -> dict:
        """Returns the parsed JSON plan the model produced. Raises a `GatewayError` (503/504) on
        any failure to reach the model or on timeout — never a bare exception a route would leak."""
        schema = load_action_plan_schema()
        payload = {
            "model": self._settings.model_name,
            "messages": messages,
            "response_format": {"type": "json_schema", "json_schema": {"name": "action_plan", "schema": schema, "strict": True}},
            **self._adapter.chat_template_kwargs(),
        }
        try:
            async with httpx.AsyncClient(timeout=self._settings.model_timeout_s) as client:
                response = await client.post(f"{self._settings.model_url}/chat/completions", json=payload)
        except httpx.TimeoutException as exc:
            raise model_timeout() from exc
        except httpx.HTTPError as exc:
            raise model_unavailable() from exc

        if response.status_code >= 500:
            raise model_unavailable()
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        return json.loads(content)
