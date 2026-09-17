"""T-2.47 (gateway half) — the app is genuinely servable over a real socket by a real uvicorn
process, not only reachable through `TestClient`'s in-process ASGI transport (which every other
test in this suite uses). This is what `apps/extension`'s `fetch()`-based egress client actually
needs to be true: a real HTTP server a real browser tab can reach.

What this does NOT prove: the live-model path (no GPU in this environment; OQ-13 is still open)
or driving the actual loaded extension's side panel UI end-to-end. Those gaps are recorded in
docs/HISTORY.md. What it does prove, for real: `docker-compose.replay.yml`'s exact command
(`uvicorn aegis_gateway.main:app`) boots, serves `/healthz`, and completes a full session-open ->
step -> session-close cycle against a pre-seeded replay store, entirely without a model server —
the actual demo-reliability path phase_2_spine.md §6.6 exists for.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from aegis_gateway.protocol.sanitized_context import SanitizedContext
from aegis_gateway.replay.store import canonical_key

from .conftest import sanitized_context_body, session_create_body

GATEWAY_ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def running_gateway(tmp_path):
    port = _free_port()
    record_dir = tmp_path / "replay-store"
    record_dir.mkdir()

    # Seed the replay store directly (canonical_key is deterministic and pure — no need to run a
    # live model to produce a fixture recording). Hashed from the *parsed-and-re-serialized*
    # shape, matching exactly what the real route hashes internally (routes_steps.py dumps the
    # validated Pydantic model, not the raw request dict — Pydantic fills in declared-but-omitted
    # fields such as `removed`/`image` as explicit `null`s, which changes the JSON and therefore
    # the hash).
    step_body = sanitized_context_body()
    canonical_step_body = SanitizedContext.model_validate(step_body).model_dump(
        by_alias=True, mode="json"
    )
    plan = {"step_id": "s-1", "actions": [{"op": "wait", "ms": 100}]}
    (record_dir / f"{canonical_key(canonical_step_body)}.json").write_text(json.dumps(plan))

    env = {
        "AEGIS_MODE": "replay",
        "AEGIS_TOKEN": "e2e-token",
        "AEGIS_RECORD_DIR": str(record_dir),
        "PATH": "/usr/bin:/bin",
    }
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "aegis_gateway.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=GATEWAY_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        base_url = f"http://127.0.0.1:{port}"
        deadline = time.time() + 10
        last_error: Exception | None = None
        while time.time() < deadline:
            try:
                httpx.get(f"{base_url}/healthz", timeout=0.5).raise_for_status()
                break
            except httpx.HTTPError as exc:
                last_error = exc
                time.sleep(0.1)
        else:
            output = proc.stdout.read().decode() if proc.stdout else ""
            raise RuntimeError(f"gateway subprocess never became healthy: {last_error}\n{output}")
        yield base_url, step_body
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_real_subprocess_serves_healthz(running_gateway) -> None:
    base_url, _ = running_gateway
    res = httpx.get(f"{base_url}/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_real_subprocess_completes_a_full_session_step_close_cycle_in_replay_mode(
    running_gateway,
) -> None:
    base_url, step_body = running_gateway
    headers = {"Authorization": "Bearer e2e-token"}

    created = httpx.post(f"{base_url}/v1/sessions", json=session_create_body(), headers=headers)
    assert created.status_code == 201
    session_id = created.json()["session_id"]

    step_res = httpx.post(
        f"{base_url}/v1/sessions/{session_id}/steps", json=step_body, headers=headers
    )
    assert step_res.status_code == 200
    assert step_res.json() == {"step_id": "s-1", "actions": [{"op": "wait", "ms": 100}]}
    assert "Server-Timing" in step_res.headers
    assert "X-Request-Id" in step_res.headers

    closed = httpx.delete(f"{base_url}/v1/sessions/{session_id}", headers=headers)
    assert closed.status_code == 204
