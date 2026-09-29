"""R-2/R-3 at the route: the image reaches the model call, and a json_object answer (which no
endpoint schema-checks) is normalized, validated against the wire schema and the session, and
retried once with a user-turn note, never trusted as-is. `VLLMClient.complete` is faked: no
network."""

from __future__ import annotations

import httpx
import pytest
from aegis_gateway.main import create_app
from aegis_gateway.model_client import vllm
from aegis_gateway.model_client.vllm import VLLMClient
from aegis_gateway.prompt import MAX_ELEMENTS
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body
from .test_prompt_image import IMAGE, REDACTION

HEADERS = {"Authorization": "Bearer test-token"}


def _client(**settings: object) -> TestClient:
    return TestClient(create_app(make_settings(mode="live", **settings)))


def _post_step(client: TestClient, body: dict):
    sid = client.post("/v1/sessions", json=session_create_body(), headers=HEADERS).json()[
        "session_id"
    ]
    return client.post(f"/v1/sessions/{sid}/steps", json=body, headers=HEADERS)


def _fake_model(monkeypatch: pytest.MonkeyPatch, *answers: object) -> list:
    """Each model call returns the next answer; returns the list of `messages` it was given."""
    calls: list = []
    queue = list(answers)

    async def fake_complete(self, messages, route=None, pooled=False):
        calls.append(messages)
        return queue.pop(0)

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)
    return calls


def _user_content(messages: list) -> object:
    return next(m["content"] for m in messages if m["role"] == "user")


def test_the_image_always_reaches_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_model(monkeypatch, {"actions": [{"op": "done"}]})
    res = _post_step(_client(), sanitized_context_body(image=IMAGE))
    assert res.status_code == 200
    content = _user_content(calls[0])
    assert isinstance(content, list)
    assert content[1]["type"] == "image_url"


def test_the_models_element_alias_is_mapped_back_to_the_node_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _fake_model(monkeypatch, {"actions": [{"op": "click", "node": "e1"}]})
    body = sanitized_context_body(image=IMAGE)
    res = _post_step(_client(), body)
    assert res.status_code == 200
    assert res.json()["actions"][0]["node"] == body["nodes"][0]["id"]
    assert "e1 | " in _user_content(calls[0])[0]["text"]


def test_a_retry_after_an_unknown_alias_still_carries_no_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _fake_model(
        monkeypatch,
        {"actions": [{"op": "click", "node": "e99"}]},
        {"actions": [{"op": "click", "node": "e1"}]},
    )
    res = _post_step(_client(), sanitized_context_body(image=IMAGE))
    assert res.status_code == 200
    assert "e99" in str(calls[1][-1]["content"])
    assert all(isinstance(m["content"], str) for m in calls[1])


def test_a_bare_ref_round_trips_to_the_wire_form(monkeypatch: pytest.MonkeyPatch) -> None:
    redaction = {**REDACTION, "ref": "⟪AADHAAR#2⟫"}
    _fake_model(monkeypatch, {"actions": [{"op": "type", "node": "n-1", "ref": "AADHAAR#2"}]})
    res = _post_step(_client(), sanitized_context_body(redactions=[redaction]))
    assert res.status_code == 200
    assert res.json() == {
        "step_id": "s-1",
        "plan_id": "p-1",
        "actions": [{"op": "type", "node": "n-1", "ref": "⟪AADHAAR#2⟫"}],
    }


@pytest.mark.parametrize(
    "bad",
    [
        {"actions": [{"op": "scroll", "direction": "sideways"}]},  # value outside the enum
        {"actions": [{"op": "click", "node": "n-2", "colour": "red"}]},  # unexpected field
        {"actions": [{"op": "click"}]},  # missing required field
        {"actions": [{"op": "teleport", "node": "n-2"}]},  # unknown op
        {"actions": [{"op": "click", "node": "n-999"}]},  # node never sent
        {"plan": "click the button"},  # no actions list at all
        {"actions": []},  # empty
    ],
)
def test_an_invalid_answer_is_retried_once_with_a_user_note(
    monkeypatch: pytest.MonkeyPatch, bad: dict
) -> None:
    calls = _fake_model(monkeypatch, bad, {"actions": [{"op": "click", "node": "n-2"}]})
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 200
    assert res.json()["actions"] == [{"op": "click", "node": "n-2"}]
    assert len(calls) == 2
    note = calls[1][-1]
    assert note["role"] == "user"
    assert note["content"].startswith("Your previous output was invalid:")
    assert [m["role"] for m in calls[1]].count("system") == 1


def test_two_invalid_answers_are_plan_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = {"actions": [{"op": "click", "node": "n-999"}]}
    _fake_model(monkeypatch, bad, bad)
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PLAN_INVALID"


def test_an_upstream_429_is_a_503_with_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, *a, **k):
            return httpx.Response(429, headers={"retry-after": "90"})

    # Longer than the gateway waits for a budget (60 s): the client is told when to come back.
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(vllm.asyncio, "sleep", lambda s: pytest.fail("must not wait 90 s"))
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 503
    assert res.headers["Retry-After"] == "90"
    assert res.json()["error"] == {
        "code": "MODEL_UNAVAILABLE",
        "message": "Model unavailable: upstream_429",
        "request_id": res.json()["error"]["request_id"],
        "retryable": True,
    }


GROQ_413_BODY = {
    "error": {
        "type": "tokens",
        "code": "rate_limit_exceeded",
        "message": "Request too large ... (ITPM): Limit 7000, Requested 9000, please reduce",
    }
}


def _elements_in(payload: dict) -> int:
    content = payload["messages"][1]["content"]
    text = content if isinstance(content, str) else content[0]["text"]
    return text.split("ELEMENTS:\n", 1)[1].split("\nTEXT:", 1)[0].count("\n") + 1


def _many_nodes_body() -> dict:
    body = sanitized_context_body()
    template = body["nodes"][0]
    body["nodes"] = [
        {**template, "id": f"n-{i:03d}", "box": [10, 10 + i * 7, 200, 6]} for i in range(100)
    ]
    return body


def test_a_too_large_prompt_is_rebuilt_smaller_not_resent(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 413 costs no quota, so the gateway rebuilds the prompt with fewer elements/text lines
    (sized from the upstream's own limit/request numbers) instead of failing or re-sending the
    same oversized request."""
    payloads: list[dict] = []

    class FakeAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, url, json, headers):
            payloads.append(json)
            if len(payloads) == 1:
                return httpx.Response(413, json=GROQ_413_BODY)
            return httpx.Response(
                200, json={"choices": [{"message": {"content": '{"actions":[{"op":"done"}]}'}}]}
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    res = _post_step(_client(), _many_nodes_body())
    assert res.status_code == 200, res.text
    assert len(payloads) == 2
    first, second = _elements_in(payloads[0]), _elements_in(payloads[1])
    assert first in (MAX_ELEMENTS, MAX_ELEMENTS + 1)  # the cap (+ its "more elements" line)
    assert second < first * 7000 / 9000  # margin below the upstream's own ratio


def test_a_prompt_that_never_fits_fails_fast_and_is_not_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posts: list[int] = []

    class FakeAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, *a, **k):
            posts.append(1)
            return httpx.Response(413, json=GROQ_413_BODY)

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    res = _post_step(_client(), _many_nodes_body())
    assert res.status_code == 502
    assert res.json()["error"]["retryable"] is False
    assert res.json()["error"]["message"] == (
        "Model unavailable: upstream_too_large (input 9000 tokens > limit 7000 per minute)"
    )
    assert len(posts) == 3  # the original + two smaller rebuilds, then stop


def test_json_validate_failed_gets_the_invalid_plan_retry_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payloads: list[dict] = []

    class FakeAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, url, json, headers):
            payloads.append(json)
            if len(payloads) == 1:
                return httpx.Response(
                    400,
                    json={
                        "error": {
                            "type": "invalid_request_error",
                            "code": "json_validate_failed",
                            "failed_generation": "This form is",
                        }
                    },
                )
            return httpx.Response(
                200, json={"choices": [{"message": {"content": '{"actions":[{"op":"done"}]}'}}]}
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 200, res.text
    assert len(payloads) == 2
    assert "image_url" not in str(payloads[1]["messages"])


def test_the_standard_browser_actions_pass_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    actions = [
        {"op": "hover", "node": "n-1"},
        {"op": "double_click", "node": "n-1"},
        {"op": "press_key", "key": "Enter", "node": "n-1"},
        {"op": "press_key", "key": "Escape"},
        {"op": "go_back"},
    ]
    _fake_model(monkeypatch, {"actions": actions})
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 200
    assert res.json()["actions"] == actions


def test_open_tab_passes_and_logs_only_the_host(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("INFO")
    action = {"op": "open_tab", "url": "https://www.amazon.in/s?k=65w+charger"}
    _fake_model(monkeypatch, {"actions": [action]})
    res = _post_step(_client(), sanitized_context_body(task="buy a 65W charger"))
    assert res.status_code == 200
    assert res.json()["actions"] == [action]
    assert "www.amazon.in" in caplog.text
    assert "65w+charger" not in caplog.text


@pytest.mark.parametrize(
    "url", ["javascript:alert(1)", "https://x.example/⟪EMAIL#1⟫", "ftp://files.example/"]
)
def test_a_non_web_or_placeholder_url_is_plan_invalid(
    monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    _fake_model(monkeypatch, *([{"actions": [{"op": "navigate", "url": url}]}] * 2))
    res = _post_step(_client(), sanitized_context_body())
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PLAN_INVALID"


def _filled_second_step() -> dict:
    """Step 2 of a session whose step 1 typed into n-1: the field now holds text."""
    body = sanitized_context_body(
        step_id="s-2",
        reason="after_action",
        history=[{"step_id": "s-1", "actions": [{"op": "type", "node": "n-1"}], "outcome": "acted"}],
    )
    body["nodes"][0]["state"]["has_value"] = True
    body["nodes"][0]["value"] = {"kind": "text", "text": "x"}
    return body


def _two_steps(client: TestClient, second: dict):
    sid = client.post("/v1/sessions", json=session_create_body(), headers=HEADERS).json()[
        "session_id"
    ]
    client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    return client.post(f"/v1/sessions/{sid}/steps", json=second, headers=HEADERS)


def test_typing_the_same_text_into_a_field_that_still_holds_it_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Live, 2026-09-30: a Gmail reply was typed again on every step (the box looked empty)."""
    reply = {"op": "type", "node": "e1", "text": "Dear Saood,\nThank you."}
    calls = _fake_model(
        monkeypatch,
        {"actions": [reply]},
        {"actions": [reply]},
        {"actions": [{"op": "click", "node": "e2"}]},
    )
    res = _two_steps(_client(), _filled_second_step())
    assert res.status_code == 200
    assert res.json()["actions"] == [{"op": "click", "node": "n-2"}]
    assert "already typed" in calls[2][-1]["content"]
    assert "HISTORY: s-1: type e1 -> acted" in _user_content(calls[1])


def test_different_text_or_an_emptied_field_may_be_typed_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = {"op": "type", "node": "e1", "text": "Dear Saood"}
    _fake_model(monkeypatch, {"actions": [reply]}, {"actions": [reply]})
    emptied = _filled_second_step()
    emptied["nodes"][0]["state"]["has_value"] = False
    emptied["nodes"][0]["value"] = {"kind": "empty"}
    assert _two_steps(_client(), emptied).status_code == 200

    _fake_model(
        monkeypatch,
        {"actions": [reply]},
        {"actions": [{**reply, "text": "Dear Saood, sorry"}]},
    )
    assert _two_steps(_client(), _filled_second_step()).status_code == 200
