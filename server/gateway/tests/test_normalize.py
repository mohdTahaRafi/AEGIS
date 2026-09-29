"""R-3 A2: a well-meant model answer becomes the wire plan shape; nothing is invented."""

from __future__ import annotations

import pytest
from aegis_gateway.model_client.normalize import PlanShapeError, normalize_plan


def test_bare_ref_is_wrapped_and_wrapped_ref_untouched() -> None:
    plan = normalize_plan(
        {
            "actions": [
                {"op": "type", "node": "n-1", "ref": "AADHAAR#2"},
                {"op": "type", "node": "n-2", "ref": "⟪PAN#1⟫"},
            ]
        },
        "s-3",
    )
    assert plan["actions"][0]["ref"] == "⟪AADHAAR#2⟫"
    assert plan["actions"][1]["ref"] == "⟪PAN#1⟫"


def test_top_level_action_and_list_are_wrapped() -> None:
    assert normalize_plan({"op": "done"}, "s-1")["actions"] == [{"op": "done"}]
    assert normalize_plan([{"op": "done"}], "s-1")["actions"] == [{"op": "done"}]


def test_server_owns_step_and_plan_id_and_unknown_keys_drop() -> None:
    plan = normalize_plan(
        {"step_id": "step_1", "plan_id": "x", "junk": 1, "actions": [{"op": "done"}]}, "s-4"
    )
    assert plan == {"actions": [{"op": "done"}], "step_id": "s-4", "plan_id": "p-4"}


def test_idempotent() -> None:
    once = normalize_plan({"actions": [{"op": "type", "node": "n-1", "ref": "EMAIL#1"}]}, "s-2")
    assert normalize_plan(once, "s-2") == once


@pytest.mark.parametrize("raw", [None, 3, "x", {"foo": 1}, {"actions": "no"}])
def test_unreadable_output_raises_plan_shape_error(raw: object) -> None:
    with pytest.raises(PlanShapeError):
        normalize_plan(raw, "s-1")
