"""design.md §18.2, metric 2 — PII detection. Per-entity precision/recall at the stated IoU
thresholds; macro and micro; separate tables for structured / free-text / visual entities."""

from __future__ import annotations

from dataclasses import dataclass, field

from aegis_eval.scorers.entity_groups import group_of
from aegis_eval.scorers.matching import Detection, GroundTruth, match_detections


@dataclass
class EntityCounts:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    @property
    def precision(self) -> float | None:
        denom = self.tp + self.fp
        return None if denom == 0 else self.tp / denom

    @property
    def recall(self) -> float | None:
        denom = self.tp + self.fn
        return None if denom == 0 else self.tp / denom


@dataclass
class Metric2Result:
    n_screens: int
    per_entity: dict[str, EntityCounts] = field(default_factory=dict)
    per_group: dict[str, EntityCounts] = field(default_factory=dict)

    def macro_precision(self, group: str | None = None) -> float | None:
        entities = self.per_entity if group is None else {e: c for e, c in self.per_entity.items() if group_of(e) == group}
        values = [c.precision for c in entities.values() if c.precision is not None]
        return None if not values else sum(values) / len(values)

    def macro_recall(self, group: str | None = None) -> float | None:
        entities = self.per_entity if group is None else {e: c for e, c in self.per_entity.items() if group_of(e) == group}
        values = [c.recall for c in entities.values() if c.recall is not None]
        return None if not values else sum(values) / len(values)

    def micro_precision(self, group: str | None = None) -> float | None:
        counts = self.per_entity.values() if group is None else (c for e, c in self.per_entity.items() if group_of(e) == group)
        tp = sum(c.tp for c in counts)
        counts = self.per_entity.values() if group is None else (c for e, c in self.per_entity.items() if group_of(e) == group)
        fp = sum(c.fp for c in counts)
        denom = tp + fp
        return None if denom == 0 else tp / denom

    def micro_recall(self, group: str | None = None) -> float | None:
        counts = self.per_entity.values() if group is None else (c for e, c in self.per_entity.items() if group_of(e) == group)
        tp = sum(c.tp for c in counts)
        counts = self.per_entity.values() if group is None else (c for e, c in self.per_entity.items() if group_of(e) == group)
        fn = sum(c.fn for c in counts)
        denom = tp + fn
        return None if denom == 0 else tp / denom


def score_metric2(screens: list[tuple[list[Detection], list[GroundTruth]]]) -> Metric2Result:
    """`screens` is a list of (predicted detections, ground truth) pairs, one per scored screen.
    Ground truth items with entity "NONE" (hard negatives) are excluded here — metric 3 scores
    over-redaction on them separately; metric 2 is about finding real sensitive entities."""
    result = Metric2Result(n_screens=len(screens))

    for detections, ground_truth in screens:
        gt_real = [g for g in ground_truth if g.entity != "NONE"]
        match = match_detections(detections, gt_real, require_same_entity=True)

        for det, gt in match.true_positives:
            result.per_entity.setdefault(gt.entity, EntityCounts()).tp += 1
        for det in match.false_positives:
            result.per_entity.setdefault(det.entity, EntityCounts()).fp += 1
        for gt in match.false_negatives:
            result.per_entity.setdefault(gt.entity, EntityCounts()).fn += 1

    for entity, counts in result.per_entity.items():
        group = group_of(entity)
        group_counts = result.per_group.setdefault(group, EntityCounts())
        group_counts.tp += counts.tp
        group_counts.fp += counts.fp
        group_counts.fn += counts.fn

    return result
