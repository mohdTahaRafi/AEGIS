"""
Checksum algorithms for generating and validating synthetic Indian identifiers used in
eval/corpus/ fixtures (design.md §6.2, §17: "Identifiers are generated with valid checksums and
are fictitious"). This is fixture-generation tooling, not the production recognizer — Phase 3's
packages/recognizers and Phase 5's independent Python auditor each implement (and test) their own
copies of these algorithms independently, deliberately, so a bug here never propagates into either.
"""

from __future__ import annotations

# --- Verhoeff (used by Aadhaar) --------------------------------------------------------------
# Standard Verhoeff dihedral-group tables (D5). Public algorithm; see e.g. ISO/IEC 7064 discussion
# of Verhoeff's scheme. Detects all single-digit errors and all adjacent-transposition errors.

_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]


def verhoeff_generate(base_digits: str) -> str:
    """Given the base digits (without a check digit), return the check digit that makes
    base_digits + check_digit pass verhoeff_valid()."""
    digits = [int(d) for d in base_digits]
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = _D[c][_P[(i + 1) % 8][digit]]
    return str(_INV[c])


def verhoeff_valid(number: str) -> bool:
    digits = [int(d) for d in number]
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = _D[c][_P[i % 8][digit]]
    return c == 0


# --- Luhn (used by card numbers) -------------------------------------------------------------


def luhn_generate(base_digits: str) -> str:
    """Given the base digits (without a check digit), return the check digit."""
    digits = [int(d) for d in base_digits]
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return str((10 - (total % 10)) % 10)


def luhn_valid(number: str) -> bool:
    digits = [int(d) for d in number]
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# --- GSTIN check character --------------------------------------------------------------------
# 15 chars: 2 state code + 10 PAN + 1 entity code + 'Z' + 1 check character.
# Documented public algorithm (factor alternates 1/2 from the left, digit = quotient + remainder
# of (factor * code_point) / 36, summed, check = (36 - sum % 36) % 36).
# Verified against a real published example, not just internal round-trip: the prefix
# "27AAPFU0939F1Z" (a commonly cited documentation/reference GSTIN) produces the check character
# "V" under this implementation, matching the full number "27AAPFU0939F1ZV" as commonly published
# — see test_checksums.py::test_gstin_round_trip.

_GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_generate(prefix14: str) -> str:
    """Given the first 14 characters (state+PAN+entity code+'Z'), return the check character."""
    assert len(prefix14) == 14
    total = 0
    factor = 1
    for ch in prefix14:
        code_point = _GSTIN_CHARSET.index(ch)
        product = factor * code_point
        total += product // 36 + product % 36
        factor = 2 if factor == 1 else 1
    check_code_point = (36 - (total % 36)) % 36
    return _GSTIN_CHARSET[check_code_point]


def gstin_valid(gstin: str) -> bool:
    if len(gstin) != 15:
        return False
    return gstin[14] == gstin_generate(gstin[:14])
