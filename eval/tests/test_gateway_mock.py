"""phase_5_measurement.md §16a — the in-process mock gateway's dispatch logic, tested with fake
Playwright Route/Request objects (no real browser needed for this pure routing decision)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from aegis_eval.runner.gateway_mock import MockGateway


@dataclass
class FakeRequest:
    url: str
    method: str
    post_data: str | None = None


@dataclass
class FakeRoute:
    request: FakeRequest
    fulfilled: dict | None = None

    def fulfill(self, status: int, content_type: str | None = None, body: str | None = None) -> None:
        self.fulfilled = {"status": status, "content_type": content_type, "body": body}


def test_open_session_returns_a_session_id() -> None:
    gw = MockGateway()
    route = FakeRoute(FakeRequest(url="http://localhost:8787/v1/sessions", method="POST"))
    gw._handle(route)
    assert route.fulfilled["status"] == 201
    body = json.loads(route.fulfilled["body"])
    assert "session_id" in body
    assert body["limits"]["max_steps"] == 30


def test_close_session_returns_204() -> None:
    gw = MockGateway()
    route = FakeRoute(FakeRequest(url="http://localhost:8787/v1/sessions/abc-123", method="DELETE"))
    gw._handle(route)
    assert route.fulfilled["status"] == 204


def test_step_request_is_captured_and_a_valid_plan_returned() -> None:
    gw = MockGateway()
    body = json.dumps({"step_id": "s-1", "task": "do something"})
    route = FakeRoute(FakeRequest(url="http://localhost:8787/v1/sessions/abc-123/steps", method="POST", post_data=body))
    gw._handle(route)

    assert route.fulfilled["status"] == 200
    plan = json.loads(route.fulfilled["body"])
    assert plan["step_id"] == "s-1"
    assert len(plan["actions"]) >= 1

    assert len(gw.captured_steps) == 1
    captured = gw.captured_steps[0]
    assert captured.session_id == "abc-123"
    assert captured.request_body["task"] == "do something"


def test_multiple_steps_all_captured_in_order() -> None:
    gw = MockGateway()
    for i in range(3):
        body = json.dumps({"step_id": f"s-{i}"})
        route = FakeRoute(FakeRequest(url="http://localhost:8787/v1/sessions/x/steps", method="POST", post_data=body))
        gw._handle(route)
    assert [s.request_body["step_id"] for s in gw.captured_steps] == ["s-0", "s-1", "s-2"]
