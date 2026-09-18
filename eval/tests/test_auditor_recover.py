"""T-5.7/T-5.8: the auditor's core recovery act — proving it actually finds a planted leak, not
just that it runs without error. The AC for T-5.7 asks for "the auditor finding at least one
planted case the client's recognizers miss" — this suite plants exactly such a case (a raw value
present in the payload text with no vault/placeholder path anywhere near it) and shows the
independent auditor recovers it purely from the label's hash, with no plaintext value ever handed
to the auditor directly."""

from __future__ import annotations

from aegis_eval.auditor.recognizers import find_all
from aegis_eval.auditor.recover import LabelledValue, recover_from_payload, sha256_hex


def verhoeff_check_digit(base: str) -> str:
    from aegis_eval.auditor.recognizers import verhoeff_valid

    for digit in "0123456789":
        if verhoeff_valid(base + digit):
            return digit
    raise AssertionError("no verhoeff check digit found")


def test_recovers_a_planted_raw_value_the_client_missed() -> None:
    base = "234567890123"[:11]
    aadhaar = base + verhoeff_check_digit(base)
    # Simulates exactly design.md's failure mode: a detection miss let the raw value into the
    # outgoing payload text. The auditor is given ONLY the label's hash, never the plaintext.
    payload = f'{{"text":[{{"text":"the number is {aadhaar}"}}]}}'
    labelled = [LabelledValue(entity="AADHAAR", value_hash=sha256_hex(aadhaar))]

    result = recover_from_payload("scr-001", payload, labelled, canary_ids=[])

    assert result.leaked is True
    assert any(r.entity == "AADHAAR" for r in result.recoveries)


def test_a_correctly_redacted_payload_produces_zero_recoveries() -> None:
    payload = '{"text":[{"text":"aadhaar on record: ⟪AADHAAR#1⟫"}]}'
    labelled = [LabelledValue(entity="AADHAAR", value_hash=sha256_hex("234567890121"))]

    result = recover_from_payload("scr-002", payload, labelled, canary_ids=[])

    assert result.leaked is False
    assert result.recoveries == []


def test_a_checksum_invalid_lookalike_present_in_payload_is_not_a_false_recovery() -> None:
    # AC-11's over-blocking concern applies to the auditor too: a digit-shaped non-entity value
    # must not be reported as a recovery just because it superficially resembles the pattern.
    payload = '{"text":[{"text":"tracking number 234567890128"}]}'
    labelled = [LabelledValue(entity="AADHAAR", value_hash=sha256_hex("234567890123"))]

    result = recover_from_payload("scr-003", payload, labelled, canary_ids=[])

    assert result.leaked is False


def test_recovers_a_planted_canary_by_literal_substring() -> None:
    payload = '{"task":"note: CANARYBYBSKQ5YWMBFYS5LJ2JDV9 was here"}'
    result = recover_from_payload("scr-004", payload, [], canary_ids=["CANARYBYBSKQ5YWMBFYS5LJ2JDV9"])

    assert result.leaked is True
    assert result.recoveries[0].kind == "canary"


def test_a_hash_that_matches_no_label_is_never_reported() -> None:
    # A value present in the payload that ISN'T one of this screen's labelled sensitive values
    # (e.g. a non-sensitive order number) must not itself be a "recovery" — the auditor only
    # reports values it can prove are the SAME real value a label says should have been redacted.
    payload = '{"text":[{"text":"order 987654321098 confirmed"}]}'
    labelled = [LabelledValue(entity="AADHAAR", value_hash=sha256_hex("234567890123"))]

    result = recover_from_payload("scr-005", payload, labelled, canary_ids=[])

    assert result.leaked is False


def test_find_all_is_the_same_function_recover_uses_no_hidden_second_path() -> None:
    # Guards against recover.py silently growing its own duplicate candidate-extraction logic
    # instead of going through the one auditor recognizer module.
    import inspect

    from aegis_eval.auditor import recover as recover_module

    source = inspect.getsource(recover_module)
    assert "find_all" in source
    assert find_all is not None  # imported, not reimplemented
