"""design.md §18.2, metric 1 — visual context accuracy. OQ-4 leaves its definition ambiguous, so
both readings are computed and reported, never just one:

  Primary   ([SS]'s definition): task success rate with sanitized context ÷ task success rate
            with RAW context, on the same tasks and the same model.
  Secondary (OQ-4's other reading): element-level agreement between the sent graph (roles, names,
            boxes) and ground truth, plus screen-state label accuracy.

Both functions here are pure aggregation/comparison logic, fully testable without a live model —
what they're FED (real task-success outcomes from two live-model runs; a ground-truth screen graph
per corpus screen) is not something this sandboxed, GPU-less environment can produce. See
`docs/CURRENT_BUILD.md`/OQ-13 and OQ-4's own "reported, not resolved" status.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PrimaryReading:
    n_tasks: int
    sanitized_success_rate: float
    raw_success_rate: float
    ratio: float | None  # None when raw_success_rate is 0 — a ratio would be undefined, not "1.0"


def score_primary(sanitized_outcomes: list[bool], raw_outcomes: list[bool]) -> PrimaryReading:
    """`sanitized_outcomes[i]`/`raw_outcomes[i]` are the pass/fail result of the SAME task i, run
    once against sanitized context and once against raw context (design.md's requirement that the
    comparison is same tasks, same model)."""
    if len(sanitized_outcomes) != len(raw_outcomes):
        raise ValueError("sanitized and raw outcome lists must cover the same tasks 1:1")
    n = len(sanitized_outcomes)
    sanitized_rate = sum(sanitized_outcomes) / n if n else 0.0
    raw_rate = sum(raw_outcomes) / n if n else 0.0
    ratio = None if raw_rate == 0 else sanitized_rate / raw_rate
    return PrimaryReading(n_tasks=n, sanitized_success_rate=sanitized_rate, raw_success_rate=raw_rate, ratio=ratio)


@dataclass(frozen=True)
class GraphNode:
    role: str
    name: str
    box: tuple[float, float, float, float]


@dataclass
class SecondaryReading:
    n_screens: int
    element_agreement: float | None
    screen_label_accuracy: float | None


def _node_matches(a: GraphNode, b: GraphNode, iou_threshold: float = 0.5) -> bool:
    if a.role != b.role or a.name != b.name:
        return False
    from aegis_eval.scorers.matching import iou

    return iou(a.box, b.box) >= iou_threshold


def score_element_agreement(sent: list[GraphNode], ground_truth: list[GraphNode]) -> float | None:
    """Fraction of ground-truth nodes that have a matching sent node (same role, same name,
    IoU ≥ 0.5) — a coarse but real agreement score. Requires a ground-truth screen graph per
    corpus screen, which `eval/labels/*.json`'s schema does not currently define (it labels PII
    items, not full accessibility trees) — a forward dependency, not a bug in this function."""
    if not ground_truth:
        return None
    matched = 0
    used_sent = set()
    for gt in ground_truth:
        for i, s in enumerate(sent):
            if i in used_sent:
                continue
            if _node_matches(s, gt):
                used_sent.add(i)
                matched += 1
                break
    return matched / len(ground_truth)


def score_screen_label_accuracy(predicted: list[str | None], ground_truth: list[str]) -> float | None:
    """Fraction of screens where the predicted screen-state label matches the ground-truth label.
    `predicted[i]` is None when the ViT screen-label call returned nothing (Phase 4's disclosed
    no-op, `perception/models/vit-encoder.ts`) — counted as a miss, not excluded, since "no label
    produced" is a real accuracy failure, not a missing data point to skip."""
    if len(predicted) != len(ground_truth) or not ground_truth:
        return None
    correct = sum(1 for p, g in zip(predicted, ground_truth) if p == g)
    return correct / len(ground_truth)
