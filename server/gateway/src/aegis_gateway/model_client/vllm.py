"""design.md §8.3/§12.1 (T-2.36) — an OpenAI-compatible async client to vLLM, with the action
schema passed as `response_format` for grammar-constrained structured decoding: a hallucinated
action becomes impossible to produce, not merely rejected after the fact (phase_2_spine.md §6.4's
AC: "A forced adversarial prompt cannot produce an out-of-schema action").

The schema is loaded from `packages/protocol/schema/action-plan.schema.json` directly —
`packages/protocol` is the project's single source of truth for anything crossing the network
(CLAUDE.md rule 6), and re-deriving an equivalent schema from the generated Pydantic model here
would risk drifting from it. `AEGIS_ACTION_PLAN_SCHEMA_PATH` overrides the search entirely — set by
`server/deploy/gateway.Dockerfile`, which `COPY`s that one schema file into the image at a fixed
path, rather than relying on relative-parents guessing across install layouts (a repo checkout vs.
an installed package land the file at different depths).
"""

from __future__ import annotations

import copy
import json
import os
from functools import lru_cache
from pathlib import Path

import httpx

from ..config import Settings
from ..errors import model_timeout, model_unavailable, plan_invalid
from .adapters import DEFAULT_ADAPTER, ModelAdapter


def _schema_candidates() -> list[Path]:
    candidates = []
    env_override = os.environ.get("AEGIS_ACTION_PLAN_SCHEMA_PATH")
    if env_override:
        candidates.append(Path(env_override))
    # repo checkout: server/gateway/src/aegis_gateway/model_client/vllm.py -> repo root
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "packages"
        / "protocol"
        / "schema"
        / "action-plan.schema.json"
    )
    return candidates


def _inline_common_refs(node: object, common_defs: dict) -> object:
    """`action-plan.schema.json` references shared definitions in a *separate* file
    (`common.schema.json#/$defs/...`) — fine for the JS/Python codegen pipeline (T-1.4/T-1.6),
    which resolves the sibling file itself, but fatal here: this exact dict is sent verbatim as
    vLLM's `response_format.json_schema.schema` for grammar-constrained decoding, and vLLM is
    never given `common.schema.json` — it has no way to resolve a `$ref` into a file it was never
    sent. [Real bug, found 2026-09-25 the first time this code path ever ran against a live model
    — OQ-13 had no GPU to run it against before]: with the ref left unresolved, xgrammar silently
    treats the field as unconstrained rather than erroring, so `stepId`'s `^s-[0-9]+$` pattern (and
    `nodeId`/`placeholderRef`/`box`'s own constraints) were never actually enforced during
    generation — confirmed by reproduction: a real live model produced `step_id: "step_1"`, which
    fails Pydantic's own post-validation *after* generation, exactly the silent-until-measured gap
    this describes. Recursively inlines every `common.schema.json#/$defs/X` reference with a deep
    copy of that def from the already-loaded sibling file, leaving same-document `#/$defs/...`
    refs untouched (vLLM resolves those fine since they're part of the one schema object sent)."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("common.schema.json#/$defs/"):
            def_name = ref.split("/")[-1]
            return _inline_common_refs(copy.deepcopy(common_defs[def_name]), common_defs)
        return {k: _inline_common_refs(v, common_defs) for k, v in node.items()}
    if isinstance(node, list):
        return [_inline_common_refs(item, common_defs) for item in node]
    return node


@lru_cache(maxsize=1)
def load_action_plan_schema() -> dict:
    candidates = _schema_candidates()
    for candidate in candidates:
        if candidate.exists():
            schema = json.loads(candidate.read_text())
            common_path = candidate.parent / "common.schema.json"
            common_defs = json.loads(common_path.read_text())["$defs"]
            return _inline_common_refs(schema, common_defs)
    raise FileNotFoundError(f"action-plan.schema.json not found in any of {candidates}")


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
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "action_plan", "schema": schema, "strict": True},
            },
            **self._adapter.chat_template_kwargs(),
        }
        try:
            async with httpx.AsyncClient(timeout=self._settings.model_timeout_s) as client:
                response = await client.post(
                    f"{self._settings.model_url}/chat/completions", json=payload
                )
        except httpx.TimeoutException as exc:
            raise model_timeout() from exc
        except httpx.HTTPError as exc:
            raise model_unavailable() from exc

        if response.status_code >= 500:
            raise model_unavailable()
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            # Real bug, found live (2026-09-25): a real model call returned truncated/malformed
            # JSON (the response was cut off mid-string, most likely hitting the completion
            # token budget) and this bare `json.loads` let a `JSONDecodeError` bubble all the way
            # up into an unhandled 500 — directly contradicting this method's own docstring
            # ("never a bare exception a route would leak"). `plan_invalid` is the same
            # 422/PLAN_INVALID a schema-validation failure produces — a malformed plan is a
            # malformed plan, whether it fails to parse or fails to validate.
            raise plan_invalid(f"model response was not valid JSON: {exc}") from exc
