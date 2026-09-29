"""design.md §8.3/§12.1 — the model client's request and failure behaviour, all against a fake
httpx client (no network). What it sends: output format per setting (json_schema with the
model-facing schema, json_object, or none), `chat_template_kwargs` only when enabled, the bearer
key and `max_tokens` (R-2/R-3). How it fails: every upstream error is a GatewayError with a
closed-vocabulary reason, never a bare exception (A21), with at most one retry, only for a 429
with a short `retry-after` or a dropped connection (R-1). T-2.37: the adapter's conventions.
"""

from __future__ import annotations

from json import dumps

import httpx
import pytest
from aegis_gateway.errors import GatewayError, ModelRequestTooLarge
from aegis_gateway.model_client import vllm
from aegis_gateway.model_client.adapters import DEFAULT_ADAPTER, IdentityCoordinateAdapter
from aegis_gateway.model_client.normalize import PlanShapeError
from aegis_gateway.model_client.vllm import (
    VLLMClient,
    load_action_plan_schema,
    load_model_facing_schema,
)

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
    assert external_refs == [], (
        f"unresolved external refs would leave these fields unconstrained during decoding: {external_refs}"
    )
    assert any(r.startswith("#/$defs/") for r in refs), (
        "same-document refs should be untouched, not also inlined away"
    )

    # The concrete case that actually broke: stepId's pattern must have made it into the schema
    # object that gets sent, not just exist somewhere in common.schema.json unreferenced.
    step_id_schema = schema["properties"]["step_id"]
    assert step_id_schema.get("pattern") == "^s-[0-9]+$"


class FakeResponse:
    def __init__(self, status_code: int = 200, body: object = None, headers: dict | None = None):
        self.status_code = status_code
        self._body = body
        self.headers = httpx.Headers(headers or {})

    def json(self) -> object:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _content_body(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


VALID_PLAN = {"actions": [{"op": "wait", "ms": 100}]}


def _install_fake_client(monkeypatch: pytest.MonkeyPatch, *responses: object) -> dict:
    """Each `post` pops the next item: a FakeResponse to return, or an exception to raise. With no
    items, every post answers 200 with VALID_PLAN. `captured["posts"]` counts calls; asyncio.sleep
    in the client is replaced so retry waits are recorded, not slept."""
    captured: dict = {"posts": 0, "sleeps": []}
    queue = list(responses)

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, url: str, json: dict, **kwargs) -> FakeResponse:
            captured["posts"] += 1
            captured["url"] = url
            captured["payload"] = json
            captured["headers"] = kwargs.get("headers", {})
            item = queue.pop(0) if queue else FakeResponse(200, _content_body(dumps(VALID_PLAN)))
            if isinstance(item, Exception):
                raise item
            return item

    async def fake_sleep(seconds: float) -> None:
        captured["sleeps"].append(seconds)

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(vllm.asyncio, "sleep", fake_sleep)
    return captured


async def _gateway_error(settings, monkeypatch, *responses) -> GatewayError:
    _install_fake_client(monkeypatch, *responses)
    with pytest.raises(GatewayError) as excinfo:
        await VLLMClient(settings).complete([])
    return excinfo.value


@pytest.mark.asyncio
async def test_complete_sends_the_model_facing_schema_when_json_schema_is_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch)
    client = VLLMClient(make_settings(mode="live", model_response_format="json_schema"))
    plan = await client.complete([{"role": "system", "content": "x"}])

    assert plan == VALID_PLAN
    response_format = captured["payload"]["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["schema"] == load_model_facing_schema()
    assert "chat_template_kwargs" not in captured["payload"]
    assert captured["url"].endswith("/chat/completions")


@pytest.mark.asyncio
async def test_default_format_is_json_object_without_template_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The R-1 endpoint (Groq) answers HTTP 400 to both strict json_schema for this schema and
    to `chat_template_kwargs` (measured 2026-09-28), so neither is sent by default."""
    captured = _install_fake_client(monkeypatch)
    await VLLMClient(make_settings(mode="live")).complete([])
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert "chat_template_kwargs" not in captured["payload"]


@pytest.mark.asyncio
async def test_format_none_sends_no_response_format(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _install_fake_client(monkeypatch)
    await VLLMClient(make_settings(mode="live", model_response_format="none")).complete([])
    assert "response_format" not in captured["payload"]


@pytest.mark.asyncio
async def test_template_kwargs_only_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _install_fake_client(monkeypatch)
    settings = make_settings(mode="live", model_chat_template_kwargs=True)
    await VLLMClient(settings).complete([])
    assert captured["payload"]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_complete_sends_bearer_key_and_max_tokens_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch)
    settings = make_settings(mode="live", model_api_key="sk-test", model_max_tokens=321)
    await VLLMClient(settings).complete([{"role": "user", "content": "x"}])
    assert captured["headers"] == {"Authorization": "Bearer sk-test"}
    assert captured["payload"]["max_tokens"] == 321


@pytest.mark.asyncio
async def test_complete_sends_no_auth_header_without_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _install_fake_client(monkeypatch)
    await VLLMClient(make_settings(mode="live")).complete([{"role": "user", "content": "x"}])
    assert captured["headers"] == {}


def test_settings_repr_never_contains_the_key() -> None:
    assert "sk-test" not in repr(make_settings(model_api_key="sk-test"))


@pytest.mark.asyncio
async def test_complete_raises_model_unavailable_on_a_5xx(monkeypatch: pytest.MonkeyPatch) -> None:
    error = await _gateway_error(make_settings(mode="live"), monkeypatch, FakeResponse(503))
    assert error.code == "MODEL_UNAVAILABLE"
    assert error.message.endswith("upstream_5xx")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "body", "message", "retryable"),
    [
        (
            401,
            {"error": {"type": "invalid_request_error", "code": "invalid_api_key"}},
            "upstream_auth (401 invalid_api_key)",
            False,
        ),
        (403, None, "upstream_auth (403)", False),
        (
            400,
            {"error": {"type": "invalid_request_error", "code": "context_length_exceeded"}},
            "upstream_4xx (400 context_length_exceeded)",
            False,
        ),
        (
            404,
            {"error": {"code": "model_not_found", "message": "The model x does not exist"}},
            "upstream_4xx (404 model_not_found)",
            False,
        ),
        (500, None, "upstream_5xx", True),
        (503, None, "upstream_5xx", True),
    ],
)
async def test_upstream_errors_map_to_a_specific_reason_not_a_500(
    monkeypatch: pytest.MonkeyPatch, status: int, body: object, message: str, retryable: bool
) -> None:
    """A21: `raise_for_status()` used to sit outside the try, so any 4xx became an unhandled 500.
    None of these is retried by the gateway. A 4xx is permanent (a bad key or a rejected request
    fails the same way again): not retryable for the client either, and the message says which
    one. Only a 5xx is transient."""
    captured = _install_fake_client(monkeypatch, FakeResponse(status, body))
    with pytest.raises(GatewayError) as excinfo:
        await VLLMClient(make_settings(mode="live")).complete([])
    assert excinfo.value.code == "MODEL_UNAVAILABLE"
    assert excinfo.value.message == f"Model unavailable: {message}"
    assert excinfo.value.retryable is retryable
    assert excinfo.value.status_code == (503 if retryable else 502)
    assert captured["posts"] == 1
    assert "does not exist" not in excinfo.value.message


GROQ_413 = {
    "error": {
        "type": "tokens",
        "code": "rate_limit_exceeded",
        "message": "Request too large for model `qwen/qwen3.8-27b` in organization `org_01abc` "
        "service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 9046, "
        "please reduce your message size and try again.",
    }
}


@pytest.mark.asyncio
async def test_a_413_too_many_input_tokens_is_permanent_and_carries_only_the_numbers(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Live Gmail, 2026-09-29: Groq answered 413 (`tokens`/`rate_limit_exceeded`, ITPM limit
    7000) and the gateway called it a retryable `upstream_4xx`, so the client re-sent the same
    oversized step. Now: not retried, and the limit/request numbers (never the org id or any
    other upstream text) reach the log and the client."""
    captured = _install_fake_client(monkeypatch, FakeResponse(413, GROQ_413, {"retry-after": "43"}))
    with pytest.raises(ModelRequestTooLarge) as excinfo:
        await VLLMClient(make_settings(mode="live")).complete([])
    error = excinfo.value
    assert (error.limit, error.requested, error.retryable) == (7000, 9046, False)
    assert error.message == (
        "Model unavailable: upstream_too_large (input 9046 tokens > limit 7000 per minute)"
    )
    assert captured["posts"] == 1 and captured["sleeps"] == []
    logged = caplog.text
    assert '"reason": "upstream_too_large"' in logged and '"requested": 9046' in logged
    assert '"code": "rate_limit_exceeded"' in logged
    assert "org_01abc" not in logged and "qwen/qwen3.8-27b" not in logged


@pytest.mark.asyncio
async def test_a_200_error_envelope_is_bad_body(monkeypatch: pytest.MonkeyPatch) -> None:
    error = await _gateway_error(
        make_settings(mode="live"), monkeypatch, FakeResponse(200, {"error": {"message": "x"}})
    )
    assert error.code == "MODEL_UNAVAILABLE"
    assert error.message.endswith("bad_body")


@pytest.mark.asyncio
async def test_a_non_json_body_is_bad_body(monkeypatch: pytest.MonkeyPatch) -> None:
    error = await _gateway_error(
        make_settings(mode="live"), monkeypatch, FakeResponse(200, ValueError("not json"))
    )
    assert error.message.endswith("bad_body")


@pytest.mark.asyncio
async def test_null_content_is_bad_body(monkeypatch: pytest.MonkeyPatch) -> None:
    error = await _gateway_error(
        make_settings(mode="live"),
        monkeypatch,
        FakeResponse(200, {"choices": [{"message": {"content": None}}]}),
    )
    assert error.message.endswith("bad_body")


@pytest.mark.asyncio
async def test_code_fenced_json_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(
        monkeypatch, FakeResponse(200, _content_body('```json\n{"actions":[{"op":"done"}]}\n```'))
    )
    plan = await VLLMClient(make_settings(mode="live")).complete([])
    assert plan == {"actions": [{"op": "done"}]}


@pytest.mark.asyncio
async def test_complete_raises_plan_shape_error_not_a_bare_exception_on_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A truncated answer (completion budget hit) must not reach the route as an unhandled 500. It
    raises PlanShapeError, which the route treats like any invalid plan: one corrective retry,
    then PLAN_INVALID (see test_route_model_output)."""
    _install_fake_client(
        monkeypatch, FakeResponse(200, _content_body('{"step_id": "s-1", "actions": [{"op": "wa'))
    )
    with pytest.raises(PlanShapeError):
        await VLLMClient(make_settings(mode="live")).complete([])


@pytest.mark.asyncio
async def test_complete_raises_model_timeout_on_a_timeout_and_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch, httpx.TimeoutException("too slow"))
    with pytest.raises(GatewayError) as excinfo:
        await VLLMClient(make_settings(mode="live")).complete([])
    assert excinfo.value.code == "MODEL_TIMEOUT"
    assert captured["posts"] == 1


# --- R-1 reliability: bounded retry ------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_429_with_a_short_retry_after_is_retried_once_after_that_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch, FakeResponse(429, headers={"retry-after": "7"}))
    plan = await VLLMClient(make_settings(mode="live")).complete([])
    assert plan == VALID_PLAN
    assert captured["posts"] == 2
    assert captured["sleeps"] == [7.0]


@pytest.mark.asyncio
async def test_a_second_429_is_not_retried_and_carries_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(
        monkeypatch,
        FakeResponse(429, headers={"retry-after": "2"}),
        FakeResponse(429, headers={"retry-after": "3"}),
    )
    with pytest.raises(GatewayError) as excinfo:
        await VLLMClient(make_settings(mode="live")).complete([])
    assert excinfo.value.message.endswith("upstream_429")
    assert excinfo.value.headers == {"Retry-After": "3"}
    assert captured["posts"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{"retry-after": "45"}, {}])
async def test_a_429_with_a_long_or_missing_retry_after_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, headers: dict
) -> None:
    """Waiting 45 s inside one step would hang the panel; retrying without being told when would
    only earn another 429. Both fail fast and say why."""
    captured = _install_fake_client(monkeypatch, FakeResponse(429, headers=headers))
    with pytest.raises(GatewayError) as excinfo:
        await VLLMClient(make_settings(mode="live")).complete([])
    assert excinfo.value.message.endswith("upstream_429")
    assert captured["posts"] == 1
    assert captured["sleeps"] == []


@pytest.mark.asyncio
async def test_retries_can_be_turned_off(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _install_fake_client(monkeypatch, FakeResponse(429, headers={"retry-after": "1"}))
    with pytest.raises(GatewayError):
        await VLLMClient(make_settings(mode="live", model_max_retries=0)).complete([])
    assert captured["posts"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc", [httpx.ConnectError("refused"), httpx.RemoteProtocolError("closed without response")]
)
async def test_a_dropped_connection_is_retried_once(
    monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    captured = _install_fake_client(monkeypatch, exc)
    plan = await VLLMClient(make_settings(mode="live")).complete([])
    assert plan == VALID_PLAN
    assert captured["posts"] == 2
    assert captured["sleeps"] == [1.0]


@pytest.mark.asyncio
async def test_two_dropped_connections_are_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    error = await _gateway_error(
        make_settings(mode="live"),
        monkeypatch,
        httpx.ConnectError("refused"),
        httpx.ConnectError("refused"),
    )
    assert error.message.endswith("unreachable")


def test_identity_adapter_disables_thinking_mode_and_passes_coordinates_through() -> None:
    adapter = IdentityCoordinateAdapter()
    assert adapter.chat_template_kwargs() == {"chat_template_kwargs": {"enable_thinking": False}}
    assert adapter.convert_point(10, 20, 1280, 720) == (10, 20)
    assert adapter is not DEFAULT_ADAPTER or isinstance(DEFAULT_ADAPTER, IdentityCoordinateAdapter)


@pytest.mark.asyncio
async def test_the_request_shape_log_has_sizes_never_content(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _install_fake_client(monkeypatch)
    messages = [
        {"role": "system", "content": "rules"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "TASK: open the mail from Asha"},
                {"type": "image_url", "image_url": {"url": "data:image/webp;base64,QUJDRA=="}},
            ],
        },
    ]
    await VLLMClient(make_settings(mode="live")).complete(messages)
    logged = caplog.text
    assert '"event": "model_request"' in logged
    assert '"text_chars": 34' in logged
    assert '"images": [{"format": "image/webp", "bytes": 6}]' in logged
    assert "Asha" not in logged and "QUJDRA" not in logged


GROQ_JSON_VALIDATE_FAILED = {
    "error": {
        "message": "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' "
        "for more details. org_01abc",
        "type": "invalid_request_error",
        "param": "",
        "code": "json_validate_failed",
        "failed_generation": "This form is the user registration form for ⟪PERSON_NAME#1⟫ "
        + "QUJD" * 20,
    }
}


@pytest.mark.asyncio
async def test_json_validate_failed_is_an_invalid_plan_not_model_unavailable(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Live 2026-09-29, Passport Seva, "explain me what is this form about...": Groq ran the model
    and its output began as prose, so JSON mode refused it (400 json_validate_failed). That is the
    model's invalid plan, the same case as unparseable content: PlanShapeError (the route's one
    corrective retry, then PLAN_INVALID). The default log carries its length, never its text."""
    _install_fake_client(monkeypatch, FakeResponse(400, GROQ_JSON_VALIDATE_FAILED))
    with pytest.raises(PlanShapeError, match="json_validate_failed"):
        await VLLMClient(make_settings(mode="live")).complete([])
    logged = caplog.text
    assert '"reason": "output_not_json"' in logged
    assert '"failed_generation_chars": 140' in logged
    assert '"failed_generation_starts_json": false' in logged
    assert "This form" not in logged and "model_error_detail" not in logged


@pytest.mark.asyncio
async def test_the_dev_log_has_the_whole_error_body_without_org_ids_or_base64(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _install_fake_client(monkeypatch, FakeResponse(400, GROQ_JSON_VALIDATE_FAILED))
    with pytest.raises(PlanShapeError):
        await VLLMClient(make_settings(mode="live", log_payloads=True)).complete([])
    detail = next(
        json_line
        for json_line in (r.getMessage() for r in caplog.records)
        if '"model_error_detail"' in json_line
    )
    assert "Failed to generate JSON" in detail and "This form is the user registration" in detail
    assert "org_<redacted>" in detail and "org_01abc" not in detail
    assert "<base64>" in detail and "QUJDQUJD" not in detail
    assert '"fields": ["code", "failed_generation", "message", "param", "type"]' in detail


@pytest.mark.asyncio
@pytest.mark.parametrize("temperature", [None, 0.0])
async def test_temperature_is_sent_only_when_configured(
    monkeypatch: pytest.MonkeyPatch, temperature: float | None
) -> None:
    captured = _install_fake_client(monkeypatch)
    settings = make_settings(mode="live", model_temperature=temperature)
    await VLLMClient(settings).complete([])
    if temperature is None:
        assert "temperature" not in captured["payload"]
    else:
        assert captured["payload"]["temperature"] == 0.0


def test_the_system_prompt_routes_questions_to_report_and_done() -> None:
    from aegis_gateway.prompt import SYSTEM_PROMPT

    assert '{"op":"report","content":' in SYSTEM_PROMPT
    assert "never as\n  plain text" in SYSTEM_PROMPT
    assert "your reply starts with { and ends with }" in SYSTEM_PROMPT


# --- The rate-aware route pool: every route is a vision model and gets the screenshot; a spent
# budget is waited out at the gateway (or moved to another vision model), never sent into a 429.

_IMG_MSGS = [
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "x" * 2600},
            {"type": "image_url", "image_url": {"url": "data:image/webp;base64,AA"}},
        ],
    }
]


def _limits(remaining: int, limit: int = 8000) -> dict:
    return {"x-ratelimit-limit-tokens": str(limit), "x-ratelimit-remaining-tokens": str(remaining)}


def _ok(remaining: int) -> FakeResponse:
    return FakeResponse(200, _content_body(dumps(VALID_PLAN)), _limits(remaining))


@pytest.mark.asyncio
async def test_a_spent_budget_moves_the_step_with_its_screenshot_to_another_vision_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch, _ok(300), _ok(7000))
    client = VLLMClient(make_settings(mode="live", model_fallbacks=("vision-2",)))
    _, first = await client.complete_routed(_IMG_MSGS, 3500)
    assert first.name == "test-model"
    # The primary reported 300 tokens left: a ~5K-token step would wait ~35 s for it.
    _, second = await client.complete_routed(_IMG_MSGS, 3500)
    assert second.name == "vision-2"
    assert captured["payload"]["model"] == "vision-2"
    assert captured["payload"]["messages"] == _IMG_MSGS
    assert captured["sleeps"] == []


@pytest.mark.asyncio
async def test_a_429_moves_the_step_to_the_next_route_instead_of_sleeping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(
        monkeypatch,
        FakeResponse(429, {"error": {"code": "rate_limit_exceeded"}}, {"retry-after": "45"}),
        FakeResponse(200, _content_body(dumps(VALID_PLAN))),
    )
    client = VLLMClient(make_settings(mode="live", model_fallbacks=("vision-2",)))
    plan, route = await client.complete_routed(_IMG_MSGS, 3500)
    assert plan == VALID_PLAN and route.name == "vision-2"
    assert captured["posts"] == 2 and captured["sleeps"] == []
    assert captured["payload"]["messages"] == _IMG_MSGS


@pytest.mark.asyncio
async def test_one_model_waits_for_its_budget_instead_of_sending_into_a_429(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(monkeypatch, _ok(300), _ok(7000))
    client = VLLMClient(make_settings(mode="live"))
    await client.complete_routed(_IMG_MSGS, 3500)
    plan, route = await client.complete_routed(_IMG_MSGS, 3500)
    assert plan == VALID_PLAN and route.name == "test-model"
    assert captured["posts"] == 2
    # 2600 chars (~1300) + the image (3500) + a completion (250) against 300 left, at 8000/min.
    assert len(captured["sleeps"]) == 1 and 30 < captured["sleeps"][0] < 40
    assert captured["payload"]["messages"] == _IMG_MSGS


@pytest.mark.asyncio
async def test_a_429_on_the_only_model_is_waited_out_when_it_is_short(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_fake_client(
        monkeypatch,
        FakeResponse(429, {"error": {"code": "rate_limit_exceeded"}}, {"retry-after": "7"}),
        FakeResponse(200, _content_body(dumps(VALID_PLAN))),
    )
    plan, _ = await VLLMClient(make_settings(mode="live")).complete_routed(_IMG_MSGS, 3500)
    assert plan == VALID_PLAN
    assert captured["posts"] == 2 and len(captured["sleeps"]) == 1
    assert 6 < captured["sleeps"][0] <= 7


def test_the_budget_counts_what_the_gateway_sent_not_only_the_lagging_header() -> None:
    bucket = vllm._TokenBucket()
    bucket.update(httpx.Headers(_limits(8000)), now=0.0)
    bucket.spend(5000, now=0.0)
    # Groq's header after an image request still shows most of the image's cost unspent.
    bucket.update(httpx.Headers(_limits(6000)), now=0.0)
    assert bucket.available(0.0) == 3000
    assert bucket.available(30.0) == 7000


@pytest.mark.asyncio
async def test_the_unused_completion_budget_is_given_back_after_the_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = {**_content_body(dumps(VALID_PLAN)), "usage": {"completion_tokens": 100}}
    _install_fake_client(monkeypatch, FakeResponse(200, body, _limits(8000)))
    client = VLLMClient(make_settings(mode="live", model_max_tokens=900))
    await client.complete_routed(_IMG_MSGS, 3600)
    bucket = client._bucket("test-model")
    assert bucket.sent[-1][1] == vllm.estimate_tokens(_IMG_MSGS, 900, 3600) - 800


@pytest.mark.asyncio
async def test_a_429s_retry_after_is_trusted_not_its_budget_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Live, 2026-09-30: a 429 saying "retry after 9 s" carried a near-empty budget header, and
    # reading it turned the wait into 42 s.
    captured = _install_fake_client(
        monkeypatch,
        FakeResponse(
            429,
            {"error": {"code": "rate_limit_exceeded"}},
            {"retry-after": "5", **_limits(0)},
        ),
        _ok(4000),
    )
    await VLLMClient(make_settings(mode="live")).complete_routed(_IMG_MSGS, 3600)
    assert captured["posts"] == 2 and len(captured["sleeps"]) == 1
    assert captured["sleeps"][0] <= 5
