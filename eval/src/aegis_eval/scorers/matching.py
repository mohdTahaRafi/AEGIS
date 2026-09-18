"""Shared box-matching utilities for metric 2 (PII detection) and metric 3 (redaction precision) —
design.md §18.2. Greedy, highest-IoU-first matching between predicted and ground-truth boxes,
one-to-one (a predicted box matches at most one ground-truth box and vice versa), which is the
standard, simplest-defensible matching rule for this kind of detection scoring (equivalent in
spirit to COCO-style greedy matching, without the full Hungarian assignment machinery this
project's box counts don't need)."""

from __future__ import annotations

from dataclasses import dataclass

Box = tuple[float, float, float, float]  # (x, y, w, h)


def iou(a: Box, b: Box) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter_w, inter_h = max(0.0, x2 - x1), max(0.0, y2 - y1)
    inter = inter_w * inter_h
    union = aw * ah + bw * bh - inter
    return 0.0 if union <= 0 else inter / union


@dataclass(frozen=True)
class Detection:
    entity: str
    box: Box


@dataclass(frozen=True)
class GroundTruth:
    entity: str
    box: Box


@dataclass(frozen=True)
class MatchResult:
    true_positives: list[tuple[Detection, GroundTruth]]
    false_positives: list[Detection]
    false_negatives: list[GroundTruth]


def iou_threshold_for(entity: str) -> float:
    """design.md §18.2: "IoU ≥ 0.5 (faces ≥ 0.4)"."""
    return 0.4 if entity == "FACE" else 0.5


def match_detections(
    detections: list[Detection],
    ground_truth: list[GroundTruth],
    *,
    require_same_entity: bool = True,
) -> MatchResult:
    """Greedy one-to-one matching: consider every (detection, ground_truth) pair whose IoU meets
    the entity's threshold, sorted by IoU descending, and take a pair as long as neither side has
    already been claimed. `require_same_entity=False` is used by metric 3's pixel/box precision,
    which cares whether the redacted area overlaps ANY sensitive ground truth, not whether the
    entity label matches."""
    candidates: list[tuple[float, int, int]] = []
    for di, det in enumerate(detections):
        for gi, gt in enumerate(ground_truth):
            # UNKNOWN_SENSITIVE (the corpus's canary label — generate_fixtures.py's own
            # `LabelItem("UNKNOWN_SENSITIVE", ..., canary=True)`) deliberately names no specific
            # entity: it exists to test whether SOMETHING flags the value, not whether the client
            # calls it the same thing the corpus does. Found for real running this scorer against
            # the actual corpus for the first time (Phase 5's harness-integration work) — every
            # canary the client caught via the generic high-entropy SECRET fallback was being
            # scored as a false positive AND a separate false negative, a scoring-methodology
            # bug, not a detection one. See docs/HISTORY.md's Phase 5 entry.
            if require_same_entity and det.entity != gt.entity and gt.entity != "UNKNOWN_SENSITIVE":
                continue
            threshold = iou_threshold_for(gt.entity)
            score = iou(det.box, gt.box)
            if score >= threshold:
                candidates.append((score, di, gi))

    candidates.sort(key=lambda c: c[0], reverse=True)
    used_det: set[int] = set()
    used_gt: set[int] = set()
    tps: list[tuple[Detection, GroundTruth]] = []
    for _score, di, gi in candidates:
        if di in used_det or gi in used_gt:
            continue
        used_det.add(di)
        used_gt.add(gi)
        tps.append((detections[di], ground_truth[gi]))

    fps = [d for i, d in enumerate(detections) if i not in used_det]
    fns = [g for i, g in enumerate(ground_truth) if i not in used_gt]
    return MatchResult(true_positives=tps, false_positives=fps, false_negatives=fns)
