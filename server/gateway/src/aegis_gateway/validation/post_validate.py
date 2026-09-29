"""design.md §12.3 (T-2.38) — post-validation of a plan against what was actually sent this
session. Defence in depth, not the defence: the client re-validates everything independently
(phase_2_spine.md §5), because the server itself is untrusted infrastructure in this design too
(a compromised or buggy model server should not be able to make the client do something the
context it was actually shown does not support).
"""

from __future__ import annotations

import re

from ..sessions.store import Session, text_digest

PLACEHOLDER_PATTERN = re.compile(r"⟪[A-Z_]+#[0-9]+⟫")


class PostValidationError(Exception):
    pass


def _point_in_region(x: float, y: float, region: list[float]) -> bool:
    rx, ry, rw, rh = region
    return rx <= x <= rx + rw and ry <= y <= ry + rh


def validate_plan_against_session(plan: dict, session: Session) -> None:
    """Raises `PostValidationError` with a short, specific message on the first violation."""
    for action in plan.get("actions", []):
        op = action.get("op")

        node_id = action.get("node")
        if node_id is not None and node_id not in session.sent_node_ids:
            raise PostValidationError(
                f"node {node_id!r} was not sent this session (or has since been removed)"
            )

        if op == "type":
            ref = action.get("ref")
            text = action.get("text")
            if ref is not None:
                if ref not in session.sent_refs:
                    raise PostValidationError(f"ref {ref!r} was not sent this session")
                if "type" not in session.node_affordances.get(node_id, []):
                    raise PostValidationError(
                        f"node {node_id!r} does not have the 'type' affordance"
                    )
            if text is not None and PLACEHOLDER_PATTERN.search(text):
                raise PostValidationError("type.text must not contain a placeholder string")
            if (
                text is not None
                and session.node_has_value.get(node_id)
                and session.typed_digest.get(node_id) == text_digest(text)
            ):
                raise PostValidationError(
                    "this exact text was already typed into that field in an earlier step and the "
                    "field still holds it: do not type it again; do the next thing the TASK needs "
                    "(e.g. click the send/submit button) or finish with done"
                )

        if op == "select":
            option = action.get("option", "")
            if PLACEHOLDER_PATTERN.search(option):
                raise PostValidationError("select.option must not contain a placeholder string")

        if op == "click_point":
            x, y = action["x"], action["y"]
            matched = False
            for region, viewport_w, viewport_h in session.recent_image_regions:
                if 0 <= x <= viewport_w and 0 <= y <= viewport_h and _point_in_region(x, y, region):
                    matched = True
                    break
            if not matched:
                raise PostValidationError(
                    "click_point does not lie within an image region sent in the last two steps"
                )
