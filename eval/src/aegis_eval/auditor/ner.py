"""architecture §12.3: the auditor's server-grade free-text NER pass, run with a larger model than
the client can afford, to estimate recall on entities the client's small on-device model
(`apps/extension/src/perception/models/pii-ner.ts`, itself a disclosed no-op in this environment)
might miss — PERSON_NAME, ADDRESS, ORG-shaped bank account context, and similar free-text entities
that pattern recognizers alone can't reliably catch.

[A] DISCLOSED LIMITATION, same category as `ocr.py`: no NER model or ML Python environment is
available here. Defines the real call shape; always returns no spans, treated as "not checked."
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NerSpan:
    entity: str
    text: str
    start: int
    end: int


def find_free_text_entities(_text: str) -> list[NerSpan]:
    return []
