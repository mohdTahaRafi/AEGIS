"""design.md §4.7 (T-2.42 AC): every row of the error table produces its documented client
behaviour — HTTP status, error code, and (from the row's semantics) whether it's retryable."""

from __future__ import annotations

import pytest
from aegis_gateway.model_client.vllm import VLLMClient
from fastapi.testclient import TestClient

from .conftest import action_plan_body, make_settings, sanitized_context_body, session_create_body


@pytest.fixture
def live_client(monkeypatch: pytest.MonkeyPatch):
    from aegis_gateway.main import create_app

    app = create_app(make_settings(mode="live"))
    return TestClient(app)


def _session_id(client: TestClient) -> str:
    return client.post(
        "/v1/sessions", json=session_create_body(), headers={"Authorization": "Bearer test-token"}
    ).json()["session_id"]


def test_400_schema_invalid(live_client: TestClient) -> None:
    res = live_client.post(
        "/v1/sessions", json={"garbage": True}, headers={"Authorization": "Bearer test-token"}
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "SCHEMA_INVALID"
    assert res.json()["error"]["retryable"] is False


def test_401_unauthorized(live_client: TestClient) -> None:
    res = live_client.post("/v1/sessions", json=session_create_body())
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"
    assert res.json()["error"]["retryable"] is False


def test_404_session_not_found(live_client: TestClient) -> None:
    res = live_client.post(
        "/v1/sessions/00000000-0000-4000-8000-000000000000/steps",
        json=sanitized_context_body(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"
    assert res.json()["error"]["retryable"] is False


def test_409_step_out_of_order(monkeypatch: pytest.MonkeyPatch, live_client: TestClient) -> None:
    async def fake_complete(self, messages, route=None, pooled=False):
        return action_plan_body()

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)
    headers = {"Authorization": "Bearer test-token"}
    session_id = _session_id(live_client)

    first = live_client.post(
        f"/v1/sessions/{session_id}/steps",
        json=sanitized_context_body(step_id="s-5"),
        headers=headers,
    )
    assert first.status_code == 200

    second = live_client.post(
        f"/v1/sessions/{session_id}/steps",
        json=sanitized_context_body(step_id="s-5"),
        headers=headers,
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "STEP_OUT_OF_ORDER"
    assert second.json()["error"]["retryable"] is False


def test_413_payload_too_large(live_client: TestClient) -> None:
    body = sanitized_context_body(task="x" * (5 * 1024 * 1024))
    res = live_client.post(
        "/v1/sessions/whatever/steps",
        json=body,
        headers={
            "Authorization": "Bearer test-token",
            "Content-Length": str(5 * 1024 * 1024 + 1000),
        },
    )
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert res.json()["error"]["retryable"] is True


def test_422_plan_invalid(monkeypatch: pytest.MonkeyPatch, live_client: TestClient) -> None:
    async def fake_complete(self, messages, route=None, pooled=False):
        return {"step_id": "s-1", "actions": [{"op": "click", "node": "n-never-sent"}]}

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)
    headers = {"Authorization": "Bearer test-token"}
    session_id = _session_id(live_client)

    res = live_client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PLAN_INVALID"
    assert res.json()["error"]["retryable"] is False


def test_429_rate_limited(monkeypatch: pytest.MonkeyPatch, live_client: TestClient) -> None:
    async def fake_complete(self, messages, route=None, pooled=False):
        return action_plan_body()

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)
    headers = {"Authorization": "Bearer test-token"}
    session_id = _session_id(live_client)

    statuses = []
    for i in range(7):
        res = live_client.post(
            f"/v1/sessions/{session_id}/steps",
            json=sanitized_context_body(step_id=f"s-{i + 1}"),
            headers=headers,
        )
        statuses.append(res.status_code)
    assert 429 in statuses
    rate_limited_res = next(s for s in statuses if s == 429)
    assert rate_limited_res == 429


def test_503_model_unavailable(monkeypatch: pytest.MonkeyPatch, live_client: TestClient) -> None:
    import httpx

    class FailingAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, *a, **k):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", FailingAsyncClient)
    headers = {"Authorization": "Bearer test-token"}
    session_id = _session_id(live_client)

    res = live_client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "MODEL_UNAVAILABLE"
    assert res.json()["error"]["retryable"] is True


def test_504_model_timeout(monkeypatch: pytest.MonkeyPatch, live_client: TestClient) -> None:
    import httpx

    class TimingOutAsyncClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> None:
            pass

        async def post(self, *a, **k):
            raise httpx.TimeoutException("too slow")

    monkeypatch.setattr(httpx, "AsyncClient", TimingOutAsyncClient)
    headers = {"Authorization": "Bearer test-token"}
    session_id = _session_id(live_client)

    res = live_client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 504
    assert res.json()["error"]["code"] == "MODEL_TIMEOUT"
    assert res.json()["error"]["retryable"] is True
