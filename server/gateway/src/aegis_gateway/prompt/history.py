"""design.md §12.2 — history windowed to the last K steps (initial K=5). The client already
windows to ≤5 before sending (apps/extension's context builder), so this re-applies the same
bound server-side rather than trusting the client did — the server is the one place both ends of
the contract are enforced.
"""

from __future__ import annotations

HISTORY_WINDOW = 5


def window_history(history: list[dict]) -> list[dict]:
    return history[-HISTORY_WINDOW:]


def render_history(history: list[dict]) -> str:
    windowed = window_history(history)
    if not windowed:
        return "(none)"
    lines = []
    for entry in windowed:
        ops = ", ".join(a.get("op", "?") for a in entry.get("actions", []))
        lines.append(f"{entry['step_id']}: {ops} -> {entry['outcome']}")
    return "\n".join(lines)
