"""Short element ids for the prompt. The extension's node ids (`n-1i1yvpc8m`) cost ~6 tokens each,
on every element line of every step, against a per-minute token budget the screenshot already
takes almost half of; the model sees `e1`, `e2`, ... instead, numbered in the step's own node
order, and every id it answers with is mapped back before validation. Deterministic per step, so
the corrective retry (built from the same step) uses the same aliases."""

from __future__ import annotations

ALIAS_PATTERN = "^e[0-9]+$"


def node_aliases(step_request: dict) -> dict[str, str]:
    """Real node id -> alias."""
    return {node["id"]: f"e{i}" for i, node in enumerate(step_request.get("nodes", []), start=1)}


def resolve_aliases(plan: object, step_request: dict) -> object:
    """The plan with every aliased `node` replaced by its real id. Anything else (a real id, an
    unknown alias) is left as it is for post-validation to accept or reject."""
    if not isinstance(plan, dict) or not isinstance(plan.get("actions"), list):
        return plan
    real = {alias: node_id for node_id, alias in node_aliases(step_request).items()}
    for action in plan["actions"]:
        if isinstance(action, dict) and isinstance(action.get("node"), str):
            action["node"] = real.get(action["node"], action["node"])
    return plan
