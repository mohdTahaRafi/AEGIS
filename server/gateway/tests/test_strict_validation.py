"""design.md §6.2/§12.1 (T-2.33 AC): an unknown field -> 400 SCHEMA_INVALID naming the field. The
Pydantic models are the Phase-1 generated ones, unmodified — `extra="forbid"` is what makes this
work, not anything this task adds."""

from __future__ import annotations

from aegis_gateway.protocol.action_plan import ActionPlan
from aegis_gateway.protocol.sanitized_context import SanitizedContext
from fastapi.testclient import TestClient

from .conftest import auth_headers as _auth_headers  # noqa: F401 (fixture import for clarity)
from .conftest import sanitized_context_body, session_create_body


def test_unknown_field_on_session_create_is_schema_invalid(client: TestClient) -> None:
    body = session_create_body()
    body["not_a_real_field"] = "gotcha"
    res = client.post("/v1/sessions", json=body, headers={"Authorization": "Bearer test-token"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "SCHEMA_INVALID"
    assert "not_a_real_field" in res.json()["error"]["message"]


def test_unknown_field_on_step_request_is_schema_invalid(client: TestClient) -> None:
    session_res = client.post(
        "/v1/sessions", json=session_create_body(), headers={"Authorization": "Bearer test-token"}
    )
    session_id = session_res.json()["session_id"]

    body = sanitized_context_body()
    body["a_url_field_that_should_not_exist"] = "https://leaked.example.com"
    res = client.post(
        f"/v1/sessions/{session_id}/steps",
        json=body,
        headers={"Authorization": "Bearer test-token"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "SCHEMA_INVALID"
    assert "a_url_field_that_should_not_exist" in res.json()["error"]["message"]


def test_the_generated_models_are_unmodified_and_reject_unknown_fields_directly() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        SanitizedContext.model_validate({**sanitized_context_body(), "extra_field": 1})
    with pytest.raises(ValidationError):
        ActionPlan.model_validate(
            {"step_id": "s-1", "actions": [{"op": "click", "node": "n-1"}], "extra_field": 1}
        )
