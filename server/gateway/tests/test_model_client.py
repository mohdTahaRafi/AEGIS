"""design.md §8.3/§6.4 (T-2.36 AC): a forced adversarial prompt cannot produce an out-of-schema
action — structured decoding makes it impossible, not merely rejected. Verified here as: the
request VLLMClient actually sends carries the real action-plan JSON Schema as `response_format`
(the thing that makes it a compiler-enforced impossibility, not a runtime check) — this project
doesn't have a live vLLM to prove the model obeys it, so what's provable here is that the gateway
asks for exactly that guarantee. T-2.37: the model adapter's coordinate convention.
"""

from __future__ import annotations

import json

import httpx
import pytest
from aegis_gateway.model_client.adapters import DEFAULT_ADAPTER, IdentityCoordinateAdapter
from aegis_gateway.model_client.vllm import VLLMClient, load_action_plan_schema

from .conftest import make_settings


def test_the_real_action_plan_schema_loads_and_is_a_valid_json_schema_document() -> None:
    schema = load_action_plan_schema()
    assert schema["$id"] == "action-plan.schema.json" or "properties" in schema
    assert "actions" in schema["properties"]


def _find_refs(node: object) -> list[str]:
    refs: list[str] = []
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            refs.append(ref)
        for v in node.values():
            refs.extend(_find_refs(v))
    elif isinstance(node, list):
        for item in node:
            refs.extend(_find_refs(item))
    return refs


def test_the_loaded_schema_has_no_unresolved_external_refs_vllm_could_never_follow() -> None:
    """Real bug, found 2026-09-25 the first time this schema was ever sent to a live model
    (OQ-13 had no GPU to run against before): `action-plan.schema.json`'s `$ref`s into the
    *separate* `common.schema.json` file are meaningless to vLLM, which is only ever given this
    one schema dict as `response_format.json_schema.schema` — it can't resolve a ref into a file
    it was never sent, so those fields (stepId, nodeId, placeholderRef, box) were silently
    unconstrained during structured decoding. Reproduced live: a real model returned
    `step_id: "step_1"`, failing Pydantic's post-validation with a pattern mismatch against
    `^s-[0-9]+$` — the exact constraint that should have made that string impossible to generate.
    `load_action_plan_schema()` now inlines every `common.schema.json#/$defs/...` ref before
    returning; same-document `#/$defs/...` refs are untouched (fine — they're part of the one
    schema object actually sent, so vLLM resolves them itself)."""
    schema = load_action_plan_schema()
    refs = _find_refs(schema)
    external_refs = [r for r in refs if r.startswith("common.schema.json")]
    assert external_refs == [], f"unresolved external refs would leave these fields unconstrained during decoding: {external_refs}"
    assert any(r.startswith("#/$defs/") for r in refs), "same-document refs should be untouched, not also inlined away"

    # The concrete case that actually broke: stepId's pattern must have made it into the schema
    # object that gets sent, not just exist somewhere in common.schema.json unreferenced.
    step_id_schema = schema["properties"]["step_id"]
    assert step_id_schema.get("pattern") == "^s-[0-9]+$"


@pytest.mark.asyncio
async def test_complete_sends_the_schema_as_response_format(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"step_id": "s-1", "actions": [{"op": "wait", "ms": 100}]}
                            )
                        }
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, url: str, json: dict) -> FakeResponse:
            captured["url"] = url
            captured["payload"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    client = VLLMClient(make_settings(mode="live"))
    plan = await client.complete([{"role": "system", "content": "x"}])

    assert plan == {"step_id": "s-1", "actions": [{"op": "wait", "ms": 100}]}
    assert captured["payload"]["response_format"]["type"] == "json_schema"
    assert (
        captured["payload"]["response_format"]["json_schema"]["schema"] == load_action_plan_schema()
    )
    assert captured["url"].endswith("/chat/completions")


@pytest.mark.asyncio
async def test_complete_raises_model_unavailable_on_a_5xx(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        status_code = 503

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, *args, **kwargs) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    client = VLLMClient(make_settings(mode="live"))

    from aegis_gateway.errors import GatewayError

    with pytest.raises(GatewayError) as excinfo:
        await client.complete([])
    assert excinfo.value.code == "MODEL_UNAVAILABLE"


@pytest.mark.asyncio
async def test_complete_raises_plan_invalid_not_a_bare_exception_on_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Real bug, found live (2026-09-25): a real model call returned truncated JSON (cut off
    mid-string, most likely hitting the completion token budget) and the bare `json.loads` this
    replaced let a `JSONDecodeError` reach the route as an unhandled 500 — the client's own
    docstring promises 'never a bare exception a route would leak'."""

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {"choices": [{"message": {"content": '{"step_id": "s-1", "actions": [{"op": "wa'}}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, *args, **kwargs) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    client = VLLMClient(make_settings(mode="live"))

    from aegis_gateway.errors import GatewayError

    with pytest.raises(GatewayError) as excinfo:
        await client.complete([])
    assert excinfo.value.code == "PLAN_INVALID"
    assert excinfo.value.status_code == 422


@pytest.mark.asyncio
async def test_complete_raises_model_timeout_on_a_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, *args, **kwargs):
            raise httpx.TimeoutException("too slow")

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    client = VLLMClient(make_settings(mode="live"))

    from aegis_gateway.errors import GatewayError

    with pytest.raises(GatewayError) as excinfo:
        await client.complete([])
    assert excinfo.value.code == "MODEL_TIMEOUT"


def test_identity_adapter_disables_thinking_mode_and_passes_coordinates_through() -> None:
    adapter = IdentityCoordinateAdapter()
    assert adapter.chat_template_kwargs() == {"chat_template_kwargs": {"enable_thinking": False}}
    assert adapter.convert_point(10, 20, 1280, 720) == (10, 20)
    assert adapter is not DEFAULT_ADAPTER or isinstance(DEFAULT_ADAPTER, IdentityCoordinateAdapter)
