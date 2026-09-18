from aegis_eval.auditor.recognizers import verhoeff_valid
from aegis_eval.auditor.recover import LabelledValue, sha256_hex
from aegis_eval.scorers.leak import PayloadToAudit, score_leak_count


def _valid_aadhaar() -> str:
    base = "23456789012"
    for digit in "0123456789":
        if verhoeff_valid(base + digit):
            return base + digit
    raise AssertionError("no verhoeff check digit found")


def test_zero_leaks_over_clean_payloads() -> None:
    aadhaar = _valid_aadhaar()
    payloads = [
        PayloadToAudit("s-1", "step-1", '{"text":"⟪AADHAAR#1⟫"}', [LabelledValue("AADHAAR", sha256_hex(aadhaar))], []),
    ]
    result = score_leak_count(payloads)
    assert result.leak_count == 0
    assert result.n_payloads == 1


def test_one_leak_is_counted_and_the_evidence_is_reported() -> None:
    aadhaar = _valid_aadhaar()
    payloads = [
        PayloadToAudit("s-1", "step-1", f'{{"text":"leaked {aadhaar} here"}}', [LabelledValue("AADHAAR", sha256_hex(aadhaar))], []),
        PayloadToAudit("s-2", "step-1", '{"text":"clean"}', [], []),
    ]
    result = score_leak_count(payloads)
    assert result.leak_count == 1
    assert result.n_payloads == 2
    assert result.recoveries[0][0] == "s-1"


def test_ocr_checked_is_false_when_no_image_bytes_given() -> None:
    payloads = [PayloadToAudit("s-1", "step-1", '{"text":"clean"}', [], [])]
    result = score_leak_count(payloads)
    assert result.ocr_checked is False


def test_ocr_checked_stays_false_even_with_image_bytes_since_ocr_is_a_disclosed_no_op() -> None:
    payloads = [PayloadToAudit("s-1", "step-1", '{"text":"clean"}', [], [], image_bytes=b"fake-webp-bytes")]
    result = score_leak_count(payloads)
    assert result.ocr_checked is False  # ocr_image_text() always returns "" — see ocr.py
