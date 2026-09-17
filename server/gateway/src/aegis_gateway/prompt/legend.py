"""design.md §4.3/§12.2 — the redaction legend table. Phase 2 never populates `redactions[]`
(phase_2_spine.md §14's forward dependency: no redaction layer exists yet), so this renders
nothing for an empty list rather than an empty table header, which would be a confusing constant
in an otherwise byte-identical-length prompt.
"""

from __future__ import annotations


def render_legend(redactions: list[dict]) -> str:
    if not redactions:
        return "(none)"
    lines = []
    for entry in redactions:
        ref = entry.get("ref") or "(unresolvable)"
        lines.append(f"{ref} | {entry['entity']} | {entry['class']}")
    return "\n".join(lines)
