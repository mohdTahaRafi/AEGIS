"""design.md's NFR-15 / T-5.13 — "the scoreboard has a failures section: what the system got
wrong, per category, with examples — not only aggregate success rates." Aggregate numbers can hide
exactly the failure mode a judge asks about; this renders concrete per-screen examples of misses,
false alarms and over-redactions."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FailureExample:
    screen_id: str
    category: str  # "missed_detection" | "false_positive" | "over_redacted_hard_negative" | "leak"
    entity: str | None
    detail: str


def render_failures(examples: list[FailureExample], max_per_category: int = 5) -> list[str]:
    if not examples:
        return ["No failures recorded in this run."]

    by_category: dict[str, list[FailureExample]] = {}
    for ex in examples:
        by_category.setdefault(ex.category, []).append(ex)

    lines: list[str] = []
    category_labels = {
        "missed_detection": "Missed detections (false negatives)",
        "false_positive": "False alarms (false positives)",
        "over_redacted_hard_negative": "Over-redacted hard negatives",
        "leak": "Leaks (auditor-recovered values)",
    }
    for category, label in category_labels.items():
        items = by_category.get(category, [])
        if not items:
            continue
        lines.append(f"**{label}** — n={len(items)}")
        for ex in items[:max_per_category]:
            entity_part = f" ({ex.entity})" if ex.entity else ""
            lines.append(f"- `{ex.screen_id}`{entity_part}: {ex.detail}")
        if len(items) > max_per_category:
            lines.append(f"- … and {len(items) - max_per_category} more")
        lines.append("")

    return lines
