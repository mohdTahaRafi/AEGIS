from aegis_eval.scorers.matching import Detection, GroundTruth
from aegis_eval.scorers.metric2 import score_metric2


def test_perfect_detection_gives_precision_and_recall_of_one() -> None:
    screens = [
        (
            [Detection("EMAIL", (0, 0, 10, 10))],
            [GroundTruth("EMAIL", (0, 0, 10, 10))],
        )
    ]
    result = score_metric2(screens)
    assert result.per_entity["EMAIL"].precision == 1.0
    assert result.per_entity["EMAIL"].recall == 1.0


def test_a_missed_entity_counts_as_a_false_negative() -> None:
    screens = [([], [GroundTruth("AADHAAR", (0, 0, 10, 10))])]
    result = score_metric2(screens)
    assert result.per_entity["AADHAAR"].fn == 1
    assert result.per_entity["AADHAAR"].recall == 0.0


def test_a_spurious_detection_counts_as_a_false_positive() -> None:
    screens = [([Detection("PHONE", (0, 0, 10, 10))], [])]
    result = score_metric2(screens)
    assert result.per_entity["PHONE"].fp == 1
    assert result.per_entity["PHONE"].precision == 0.0


def test_hard_negatives_are_excluded_from_metric2() -> None:
    screens = [([Detection("PHONE", (0, 0, 10, 10))], [GroundTruth("NONE", (0, 0, 10, 10))])]
    result = score_metric2(screens)
    # The NONE ground truth is excluded entirely; the detection is a false positive against an
    # empty real-entity ground-truth set.
    assert "NONE" not in result.per_entity
    assert result.per_entity["PHONE"].fp == 1


def test_groups_split_structured_free_text_visual() -> None:
    screens = [
        (
            [Detection("AADHAAR", (0, 0, 10, 10)), Detection("FACE", (20, 20, 10, 10)), Detection("PERSON_NAME", (40, 40, 10, 10))],
            [GroundTruth("AADHAAR", (0, 0, 10, 10)), GroundTruth("FACE", (20, 20, 10, 10)), GroundTruth("PERSON_NAME", (40, 40, 10, 10))],
        )
    ]
    result = score_metric2(screens)
    assert result.per_group["structured"].tp == 1
    assert result.per_group["visual"].tp == 1
    assert result.per_group["free_text"].tp == 1


def test_macro_precision_averages_across_entities_not_instances() -> None:
    # entity A: 1 TP, 1 FP (precision 0.5); entity B: 1 TP, 0 FP (precision 1.0) → macro = 0.75
    screens = [
        (
            [Detection("EMAIL", (0, 0, 10, 10)), Detection("EMAIL", (100, 100, 10, 10)), Detection("PHONE", (200, 200, 10, 10))],
            [GroundTruth("EMAIL", (0, 0, 10, 10)), GroundTruth("PHONE", (200, 200, 10, 10))],
        )
    ]
    result = score_metric2(screens)
    assert result.macro_precision() == 0.75
