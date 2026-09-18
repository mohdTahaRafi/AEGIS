"""design.md §18.2: metric 2 reports "separate tables for structured / free-text / visual
entities, because their difficulty is not comparable." This is the grouping used by both metric2
and (for its own breakdowns) metric3."""

from __future__ import annotations

STRUCTURED = frozenset(
    {
        "PASSWORD", "OTP", "CARD_NUMBER", "CARD_CVV", "CARD_EXPIRY", "AADHAAR", "SECRET",
        "EMAIL", "PHONE", "DOB", "BANK_ACCOUNT", "PAN", "GSTIN", "IFSC", "UPI_VPA",
        "PASSPORT", "VEHICLE_REG", "PIN_CODE", "DATE", "AMOUNT",
    }
)
FREE_TEXT = frozenset({"ADDRESS", "PERSON_NAME", "USERNAME", "CITY", "COUNTRY", "UNKNOWN_SENSITIVE"})
VISUAL = frozenset({"FACE", "ID_DOCUMENT", "SIGNATURE", "QR_CODE"})


def group_of(entity: str) -> str:
    if entity in STRUCTURED:
        return "structured"
    if entity in FREE_TEXT:
        return "free_text"
    if entity in VISUAL:
        return "visual"
    return "other"
