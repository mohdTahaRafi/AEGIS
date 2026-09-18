from aegis_eval.scorers.matching import Detection, GroundTruth
from aegis_eval.scorers.metric3 import score_metric3


def test_pixel_precision_is_one_when_redaction_exactly_covers_ground_truth() -> None:
    screens = [([Detection("EMAIL", (0, 0, 10, 10))], [GroundTruth("EMAIL", (0, 0, 10, 10))], 100, 100)]
    result = score_metric3(screens)
    assert result.pixel_precision == 1.0


def test_pixel_precision_drops_when_redaction_overshoots() -> None:
    # Redacted box is 4x the ground-truth area, fully containing it — half the story: precision
    # should be well below 1 since most redacted pixels don't overlap anything sensitive.
    screens = [([Detection("EMAIL", (0, 0, 20, 20))], [GroundTruth("EMAIL", (0, 0, 10, 10))], 100, 100)]
    result = score_metric3(screens)
    assert result.pixel_precision == 0.25


def test_over_redaction_rate_on_hard_negatives() -> None:
    screens = [
        (
            [Detection("AADHAAR", (0, 0, 10, 10))],  # wrongly redacts the first hard negative
            [GroundTruth("NONE", (0, 0, 10, 10)), GroundTruth("NONE", (500, 500, 10, 10))],
            1000,
            1000,
        )
    ]
    result = score_metric3(screens)
    assert result.n_hard_negatives == 2
    assert result.over_redaction_rate == 0.5


def test_zero_over_redaction_when_nothing_touches_a_hard_negative() -> None:
    screens = [([], [GroundTruth("NONE", (0, 0, 10, 10))], 100, 100)]
    result = score_metric3(screens)
    assert result.over_redaction_rate == 0.0


def test_mean_iou_of_matched_boxes() -> None:
    screens = [([Detection("EMAIL", (0, 0, 10, 10))], [GroundTruth("EMAIL", (0, 0, 10, 10))], 100, 100)]
    result = score_metric3(screens)
    assert result.mean_iou == 1.0


def test_no_redaction_at_all_gives_none_pixel_precision_not_a_crash() -> None:
    screens = [([], [GroundTruth("EMAIL", (0, 0, 10, 10))], 100, 100)]
    result = score_metric3(screens)
    assert result.pixel_precision is None
