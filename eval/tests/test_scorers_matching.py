from aegis_eval.scorers.matching import Detection, GroundTruth, iou, iou_threshold_for, match_detections


def test_iou_of_identical_boxes_is_one() -> None:
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0


def test_iou_of_disjoint_boxes_is_zero() -> None:
    assert iou((0, 0, 10, 10), (100, 100, 10, 10)) == 0.0


def test_face_threshold_is_lower_than_default() -> None:
    assert iou_threshold_for("FACE") == 0.4
    assert iou_threshold_for("AADHAAR") == 0.5


def test_match_detections_pairs_overlapping_same_entity_boxes() -> None:
    dets = [Detection("AADHAAR", (0, 0, 10, 10))]
    gts = [GroundTruth("AADHAAR", (1, 1, 10, 10))]
    result = match_detections(dets, gts)
    assert len(result.true_positives) == 1
    assert result.false_positives == []
    assert result.false_negatives == []


def test_match_detections_does_not_match_across_entities() -> None:
    dets = [Detection("EMAIL", (0, 0, 10, 10))]
    gts = [GroundTruth("PHONE", (0, 0, 10, 10))]
    result = match_detections(dets, gts, require_same_entity=True)
    assert result.true_positives == []
    assert len(result.false_positives) == 1
    assert len(result.false_negatives) == 1


def test_match_detections_ignores_entity_when_asked() -> None:
    dets = [Detection("EMAIL", (0, 0, 10, 10))]
    gts = [GroundTruth("PHONE", (0, 0, 10, 10))]
    result = match_detections(dets, gts, require_same_entity=False)
    assert len(result.true_positives) == 1


def test_unknown_sensitive_ground_truth_matches_any_detected_entity() -> None:
    # A canary's ground truth deliberately names no specific entity — any real detection at the
    # same location (whatever the client happened to call it) counts as a match.
    dets = [Detection("SECRET", (0, 0, 10, 10))]
    gts = [GroundTruth("UNKNOWN_SENSITIVE", (0, 0, 10, 10))]
    result = match_detections(dets, gts)
    assert len(result.true_positives) == 1
    assert result.false_positives == []
    assert result.false_negatives == []


def test_match_detections_is_one_to_one_greedy_by_iou() -> None:
    # Two ground truths overlap one detection; the detection should match only the closer one.
    dets = [Detection("EMAIL", (0, 0, 10, 10))]
    gts = [GroundTruth("EMAIL", (0, 0, 10, 10)), GroundTruth("EMAIL", (2, 2, 10, 10))]
    result = match_detections(dets, gts)
    assert len(result.true_positives) == 1
    assert len(result.false_negatives) == 1
