"""value_boxes.find_value_span: which substring of a rendered text is the labelled value."""

from __future__ import annotations

import hashlib

from aegis_eval.corpus.value_boxes import find_value_span


def _h(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def test_phone_inside_a_sentence_is_only_the_number_with_its_country_code() -> None:
    text = "You can reach me at +91 7056788035 anytime."
    i, j = find_value_span(text, _h("917056788035"), None)
    assert text[i:j] == "+91 7056788035"


def test_email_is_matched_case_insensitively() -> None:
    text = "Mail Priya.S@example.test today"
    i, j = find_value_span(text, _h("priya.s@example.test"), None)
    assert text[i:j] == "Priya.S@example.test"


def test_grouped_aadhaar_hashed_as_digits() -> None:
    text = "Aadhaar: 2345-6789-0123"
    i, j = find_value_span(text, _h("234567890123"), None)
    assert text[i:j] == "2345-6789-0123"


def test_devanagari_digits_fold_to_ascii() -> None:
    text = "मोबाइल ९८७६५४३२१०"
    i, j = find_value_span(text, _h("9876543210"), None)
    assert text[i:j] == "९८७६५४३२१०"


def test_canary_matches_verbatim_and_absent_value_is_none() -> None:
    assert find_value_span("x CANARYABC123 y", None, "CANARYABC123") == (2, 14)
    assert find_value_span("nothing sensitive", _h("9876543210"), None) is None
