"""design.md §4.1 (T-2.40 AC): the client decomposes queue/prompt/model/validate from
`Server-Timing` and shows the model's share in the timeline."""

from __future__ import annotations

import pytest
from aegis_gateway.model_client.vllm import VLLMClient
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body


def test_server_timing_header_decomposes_queue_prompt_model_validate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_complete(self, messages, route=None, pooled=False):
        return {"step_id": "s-1", "actions": [{"op": "wait", "ms": 100}]}

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)

    from aegis_gateway.main import create_app

    app = create_app(make_settings(mode="live"))
    client = TestClient(app)
    headers = {"Authorization": "Bearer test-token"}
    session_id = client.post("/v1/sessions", json=session_create_body(), headers=headers).json()[
        "session_id"
    ]

    res = client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )
    assert res.status_code == 200

    server_timing = res.headers["Server-Timing"]
    components = {part.split(";")[0].strip() for part in server_timing.split(",")}
    assert components == {"queue", "prompt", "model", "validate"}
    for part in server_timing.split(","):
        name, _, dur = part.strip().partition(";dur=")
        assert float(dur) >= 0.0
