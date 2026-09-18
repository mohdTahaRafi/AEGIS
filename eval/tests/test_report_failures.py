from aegis_eval.report.failures import FailureExample, render_failures


def test_no_failures_gives_a_clear_message() -> None:
    lines = render_failures([])
    assert lines == ["No failures recorded in this run."]


def test_groups_by_category_with_examples() -> None:
    examples = [
        FailureExample("scr-1", "missed_detection", "AADHAAR", "12-digit number in a comment was not flagged"),
        FailureExample("scr-2", "false_positive", "PHONE", "order number misread as a phone number"),
    ]
    lines = render_failures(examples)
    text = "\n".join(lines)
    assert "Missed detections" in text
    assert "scr-1" in text
    assert "False alarms" in text
    assert "scr-2" in text


def test_truncates_long_lists_per_category() -> None:
    examples = [FailureExample(f"scr-{i}", "false_positive", None, "example") for i in range(10)]
    lines = render_failures(examples, max_per_category=3)
    text = "\n".join(lines)
    assert "and 7 more" in text
