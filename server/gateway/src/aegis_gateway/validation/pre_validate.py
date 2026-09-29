"""Server-side sanitization tripwire. The client redacts before anything leaves the browser; this
checks that it did, before the context goes anywhere near the model. A step whose free text still
carries a raw, checksum-valid identifier is rejected (UNSANITIZED_CONTEXT) and never forwarded.

Only high-precision patterns are used (checksums, strict formats), so a correctly sanitized page
is not rejected for ordinary text. Placeholders (⟪ENTITY#n⟫) are removed before scanning. What is
found is reported as entity names only, never the matched text.
"""

from __future__ import annotations

import re

_PLACEHOLDER = re.compile(r"⟪[A-Z_]+(?:#\d+)?⟫")

# Keys whose values are protocol vocabulary, opaque ids or image bytes, never page text.
_STRUCTURAL_KEYS = frozenset(
    {"schema", "step_id", "delta_of", "reason", "category", "status", "id", "role", "frame",
     "kind", "entity", "ref", "class", "method", "sources", "affordances", "level", "sha256",
     "data", "format", "op"}
)

_VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def _verhoeff_valid(digits: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def _luhn_valid(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


_AADHAAR = re.compile(r"(?<!\d)([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)")
_PAN = re.compile(r"(?<![A-Z0-9])[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z](?![A-Z0-9])")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_MOBILE = re.compile(
    r"(?<![\d+])(?:\+91[ -]?|0)?(?:[6-9]\d{9}|[6-9]\d{4}[ -]\d{5}|[6-9]\d{2}[ -]\d{3}[ -]\d{4})(?!\d)"
)
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")


def _text_leaves(value: object, key: str | None = None) -> list[str]:
    if key in _STRUCTURAL_KEYS:
        return []
    if isinstance(value, str):
        return [_PLACEHOLDER.sub(" ", value)]
    if isinstance(value, list):
        return [leaf for item in value for leaf in _text_leaves(item)]
    if isinstance(value, dict):
        return [leaf for k, v in value.items() for leaf in _text_leaves(v, k)]
    return []


def find_unsanitized(step_request: dict) -> list[str]:
    """Entity names of raw identifiers found in the step's page/user text (empty = clean)."""
    found: set[str] = set()
    for text in _text_leaves(step_request):
        if any(_verhoeff_valid("".join(m.groups())) for m in _AADHAAR.finditer(text)):
            found.add("AADHAAR")
        if _PAN.search(text):
            found.add("PAN")
        if _EMAIL.search(text):
            found.add("EMAIL")
        if _MOBILE.search(text):
            found.add("PHONE")
        for m in _CARD.finditer(text):
            digits = re.sub(r"\D", "", m.group(0))
            if 13 <= len(digits) <= 19 and _luhn_valid(digits) and len(set(digits)) > 1:
                found.add("CARD_NUMBER")
    return sorted(found)
