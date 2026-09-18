import pytest

from aegis_eval.scorers.metric1 import GraphNode, score_element_agreement, score_primary, score_screen_label_accuracy


def test_primary_ratio_of_equal_success_rates_is_one() -> None:
    reading = score_primary([True, True, False], [True, True, False])
    assert reading.ratio == 1.0


def test_primary_ratio_below_one_when_sanitized_does_worse() -> None:
    reading = score_primary([True, False], [True, True])
    assert reading.sanitized_success_rate == 0.5
    assert reading.raw_success_rate == 1.0
    assert reading.ratio == 0.5


def test_primary_ratio_is_none_when_raw_never_succeeds() -> None:
    reading = score_primary([False, False], [False, False])
    assert reading.ratio is None


def test_primary_requires_matching_length_lists() -> None:
    with pytest.raises(ValueError):
        score_primary([True], [True, False])


def test_element_agreement_matches_same_role_name_and_overlapping_box() -> None:
    sent = [GraphNode("textbox", "Email", (0, 0, 100, 20))]
    gt = [GraphNode("textbox", "Email", (0, 0, 100, 20))]
    assert score_element_agreement(sent, gt) == 1.0


def test_element_agreement_zero_when_name_differs() -> None:
    sent = [GraphNode("textbox", "Username", (0, 0, 100, 20))]
    gt = [GraphNode("textbox", "Email", (0, 0, 100, 20))]
    assert score_element_agreement(sent, gt) == 0.0


def test_element_agreement_none_with_no_ground_truth() -> None:
    assert score_element_agreement([], []) is None


def test_screen_label_accuracy_counts_a_missing_prediction_as_a_miss() -> None:
    # None (Phase 4's disclosed no-op ViT) must count against accuracy, not be skipped.
    accuracy = score_screen_label_accuracy([None, "login form"], ["login form", "login form"])
    assert accuracy == 0.5
