"""design.md §6.6/§12.1 (T-2.39 AC): AEGIS_MODE=record writes keyed responses; AEGIS_MODE=replay
serves them with no GPU present (no `httpx.AsyncClient` call happens at all in replay mode — the
"no GPU" claim is only true if replay never even tries to reach a model server); the demo task
completes identically in both.
"""

from __future__ import annotations

import shutil
import tempfile

import httpx
import pytest
from aegis_gateway.main import create_app
from aegis_gateway.model_client.vllm import VLLMClient
from aegis_gateway.replay.store import ReplayStore, canonical_key
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body


@pytest.fixture
def replay_dir():
    directory = tempfile.mkdtemp(prefix="aegis-gateway-replay-")
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


def test_canonical_key_ignores_client_timing_but_not_task_content() -> None:
    a = sanitized_context_body(client_timing={"observe": 1.0})
    b = sanitized_context_body(client_timing={"observe": 999.0})
    assert canonical_key(a) == canonical_key(b)

    c = sanitized_context_body(task="a different task entirely")
    assert canonical_key(a) != canonical_key(c)


def test_record_then_replay_serves_the_identical_plan_with_no_model_call(
    monkeypatch: pytest.MonkeyPatch, replay_dir: str
) -> None:
    fake_plan = {
        "step_id": "s-1",
        "actions": [
            {"op": "click", "node": "n-2", "expect": {"role": "button", "name": "Sign in"}}
        ],
    }

    async def fake_complete(self, messages):
        return fake_plan

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)

    record_app = create_app(make_settings(mode="record", record_dir=replay_dir))
    record_client = TestClient(record_app)
    headers = {"Authorization": "Bearer test-token"}
    session_id = record_client.post(
        "/v1/sessions", json=session_create_body(), headers=headers
    ).json()["session_id"]

    record_res = record_client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert record_res.status_code == 200
    assert record_res.json() == fake_plan

    # "no GPU present": AsyncClient must never even be constructed in replay mode.
    def fail_if_called(*args, **kwargs):
        raise AssertionError(
            "httpx.AsyncClient must not be used in replay mode — that is the point of replay"
        )

    monkeypatch.setattr(httpx, "AsyncClient", fail_if_called)

    replay_app = create_app(make_settings(mode="replay", record_dir=replay_dir))
    replay_client = TestClient(replay_app)
    replay_session_id = replay_client.post(
        "/v1/sessions", json=session_create_body(), headers=headers
    ).json()["session_id"]

    replay_res = replay_client.post(
        f"/v1/sessions/{replay_session_id}/steps", json=sanitized_context_body(), headers=headers
    )

    assert replay_res.status_code == 200
    assert replay_res.json() == record_res.json()  # "completes identically in both"


def test_replay_lookup_miss_returns_model_unavailable(replay_dir: str) -> None:
    app = create_app(make_settings(mode="replay", record_dir=replay_dir))
    client = TestClient(app)
    headers = {"Authorization": "Bearer test-token"}
    session_id = client.post("/v1/sessions", json=session_create_body(), headers=headers).json()[
        "session_id"
    ]

    res = client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "MODEL_UNAVAILABLE"


def test_is_loaded_reflects_whether_any_recording_exists(replay_dir: str) -> None:
    store = ReplayStore(replay_dir)
    assert store.is_loaded() is False
    store.record(sanitized_context_body(), {"step_id": "s-1", "actions": [{"op": "wait", "ms": 1}]})
    assert store.is_loaded() is True
