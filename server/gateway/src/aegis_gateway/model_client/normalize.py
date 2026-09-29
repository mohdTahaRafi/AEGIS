"""Turns a well-meant model answer into the wire plan shape before validation. It never invents a
node id, a ref or an op; post-validation still rejects anything the session didn't send."""

from __future__ import annotations

import re

from ..validation.post_validate import PostValidationError

BARE_REF = re.compile(r"^[A-Z_]+#[0-9]+$")
MODEL_KEYS = ("actions", "risk_hint", "stop_if", "note")


class PlanShapeError(PostValidationError):
    """Raised when the output can't be read as a plan at all. A PostValidationError subclass, so
    the route's one-retry path handles it like any other invalid plan."""


def normalize_plan(raw: object, step_id: str) -> dict:
    if isinstance(raw, list):
        raw = {"actions": raw}
    elif isinstance(raw, dict) and "op" in raw and "actions" not in raw:
        raw = {"actions": [raw]}
    if not isinstance(raw, dict) or not isinstance(raw.get("actions"), list):
        raise PlanShapeError("model output has no 'actions' list")
    plan: dict = {key: raw[key] for key in MODEL_KEYS if key in raw}
    plan["step_id"] = step_id
    plan["plan_id"] = f"p-{step_id.removeprefix('s-')}"
    for action in plan["actions"]:
        if isinstance(action, dict):
            ref = action.get("ref")
            if isinstance(ref, str) and BARE_REF.match(ref):
                action["ref"] = f"⟪{ref}⟫"
            if action.get("op") == "stop":
                _normalize_stop(action)
    return plan


STOP_REASONS = ("captcha", "blocked", "cannot_proceed", "unsafe")
STOP_DETAIL_MAX = 200


def _normalize_stop(action: dict) -> None:
    """`stop` ends the task and touches nothing, so a free-text reason ("no username given") or an
    over-long detail is kept as the detail rather than failing the whole plan."""
    reason = action.get("reason")
    if reason not in STOP_REASONS:
        if isinstance(reason, str) and reason and not action.get("detail"):
            action["detail"] = reason
        action["reason"] = "cannot_proceed"
    detail = action.get("detail")
    if detail is not None:
        if isinstance(detail, str) and detail.strip():
            action["detail"] = detail.strip()[:STOP_DETAIL_MAX]
        else:
            del action["detail"]
