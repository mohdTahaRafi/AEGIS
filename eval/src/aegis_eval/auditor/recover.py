"""The auditor's core act (architecture §12.3, FR-52, T-5.7/T-5.8): given a captured payload's
raw bytes and a screen's ground-truth labels, recover any labelled real value or canary string
that made it into the payload unredacted.

Values are never stored in plaintext in the corpus (label.schema.json's `value_hash`) — the
auditor never "knows" the real value either. It scans the payload text with its own independent
recognizers (`recognizers.py`), canonicalizes each candidate exactly as the label schema specifies,
hashes it, and checks for a match against the screen's labelled hashes. A match means the payload
contains recoverable evidence of a specific real value that was supposed to be redacted — not a
guess, a verified recovery. Canaries are checked by literal substring match (they are plaintext by
design — label.schema.json's `canary_id`).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from aegis_eval.auditor.recognizers import canonicalize, find_all


def sha256_hex(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LabelledValue:
    entity: str
    value_hash: str


@dataclass(frozen=True)
class Recovery:
    kind: str  # "value" | "canary"
    entity: str | None
    evidence: str  # the matched text (or canary id) — never the underlying real value if not
    # already present verbatim in the payload; recording it is exactly what a real leak looks like.


@dataclass(frozen=True)
class RecoveryResult:
    screen_id: str
    recoveries: list[Recovery]

    @property
    def leaked(self) -> bool:
        return len(self.recoveries) > 0


def recover_from_payload(
    screen_id: str,
    payload_text: str,
    labelled_values: list[LabelledValue],
    canary_ids: list[str],
) -> RecoveryResult:
    recoveries: list[Recovery] = []

    known_hashes = {lv.value_hash: lv.entity for lv in labelled_values}
    for candidate in find_all(payload_text):
        canonical = canonicalize(candidate.entity, candidate.matched_text)
        if not canonical:
            continue
        digest = sha256_hex(canonical)
        if digest in known_hashes:
            recoveries.append(Recovery(kind="value", entity=candidate.entity, evidence=candidate.matched_text))

    for canary_id in canary_ids:
        if canary_id and canary_id in payload_text:
            recoveries.append(Recovery(kind="canary", entity=None, evidence=canary_id))

    return RecoveryResult(screen_id=screen_id, recoveries=recoveries)
