"""design.md §4.1 (T-2.32 AC): all five endpoints behave per the spec; /readyz returns 503 when
neither vLLM nor a replay store is available."""

from __future__ import annotations

from aegis_gateway.main import create_app
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body


def test_healthz_is_always_ok(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_readyz_is_503_in_replay_mode_with_no_replay_store_loaded() -> None:
    app = create_app(
        make_settings(
            mode="replay", record_dir="/tmp/aegis-gateway-empty-replay-dir-does-not-exist"
        )
    )
    client = TestClient(app)
    res = client.get("/readyz")
    assert res.status_code == 503


def test_readyz_is_503_in_live_mode_when_the_model_server_is_unreachable() -> None:
    app = create_app(make_settings(mode="live", model_url="http://127.0.0.1:1"))
    client = TestClient(app)
    res = client.get("/readyz")
    assert res.status_code == 503


def test_session_lifecycle_create_and_delete(client: TestClient, auth_headers: dict) -> None:
    created = client.post("/v1/sessions", json=session_create_body(), headers=auth_headers)
    assert created.status_code == 201
    body = created.json()
    assert "session_id" in body
    assert body["limits"]["max_steps"] == 30

    deleted = client.delete(f"/v1/sessions/{body['session_id']}", headers=auth_headers)
    assert deleted.status_code == 204

    # deleted session is gone: a step against it now gets SESSION_NOT_FOUND
    step_res = client.post(
        f"/v1/sessions/{body['session_id']}/steps",
        json=sanitized_context_body(),
        headers=auth_headers,
    )
    assert step_res.status_code == 404
    assert step_res.json()["error"]["code"] == "SESSION_NOT_FOUND"


def test_step_against_an_unknown_session_is_404(client: TestClient, auth_headers: dict) -> None:
    res = client.post(
        "/v1/sessions/00000000-0000-4000-8000-000000000000/steps",
        json=sanitized_context_body(),
        headers=auth_headers,
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"
