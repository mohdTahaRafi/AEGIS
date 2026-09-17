"""Held-out discipline (T-1.20, design.md §18.4). The held-out split is touched once, before
submission, behind an explicit flag and a stated reason. Every use writes an audit line to the
report — this is what makes the discipline checkable after the fact rather than a promise."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

AUDIT_LOG = Path(__file__).resolve().parents[4] / "eval" / "reports" / "heldout-audit.log"


class HeldOutAccessDeniedError(RuntimeError):
    pass


def guard_heldout_access(split: str, confirmed: bool, reason: str | None) -> str | None:
    """Returns an audit line to include in the report if the heldout split may be used;
    raises HeldOutAccessDeniedError otherwise. No-op (returns None) for the dev split."""
    if split != "heldout":
        return None
    if not confirmed:
        raise HeldOutAccessDeniedError(
            "the held-out split is touched once, before submission. "
            "Re-run with --i-am-really-using-heldout and --reason \"...\"."
        )
    if not reason or not reason.strip():
        raise HeldOutAccessDeniedError(
            "held-out access requires a --reason naming why this run needs it."
        )

    timestamp = datetime.now(UTC).isoformat()
    line = f"{timestamp} — heldout split used. reason: {reason.strip()}"

    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_LOG, "a") as f:
        f.write(line + "\n")

    return line
