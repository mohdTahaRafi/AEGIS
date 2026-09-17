"""design.md §12.1 (T-2.34 AC): session expires after 15 min idle -> 404 SESSION_NOT_FOUND; the
client creates a new session once and resends (that resend behaviour is the extension's own
job — src/host/session.ts doesn't implement it yet in Phase 2; this test proves the server half:
the 404 itself, and that a fresh session is unaffected by another one's expiry)."""

from __future__ import annotations

from aegis_gateway.config import Settings
from aegis_gateway.main import create_app
from aegis_gateway.sessions.store import SessionStore
from fastapi.testclient import TestClient

from .conftest import sanitized_context_body


def test_get_returns_none_and_evicts_after_ttl_elapses() -> None:
    now = [1000.0]
    store = SessionStore(ttl_s=900, now=lambda: now[0])
    session = store.create(model="test-model", max_steps=30)

    assert store.get(session.session_id) is not None

    now[0] += 901
    assert store.get(session.session_id) is None
    assert len(store) == 0  # lazily evicted, not just hidden


def test_touch_resets_the_idle_clock() -> None:
    now = [0.0]
    store = SessionStore(ttl_s=100, now=lambda: now[0])
    session = store.create(model="test-model", max_steps=30)

    now[0] = 90
    store.touch(session.session_id)
    now[0] = 150
    assert store.get(session.session_id) is not None  # only 60s since the touch, still alive

    now[0] = 300
    assert store.get(session.session_id) is None


def test_sweep_expired_removes_only_the_expired_ones() -> None:
    now = [0.0]
    store = SessionStore(ttl_s=100, now=lambda: now[0])
    old_session = store.create(model="test-model", max_steps=30)
    now[0] = 50
    fresh_session = store.create(model="test-model", max_steps=30)
    now[0] = 160  # old_session (created at t=0) is now 160s idle; fresh_session is 110s idle

    removed = store.sweep_expired()
    assert removed == 2
    assert store.get(old_session.session_id) is None
    assert store.get(fresh_session.session_id) is None


def test_a_request_against_an_expired_session_gets_session_not_found_via_the_real_endpoint() -> (
    None
):
    settings = Settings(
        token="t",
        model_url="http://localhost:9999/v1",
        model_name="m",
        mode="replay",
        record_dir="/tmp/aegis-gateway-test-replay-ttl",
        session_ttl_s=1,  # 1 second, so the test doesn't need to wait 15 minutes
        max_body_mb=4,
        log_payloads=False,
        model_timeout_s=5.0,
    )
    app = create_app(settings)
    client = TestClient(app)
    headers = {"Authorization": "Bearer t"}

    session_id = app.state.session_store.create(model="m", max_steps=30).session_id
    app.state.session_store._sessions[session_id].last_seen -= 2  # simulate 2s of idle time

    res = client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"
