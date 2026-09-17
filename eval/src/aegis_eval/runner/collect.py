"""Ledger export collection (T-1.18).

Phase 1: there is no product panel and no privacy ledger yet (Phase 3 builds it — design.md
§5.5/§12.1). This module still defines the real collection interface the harness will use from
Phase 3 onward, and returns a well-formed placeholder now, so:
  - the report-writing path is exercised end to end in Phase 1 (T-1.21's provenance columns need
    something to write, even with empty metric fields);
  - "a missing export is an error, not a silent skip" is meaningful from day one — collect_ledger_export
    always returns an object, never None, and the runner treats None as a hard failure now so that
    invariant doesn't have to be introduced later once there is something real to break.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from playwright.sync_api import Page


class LedgerExportMissingError(RuntimeError):
    pass


@dataclass
class LedgerExport:
    screen_id: str
    collected_at: str
    steps: list[dict] = field(default_factory=list)
    note: str = "placeholder — no product privacy ledger exists yet (Phase 3, T-3.27)"


def collect_ledger_export(_page: Page, screen_id: str) -> LedgerExport:
    """Phase 3 replaces this body with a real read of the panel's exported ledger (e.g. via a
    `window.__aegisLedgerExport()` hook the panel exposes, or a downloaded JSON file), and must
    raise LedgerExportMissingError rather than return None if that read fails — the caller
    (runner.main) treats a missing export as a hard failure, never a silent skip, from day one.
    """
    return LedgerExport(screen_id=screen_id, collected_at=datetime.now(UTC).isoformat())


def write_ledger_export(export: LedgerExport, run_dir: Path) -> Path:
    ledger_dir = run_dir / "ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    out_path = ledger_dir / f"{export.screen_id}.json"
    out_path.write_text(json.dumps(asdict(export), indent=2))
    return out_path
