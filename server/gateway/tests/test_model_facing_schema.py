"""R-3 A3: the model sees bare refs and no server-owned ids; the wire schema is unchanged."""

from __future__ import annotations

import json

from aegis_gateway.model_client.vllm import load_action_plan_schema, load_model_facing_schema


def test_model_schema_uses_bare_refs_and_omits_server_ids() -> None:
    model = load_model_facing_schema()
    text = json.dumps(model, ensure_ascii=False)
    assert "⟪" not in text and "^[A-Z_]+#[0-9]+$" in text
    assert "step_id" not in model["properties"] and "plan_id" not in model["properties"]
    assert model["required"] == ["actions"]


def test_wire_schema_is_unchanged() -> None:
    wire = load_action_plan_schema()
    assert "step_id" in wire["required"]
    assert "⟪" in json.dumps(wire, ensure_ascii=False)
