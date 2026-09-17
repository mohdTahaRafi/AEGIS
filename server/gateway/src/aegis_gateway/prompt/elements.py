"""design.md §12.2's compact line format — one line per node, instead of raw JSON, to cut prompt
tokens (metric 5's whole purpose for this format).

    n-7f | textbox | "Aadhaar number" | [220,418,340,40] | required, empty
    n-81 | button  | "Sign in"        | [220,530,120,36]
"""

from __future__ import annotations


def _state_flags(state: dict) -> list[str]:
    flags = []
    if state.get("required"):
        flags.append("required")
    if state.get("disabled"):
        flags.append("disabled")
    if state.get("readonly"):
        flags.append("readonly")
    if state.get("checked") is True:
        flags.append("checked")
    if state.get("occluded"):
        flags.append("occluded")
    has_value = state.get("has_value")
    if has_value is True:
        flags.append("has value")
    elif has_value is False:
        flags.append("empty")
    return flags


def render_element_line(node: dict) -> str:
    box = node["box"]
    parts = [
        node["id"],
        node["role"],
        f'"{node["name"]}"',
        f"[{box[0]:g},{box[1]:g},{box[2]:g},{box[3]:g}]",
    ]
    flags = _state_flags(node.get("state", {}))
    if flags:
        parts.append(", ".join(flags))
    return " | ".join(parts)


def render_elements(nodes: list[dict]) -> str:
    return "\n".join(render_element_line(node) for node in nodes)
