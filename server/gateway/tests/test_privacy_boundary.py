"""The gateway as a privacy boundary and a reliable step server: a step that still carries a raw
identifier is refused before any model call; a failed model call releases the step lease so the
client's one retry is accepted; a full snapshot replaces the session's node set; a non-JSON answer
gets the same one corrective retry as an invalid plan. `VLLMClient.complete` is faked."""

from __future__ import annotations

import pytest
from aegis_gateway.errors import model_unavailable
from aegis_gateway.main import create_app
from aegis_gateway.model_client.normalize import PlanShapeError
from aegis_gateway.model_client.vllm import VLLMClient
from aegis_gateway.validation.pre_validate import find_unsanitized
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body

HEADERS = {"Authorization": "Bearer test-token"}


def _client() -> tuple[TestClient, str]:
    client = TestClient(create_app(make_settings(mode="live")))
    sid = client.post("/v1/sessions", json=session_create_body(), headers=HEADERS).json()[
        "session_id"
    ]
    return client, sid


def _fake_model(monkeypatch: pytest.MonkeyPatch, *answers: object) -> list:
    calls: list = []
    queue = list(answers)

    async def fake_complete(self, messages, route=None, pooled=False):
        calls.append(messages)
        answer = queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)
    return calls


@pytest.mark.parametrize(
    ("text", "entity"),
    [
        ("Aadhaar on record: 4987 1234 5679", "AADHAAR"),
        ("PAN ABCPK1234F", "PAN"),
        ("Mobile +91 98765 43210", "PHONE"),
        ("mail ramesh.kumar@example.in", "EMAIL"),
        ("card 4111 1111 1111 1111", "CARD_NUMBER"),
    ],
)
def test_a_raw_identifier_is_refused_before_the_model(
    monkeypatch: pytest.MonkeyPatch, text: str, entity: str
) -> None:
    calls = _fake_model(monkeypatch, {"actions": [{"op": "done"}]})
    client, sid = _client()
    body = sanitized_context_body(text=[{"id": "t-1", "box": [0, 0, 10, 10], "text": text}])
    res = client.post(f"/v1/sessions/{sid}/steps", json=body, headers=HEADERS)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "UNSANITIZED_CONTEXT"
    assert entity in res.json()["error"]["message"]
    assert text not in res.text
    assert calls == []


def test_sanitized_text_passes_the_tripwire() -> None:
    body = sanitized_context_body(
        text=[
            {"id": "t-1", "box": [0, 0, 10, 10], "text": "Aadhaar ⟪AADHAAR#1⟫ Mobile ⟪PHONE#2⟫"},
            {"id": "t-2", "box": [0, 0, 10, 10], "text": "Office hours 9:30 to 17:30, 31 October"},
        ]
    )
    assert find_unsanitized(body) == []


def test_a_failed_model_call_releases_the_step_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_model(monkeypatch, model_unavailable("upstream_5xx"), {"actions": [{"op": "done"}]})
    client, sid = _client()
    first = client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    assert first.status_code == 503
    again = client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    assert again.status_code == 200


def test_a_full_snapshot_replaces_the_node_set(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_model(
        monkeypatch,
        {"actions": [{"op": "wait", "ms": 100}]},
        {"actions": [{"op": "click", "node": "n-2"}]},
        {"actions": [{"op": "click", "node": "n-2"}]},
    )
    client, sid = _client()
    assert client.post(
        f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS
    ).status_code == 200
    step2 = sanitized_context_body(step_id="s-2")
    step2["nodes"] = [n for n in step2["nodes"] if n["id"] != "n-2"]
    res = client.post(f"/v1/sessions/{sid}/steps", json=step2, headers=HEADERS)
    # n-2 is gone from the page, so a click on it is rejected (after the one retry).
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PLAN_INVALID"


def test_a_non_json_answer_gets_one_corrective_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_model(
        monkeypatch, PlanShapeError("model response was not valid JSON"), {"actions": [{"op": "done"}]}
    )
    client, sid = _client()
    res = client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    assert res.status_code == 200
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("fmt", "point", "expected"),
    [
        ("rel1000_long_side", (500, 250), (640.0, 320.0)),  # 1280x720 region: unit 1.28 px
        ("rel1000", (500, 250), (640.0, 180.0)),
        ("image_px", (640, 180), (640.0, 180.0)),
    ],
)
def test_click_point_is_grounded_into_viewport_pixels(fmt: str, point: tuple, expected: tuple) -> None:
    from aegis_gateway.model_client.adapters import image_point_to_viewport

    assert image_point_to_viewport(*point, [0, 0, 1280, 720], 1.0, fmt) == expected


def test_click_point_with_a_downscaled_image() -> None:
    from aegis_gateway.model_client.adapters import image_point_to_viewport

    # A 2560x1440 viewport sent at scale 0.5: image pixel 640 is viewport pixel 1280.
    assert image_point_to_viewport(640, 360, [0, 0, 2560, 1440], 0.5, "image_px") == (1280.0, 720.0)


def test_a_stop_carries_the_models_short_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_model(monkeypatch, {"actions": [{"op": "stop", "reason": "cannot_proceed", "detail": "no username in the task"}]})
    client, sid = _client()
    res = client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    assert res.status_code == 200
    assert res.json()["actions"] == [{"op": "stop", "reason": "cannot_proceed", "detail": "no username in the task"}]


def test_the_plan_log_carries_ops_and_targets_never_typed_text() -> None:
    from aegis_gateway.api.routes_steps import _loggable_action

    assert _loggable_action({"op": "type", "node": "n-1", "text": "secret words"}) == {"op": "type", "node": "n-1", "text_len": 12}
    assert _loggable_action({"op": "stop", "reason": "cannot_proceed", "detail": "page prose"}) == {"op": "stop", "reason": "cannot_proceed"}
    assert _loggable_action({"op": "click_point", "x": 10.4, "y": 20.6, "label": "Sign in"}) == {"op": "click_point", "x": 10, "y": 21}


def test_a_free_text_stop_reason_is_kept_as_detail_not_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_model(monkeypatch, {"actions": [{"op": "stop", "reason": "no username provided in the task"}]})
    client, sid = _client()
    res = client.post(f"/v1/sessions/{sid}/steps", json=sanitized_context_body(), headers=HEADERS)
    assert res.status_code == 200
    assert res.json()["actions"] == [{"op": "stop", "reason": "cannot_proceed", "detail": "no username provided in the task"}]
    assert len(calls) == 1


def test_the_corrective_retry_never_resends_the_image(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_model(monkeypatch, {"actions": [{"op": "scroll", "direction": "sideways"}]}, {"actions": [{"op": "done"}]})
    client, sid = _client()
    body = sanitized_context_body()
    res = client.post(f"/v1/sessions/{sid}/steps", json=body, headers=HEADERS)
    assert res.status_code == 200
    retry = calls[1]
    assert all(isinstance(m["content"], str) for m in retry)  # no image part anywhere
    assert retry[-2] == {"role": "assistant", "content": '{"actions": [{"op": "scroll", "direction": "sideways"}]}'}
