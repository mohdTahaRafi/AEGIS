"""design.md §12.2 — assembles the system + user messages for one step. The system message is
always the exact same string (system.SYSTEM_PROMPT); everything per-request lives in the user
message, built from the pieces in elements/legend/history.
"""

from __future__ import annotations

from .elements import render_elements
from .history import render_history
from .legend import render_legend
from .system import SYSTEM_PROMPT

__all__ = ["SYSTEM_PROMPT", "build_messages"]


def build_user_message(step_request: dict) -> str:
    viewport = step_request["viewport"]
    text_runs = "\n".join(f'{t["id"]}: "{t["text"]}"' for t in step_request.get("text", []))
    return (
        f"TASK: {step_request['task']}\n"
        f"HISTORY: {render_history(step_request.get('history', []))}\n"
        f"VIEWPORT: {viewport['w']}x{viewport['h']}, scroll_y={viewport['scroll_y']}\n"
        f"REDACTIONS: {render_legend(step_request.get('redactions', []))}\n"
        f"ELEMENTS:\n{render_elements(step_request.get('nodes', []))}\n"
        f"TEXT: {text_runs or '(none)'}"
    )


def build_messages(step_request: dict) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_message(step_request)},
    ]
