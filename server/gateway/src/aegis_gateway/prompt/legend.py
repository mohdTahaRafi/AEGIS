"""design.md §4.3/§12.2 — the redaction legend. One line per redaction. With an image attached,
each line also carries the redaction's first box, so the model can match a black box in the image
to its placeholder."""

from __future__ import annotations


def _box(box: list[float]) -> str:
    return f"[{box[0]:g},{box[1]:g},{box[2]:g},{box[3]:g}]"


def render_legend(redactions: list[dict], *, with_boxes: bool = False) -> str:
    if not redactions:
        return "(none)"
    lines = []
    for entry in redactions:
        ref = entry.get("ref") or "(unresolvable)"
        line = f"{ref} | {entry['entity']} | {entry['class']}"
        boxes = entry.get("boxes") or []
        if with_boxes and boxes:
            line += f" | {_box(boxes[0])}"
        lines.append(line)
    return "\n".join(lines)
