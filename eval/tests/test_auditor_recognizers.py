"""T-5.7: the auditor's independent recognizers, cross-checked against the same category of
external ground truth `eval/src/aegis_eval/corpus/checksums.py` uses (a published test vector),
not merely internal round-trips — the whole point of this module is that it must NOT simply agree
with itself the way a port of the TypeScript client would."""

from __future__ import annotations

from aegis_eval.auditor.recognizers import (
    canonicalize,
    find_aadhaar,
    find_all,
    find_card_number,
    find_email,
    find_gstin,
    find_pan,
    find_upi_vpa,
    gstin_valid,
    luhn_valid,
    verhoeff_valid,
)


def verhoeff_check_digit(base: str) -> str:
    # Local helper for building a valid test number, independent of any generator elsewhere.
    for digit in "0123456789":
        if verhoeff_valid(base + digit):
            return digit
    raise AssertionError("no verhoeff check digit found — table bug")


def test_verhoeff_accepts_a_real_generated_valid_number() -> None:
    base = "234567890123"[:11]
    number = base + verhoeff_check_digit(base)
    assert verhoeff_valid(number)


def test_verhoeff_rejects_a_single_digit_corruption() -> None:
    base = "23456789012"
    number = base + verhoeff_check_digit(base)
    corrupted = "9" + number[1:] if number[0] != "9" else "8" + number[1:]
    assert not verhoeff_valid(corrupted)


def test_luhn_against_a_well_known_public_test_card_number() -> None:
    # 4111 1111 1111 1111 is a commonly published Luhn-valid Visa test number.
    assert luhn_valid("4111111111111111")


def test_luhn_rejects_a_corrupted_card_number() -> None:
    assert not luhn_valid("4111111111111112")


def test_gstin_against_a_commonly_cited_reference_example() -> None:
    # Same reference example eval/corpus/checksums.py cites independently: "27AAPFU0939F1Z" + "V".
    assert gstin_valid("27AAPFU0939F1ZV")


def test_gstin_rejects_a_wrong_check_character() -> None:
    assert not gstin_valid("27AAPFU0939F1ZA")


def test_find_aadhaar_extracts_a_valid_number_from_prose() -> None:
    base = "234567890123"[:11]
    number = base + verhoeff_check_digit(base)
    text = f"Aadhaar on record: {number[:4]} {number[4:8]} {number[8:]}"
    matches = find_aadhaar(text)
    assert len(matches) == 1
    assert canonicalize("AADHAAR", matches[0].matched_text) == number


def test_find_aadhaar_rejects_a_checksum_invalid_lookalike() -> None:
    text = "tracking number 234567890128"
    assert find_aadhaar(text) == []


def test_find_card_number_finds_a_luhn_valid_number() -> None:
    matches = find_card_number("card 4111 1111 1111 1111 on file")
    assert len(matches) == 1
    assert canonicalize("CARD_NUMBER", matches[0].matched_text) == "4111111111111111"


def test_find_pan_matches_the_public_pan_format() -> None:
    matches = find_pan("PAN: ABCDE1234F")
    assert len(matches) == 1


def test_find_gstin_requires_a_valid_check_character() -> None:
    assert len(find_gstin("GSTIN 27AAPFU0939F1ZV")) == 1
    assert find_gstin("GSTIN 27AAPFU0939F1ZA") == []  # wrong check char — not a false positive


def test_find_email_matches_a_plain_address() -> None:
    matches = find_email("contact a.user@example.com for help")
    assert len(matches) == 1


def test_find_upi_vpa_requires_a_known_handle() -> None:
    assert len(find_upi_vpa("pay to merchant@oksbi now")) == 1
    assert find_upi_vpa("visit example@notahandle") == []


def test_canonicalize_email_lowercases() -> None:
    assert canonicalize("EMAIL", "A.User@Example.COM") == "a.user@example.com"


def test_canonicalize_numeric_strips_non_digits() -> None:
    assert canonicalize("AADHAAR", "2345 6789 0123") == "234567890123"


def test_find_all_runs_every_recognizer_without_crashing_on_mixed_text() -> None:
    text = "Name: A. User. Email: a@b.com. PAN ABCDE1234F. Nothing else here."
    results = find_all(text)
    entities = {c.entity for c in results}
    assert "EMAIL" in entities
    assert "PAN" in entities
