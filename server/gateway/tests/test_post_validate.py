"""design.md §12.3 (T-2.38 AC): each rule has a direct unit test, plus an end-to-end test that a
plan referencing an unsent node id retries once then returns 422 (AC-5)."""

from __future__ import annotations

import pytest
from aegis_gateway.sessions.store import Session
from aegis_gateway.validation.post_validate import (
    PostValidationError,
    validate_plan_against_session,
)
from fastapi.testclient import TestClient

from .conftest import make_settings, sanitized_context_body, session_create_body


def make_session(**overrides) -> Session:
    session = Session(session_id="s", model="m", max_steps=30, last_seen=0.0)
    session.sent_node_ids = overrides.get("sent_node_ids", {"n-1", "n-2"})
    session.node_affordances = overrides.get(
        "node_affordances", {"n-1": ["click", "type"], "n-2": ["click"]}
    )
    session.sent_refs = overrides.get("sent_refs", {"⟪AADHAAR#2⟫"})
    session.recent_image_regions = overrides.get(
        "recent_image_regions", [([100, 100, 50, 50], 1280, 720)]
    )
    return session


def test_every_node_must_exist_in_the_union_of_sent_nodes_and_not_be_removed() -> None:
    session = make_session()
    validate_plan_against_session({"actions": [{"op": "click", "node": "n-1"}]}, session)  # ok
    with pytest.raises(PostValidationError, match="was not sent"):
        validate_plan_against_session({"actions": [{"op": "click", "node": "n-99"}]}, session)


def test_every_ref_must_exist_in_sent_redactions() -> None:
    session = make_session()
    validate_plan_against_session(
        {"actions": [{"op": "type", "node": "n-1", "ref": "⟪AADHAAR#2⟫"}]}, session
    )
    with pytest.raises(PostValidationError, match="was not sent"):
        validate_plan_against_session(
            {"actions": [{"op": "type", "node": "n-1", "ref": "⟪PASSWORD#9⟫"}]}, session
        )


def test_type_with_ref_requires_the_type_affordance() -> None:
    session = make_session()
    with pytest.raises(PostValidationError, match="affordance"):
        validate_plan_against_session(
            {"actions": [{"op": "type", "node": "n-2", "ref": "⟪AADHAAR#2⟫"}]}, session
        )


def test_click_point_must_lie_within_the_viewport_and_a_recent_image_region() -> None:
    session = make_session()
    validate_plan_against_session(
        {"actions": [{"op": "click_point", "x": 110, "y": 110, "label": "x"}]}, session
    )
    with pytest.raises(PostValidationError, match="image region"):
        validate_plan_against_session(
            {"actions": [{"op": "click_point", "x": 900, "y": 900, "label": "x"}]}, session
        )


def test_a_placeholder_in_type_text_is_rejected() -> None:
    session = make_session()
    with pytest.raises(PostValidationError, match="placeholder"):
        validate_plan_against_session(
            {"actions": [{"op": "type", "node": "n-1", "text": "⟪AADHAAR#2⟫"}]}, session
        )


def test_a_placeholder_in_select_option_is_rejected() -> None:
    session = make_session()
    with pytest.raises(PostValidationError, match="placeholder"):
        validate_plan_against_session(
            {"actions": [{"op": "select", "node": "n-1", "option": "⟪AADHAAR#2⟫"}]}, session
        )


def test_a_plan_referencing_an_unsent_node_id_retries_once_then_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_settings = make_settings(mode="live")
    from aegis_gateway.main import create_app

    app = create_app(app_settings)
    client = TestClient(app)
    headers = {"Authorization": "Bearer test-token"}

    session_res = client.post("/v1/sessions", json=session_create_body(), headers=headers)
    session_id = session_res.json()["session_id"]

    call_count = {"n": 0}

    async def fake_complete(self, messages):
        call_count["n"] += 1
        # always references a node id that was never sent, however many times it's asked
        return {"step_id": "s-1", "actions": [{"op": "click", "node": "n-never-sent"}]}

    from aegis_gateway.model_client.vllm import VLLMClient

    monkeypatch.setattr(VLLMClient, "complete", fake_complete)

    res = client.post(
        f"/v1/sessions/{session_id}/steps", json=sanitized_context_body(), headers=headers
    )

    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PLAN_INVALID"
    assert call_count["n"] == 2  # exactly one retry, per design.md §12.3: "one retry ... then 422"
