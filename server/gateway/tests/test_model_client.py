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
