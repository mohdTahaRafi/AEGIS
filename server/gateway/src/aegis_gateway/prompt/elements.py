"""design.md §12.2's compact line format — one line per node, instead of raw JSON, to cut prompt
tokens (metric 5's whole purpose for this format).

    e7 | textbox | "Aadhaar number" | [220,418,340,40] | required, empty
    e8 | button  | "Sign in"        | [220,530,120,36]

(`e7`: the prompt alias of the node's real id, see aliases.py.)
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


MAX_NAME_CHARS = 50


def _short(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render_element_line(node: dict, alias: str | None = None) -> str:
    box = node["box"]
    parts = [
        alias or node["id"],
        node["role"],
        f'"{_short(node["name"], MAX_NAME_CHARS)}"',
        f"[{round(box[0])},{round(box[1])},{round(box[2])},{round(box[3])}]",
    ]
    state = dict(node.get("state", {}))
    if not {"type", "select"} & set(node.get("affordances", [])):
        # "has value"/"empty" only mean something on a field.
        state.pop("has_value", None)
    flags = _state_flags(state)
    if flags:
        parts.append(", ".join(flags))
    return " | ".join(parts)


def in_viewport(box: list[float], viewport: dict) -> bool:
    x, y, w, h = box
    return x < viewport["w"] and y < viewport["h"] and x + w > 0 and y + h > 0


# Structural containers: their names concatenate their descendants' text, which the descendants'
# own lines already carry.
_CONTAINER_ROLES = frozenset(
    {
        "banner",
        "navigation",
        "main",
        "complementary",
        "contentinfo",
        "region",
        "search",
        "form",
        "article",
        "list",
        "table",
        "generic",
    }
)


def _contains(outer: list[float], inner: list[float]) -> bool:
    return (
        outer[0] <= inner[0] + 1
        and outer[1] <= inner[1] + 1
        and outer[0] + outer[2] >= inner[0] + inner[2] - 1
        and outer[1] + outer[3] >= inner[1] + inner[3] - 1
        and outer[2] * outer[3] > inner[2] * inner[3] * 1.2
    )


def _is_noise(node: dict, nodes: list[dict]) -> bool:
    """Lines that cost tokens and tell the model nothing it can act on or read: a 1-px helper, an
    unnamed decorative picture, a non-interactive wrapper repeating an element's own name at the
    same place, a container whose name is just its children's text."""
    if node.get("affordances"):
        return False
    box = node["box"]
    name = node.get("name", "").strip()
    if box[2] * box[3] < 16:
        return True
    if not name:
        return (
            node.get("role") in ("img", "generic", "none", "presentation")
            or node.get("role") in _CONTAINER_ROLES
        )
    for other in nodes:
        other_name = other.get("name", "").strip()
        if other is node or not (
            other_name == name or (other.get("affordances") and name in other_name)
        ):
            continue
        ob = other["box"]
        overlap_x = min(box[0] + box[2], ob[0] + ob[2]) - max(box[0], ob[0])
        overlap_y = min(box[1] + box[3], ob[1] + ob[3]) - max(box[1], ob[1])
        if (
            overlap_x > 0
            and overlap_y > 0
            and (other.get("affordances") or other.get("role") != "generic")
        ):
            return True
    if node.get("role") in _CONTAINER_ROLES and node.get("role") != "generic" and len(name) > 40:
        inside = sum(1 for other in nodes if other is not node and _contains(box, other["box"]))
        if inside >= 2:
            return True
    return False


def select_elements(nodes: list[dict], viewport: dict, limit: int) -> list[dict]:
    """Real pages carry hundreds of nodes; the model's per-minute token budget does not. Noise
    lines are dropped first (`_is_noise`); the rest are kept, in page order within each tier:
    interactive in view, other in view, interactive but covered by something else (a closed
    menu's links: not on the screenshot), interactive off-screen."""
    nodes = [n for n in nodes if not _is_noise(n, nodes)]

    def tier(node: dict) -> int:
        visible = in_viewport(node["box"], viewport)
        interactive = bool(node.get("affordances"))
        occluded = bool(node.get("state", {}).get("occluded"))
        if visible and not occluded:
            return 0 if interactive else 1
        if interactive:
            return 2 if visible else 3
        return 4

    ranked = sorted(
        (n for n in nodes if tier(n) < 4), key=lambda n: tier(n)
    )  # stable: page order kept within a tier
    keep = {id(n) for n in ranked[:limit]}
    return [n for n in nodes if id(n) in keep]


def render_elements(
    nodes: list[dict],
    viewport: dict | None = None,
    limit: int | None = None,
    aliases: dict[str, str] | None = None,
) -> str:
    shown = nodes if viewport is None or limit is None else select_elements(nodes, viewport, limit)
    lines = [render_element_line(node, (aliases or {}).get(node["id"])) for node in shown]
    if len(shown) < len(nodes):
        lines.append(f"({len(nodes) - len(shown)} more elements off-screen or not shown)")
    return "\n".join(lines)
