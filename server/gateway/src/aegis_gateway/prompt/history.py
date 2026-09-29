"""design.md §12.2 — history windowed to the last K steps (initial K=5). The client already
windows to ≤5 before sending (apps/extension's context builder), so this re-applies the same
bound server-side rather than trusting the client did — the server is the one place both ends of
the contract are enforced.
"""

from __future__ import annotations

HISTORY_WINDOW = 5


def window_history(history: list[dict]) -> list[dict]:
    return history[-HISTORY_WINDOW:]


def _render_action(action: dict, aliases: dict[str, str]) -> str:
    op = action.get("op", "?")
    node = action.get("node")
    # The element by this step's alias when it is still listed: the model can see what it already
    # typed where (without it, a filled box looked untouched and the same reply was typed again).
    return f"{op} {aliases[node]}" if isinstance(node, str) and node in aliases else op


def render_history(history: list[dict], aliases: dict[str, str] | None = None) -> str:
    windowed = window_history(history)
    if not windowed:
        return "(none)"
    lines = []
    for entry in windowed:
        ops = ", ".join(_render_action(a, aliases or {}) for a in entry.get("actions", []))
        lines.append(f"{entry['step_id']}: {ops} -> {entry['outcome']}")
    return "\n".join(lines)
