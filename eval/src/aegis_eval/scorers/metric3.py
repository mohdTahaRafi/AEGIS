"""design.md §18.2, metric 3 — redaction precision: (a) pixel precision = redacted pixels
overlapping ground-truth sensitive boxes ÷ all redacted pixels; (b) over-redaction rate on hard
negatives; (c) mean IoU of matched boxes."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from aegis_eval.scorers.matching import Box, Detection, GroundTruth, iou, match_detections

# design.md's over-redaction question is binary ("was this hard negative redacted at all") —
# any appreciable overlap between a redaction box and a hard-negative's box counts, since even a
# partial box drawn over a hard negative is a false alarm the user would see.
OVER_REDACTION_IOU_THRESHOLD = 0.1


def _rasterize(boxes: list[Box], width: int, height: int) -> np.ndarray:
    mask = np.zeros((height, width), dtype=bool)
    for x, y, w, h in boxes:
        x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
        x1, y1 = min(width, int(round(x + w))), min(height, int(round(y + h)))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = True
    return mask


@dataclass
class Metric3Result:
    n_screens: int
    pixel_precision: float | None
    over_redaction_rate: float | None
    mean_iou: float | None
    n_hard_negatives: int
    n_redacted_pixels_total: int
    n_overlapping_pixels_total: int


def score_metric3(
    screens: list[tuple[list[Detection], list[GroundTruth], int, int]],
) -> Metric3Result:
    """`screens` is a list of (predicted detections, ground truth, viewport_w, viewport_h). Ground
    truth includes both real sensitive items and entity="NONE" hard negatives."""
    total_redacted_px = 0
    total_overlap_px = 0
    hard_negative_total = 0
    hard_negative_redacted = 0
    all_ious: list[float] = []

    for detections, ground_truth, width, height in screens:
        gt_real = [g for g in ground_truth if g.entity != "NONE"]
        gt_hard_neg = [g for g in ground_truth if g.entity == "NONE"]

        det_boxes = [d.box for d in detections]
        gt_boxes = [g.box for g in gt_real]

        det_mask = _rasterize(det_boxes, width, height)
        gt_mask = _rasterize(gt_boxes, width, height)

        total_redacted_px += int(det_mask.sum())
        total_overlap_px += int((det_mask & gt_mask).sum())

        for hard_neg in gt_hard_neg:
            hard_negative_total += 1
            if any(iou(d.box, hard_neg.box) >= OVER_REDACTION_IOU_THRESHOLD for d in detections):
                hard_negative_redacted += 1

        match = match_detections(detections, gt_real, require_same_entity=True)
        for det, gt in match.true_positives:
            all_ious.append(iou(det.box, gt.box))

    pixel_precision = None if total_redacted_px == 0 else total_overlap_px / total_redacted_px
    over_redaction_rate = None if hard_negative_total == 0 else hard_negative_redacted / hard_negative_total
    mean_iou = None if not all_ious else sum(all_ious) / len(all_ious)

    return Metric3Result(
        n_screens=len(screens),
        pixel_precision=pixel_precision,
        over_redaction_rate=over_redaction_rate,
        mean_iou=mean_iou,
        n_hard_negatives=hard_negative_total,
        n_redacted_pixels_total=total_redacted_px,
        n_overlapping_pixels_total=total_overlap_px,
    )
