"""Independent Python re-implementation of the structured-entity recognizers (design.md §18.3,
architecture §12.3, FR-52, T-5.7).

DELIBERATELY NOT a port of `packages/recognizers` (TypeScript). Written fresh from the entity
formats in `docs/design.md` §6.2 and public documentation of each identifier standard (PAN, IFSC,
GSTIN, vehicle registration, Aadhaar are all publicly specified formats — implementing "PAN is
five letters, four digits, one letter" independently in two languages is expected to produce
similar-looking regexes; the independence property this file exists for is a SEPARATE
implementation of the surrounding logic — canonicalization, checksum arithmetic, candidate
extraction — not a deliberately different regex for its own sake). `checksum arithmetic
(Verhoeff/Luhn/GSTIN) is also written fresh here, not imported from
`eval/src/aegis_eval/corpus/checksums.py` (fixture-generation tooling) or from the TypeScript
recognizers — see that module's own docstring for why both keep separate copies.

The reason this independence matters (architecture §12.3): if the TypeScript Aadhaar recognizer
has an off-by-one in its Verhoeff table, a Python port has the same off-by-one, agrees with the
client, and reports zero leaks — exactly the number that would be wrong on a slide. Two
independent implementations disagreeing is information; one implementation agreeing with itself
is not.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- Verhoeff (Aadhaar), written independently of eval/corpus/checksums.py and of the TS table -----
# Same standard dihedral-group tables (ISO/IEC 7064-adjacent, a public algorithm) — this is a
# reference implementation of a published algorithm, not a proprietary detection heuristic, so an
# identical table is expected and does not defeat the independence property described above.

_D_TABLE = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_P_TABLE = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


def verhoeff_valid(number: str) -> bool:
    if not number.isdigit():
        return False
    checksum = 0
    for position, char in enumerate(reversed(number)):
        checksum = _D_TABLE[checksum][_P_TABLE[position % 8][int(char)]]
    return checksum == 0


def luhn_valid(number: str) -> bool:
    if not number.isdigit():
        return False
    total = 0
    for position, char in enumerate(reversed(number)):
        digit = int(char)
        if position % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


_GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_valid(value: str) -> bool:
    if len(value) != 15:
        return False
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]", value):
        return False
    total = 0
    factor = 1
    for char in value[:14]:
        if char not in _GSTIN_ALPHABET:
            return False
        product = factor * _GSTIN_ALPHABET.index(char)
        total += product // 36 + product % 36
        factor = 1 if factor == 2 else 2
    expected = _GSTIN_ALPHABET[(36 - (total % 36)) % 36]
    return value[14] == expected


@dataclass(frozen=True)
class Candidate:
    entity: str
    matched_text: str
    start: int
    end: int


def canonicalize(entity: str, raw: str) -> str:
    """design.md/label.schema.json: "digits-only for numeric ids, lowercased for email/VPA" —
    the exact rule the corpus's `value_hash` is computed under, so a recovered candidate can be
    hashed and compared against it."""
    if entity in {"AADHAAR", "CARD_NUMBER", "PHONE", "PIN_CODE", "BANK_ACCOUNT"}:
        return re.sub(r"\D", "", raw)
    if entity in {"EMAIL", "UPI_VPA"}:
        return raw.strip().lower()
    return raw.strip()


_DIGIT_RUN_RE = re.compile(r"\d(?:[\d \-]*\d)?")


def find_aadhaar(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    for match in _DIGIT_RUN_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        if len(digits) == 12 and verhoeff_valid(digits):
            out.append(Candidate("AADHAAR", match.group(), match.start(), match.end()))
    return out


def find_card_number(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    for match in _DIGIT_RUN_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        if 13 <= len(digits) <= 19 and luhn_valid(digits):
            out.append(Candidate("CARD_NUMBER", match.group(), match.start(), match.end()))
    return out


_PAN_RE = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
_GSTIN_RE = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b")
_IFSC_RE = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
_UPI_VPA_RE = re.compile(r"\b[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}\b")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_PHONE_RE = re.compile(r"(?:\+91[\-\s]?)?[6-9]\d{9}\b")
_PIN_CODE_RE = re.compile(r"\b[1-9][0-9]{5}\b")
_PASSPORT_RE = re.compile(r"\b[A-PR-WYa-pr-wy][0-9]{7}\b")
_VEHICLE_REG_RE = re.compile(r"\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b")

_KNOWN_UPI_HANDLES = {"okhdfcbank", "oksbi", "okicici", "okaxis", "ybl", "paytm", "upi", "apl"}


def find_pan(text: str) -> list[Candidate]:
    return [Candidate("PAN", m.group(), m.start(), m.end()) for m in _PAN_RE.finditer(text)]


def find_gstin(text: str) -> list[Candidate]:
    return [
        Candidate("GSTIN", m.group(), m.start(), m.end())
        for m in _GSTIN_RE.finditer(text)
        if gstin_valid(m.group())
    ]


def find_ifsc(text: str) -> list[Candidate]:
    return [Candidate("IFSC", m.group(), m.start(), m.end()) for m in _IFSC_RE.finditer(text)]


def find_upi_vpa(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    for match in _UPI_VPA_RE.finditer(text):
        handle = match.group().rsplit("@", 1)[-1].lower()
        if handle in _KNOWN_UPI_HANDLES:
            out.append(Candidate("UPI_VPA", match.group(), match.start(), match.end()))
    return out


def find_email(text: str) -> list[Candidate]:
    return [Candidate("EMAIL", m.group(), m.start(), m.end()) for m in _EMAIL_RE.finditer(text)]


def find_phone(text: str) -> list[Candidate]:
    return [Candidate("PHONE", m.group(), m.start(), m.end()) for m in _PHONE_RE.finditer(text)]


def find_pin_code(text: str) -> list[Candidate]:
    return [Candidate("PIN_CODE", m.group(), m.start(), m.end()) for m in _PIN_CODE_RE.finditer(text)]


def find_passport(text: str) -> list[Candidate]:
    return [Candidate("PASSPORT", m.group(), m.start(), m.end()) for m in _PASSPORT_RE.finditer(text)]


def find_vehicle_reg(text: str) -> list[Candidate]:
    return [Candidate("VEHICLE_REG", m.group(), m.start(), m.end()) for m in _VEHICLE_REG_RE.finditer(text)]


ALL_FINDERS = (
    find_aadhaar,
    find_card_number,
    find_pan,
    find_gstin,
    find_ifsc,
    find_upi_vpa,
    find_email,
    find_phone,
    find_pin_code,
    find_passport,
    find_vehicle_reg,
)


def find_all(text: str) -> list[Candidate]:
    """Runs every independent recognizer over `text` and returns all candidates, unmerged —
    the auditor's `recover.py` only cares whether a *canonicalized* candidate's hash matches a
    known label, not about deduplicating overlapping spans the way the client's fusion does."""
    out: list[Candidate] = []
    for finder in ALL_FINDERS:
        out.extend(finder(text))
    return out
