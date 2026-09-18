"""Ledger export collection (T-1.18).

Phase 1 defined the real collection interface as a placeholder; Phase 5 (phase_5_measurement.md
§16a) fills it in for real, reading the panel's actual privacy ledger via the
`window.__aegisLedgerExport()` hook `entrypoints/sidepanel/main.tsx` exposes — exactly the
mechanism the original placeholder's own doc comment named but Phases 2-4 never built.
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
    note: str = ""


def collect_ledger_export(page: Page, screen_id: str) -> LedgerExport:
    """`page` is the PANEL page (the one `run_task_in_panel` drove), not the fixture page — the
    ledger lives in the panel's own `Session`, not anywhere the fixture page can see. Raises
    `LedgerExportMissingError` (never returns an export with no explanation) if the hook itself is
    missing, so the caller's "a missing export is an error, not a silent skip" invariant, true
    since Phase 1, stays true now that there's something real to fail on."""
    try:
        steps = page.evaluate("window.__aegisLedgerExport ? window.__aegisLedgerExport() : null")
    except Exception as exc:  # noqa: BLE001 - any evaluate failure means "no export", not a crash
        raise LedgerExportMissingError(f"{screen_id}: evaluating __aegisLedgerExport() failed: {exc}") from exc
    if steps is None:
        raise LedgerExportMissingError(f"{screen_id}: window.__aegisLedgerExport is not defined on the panel page")
    return LedgerExport(screen_id=screen_id, collected_at=datetime.now(UTC).isoformat(), steps=steps)


def write_ledger_export(export: LedgerExport, run_dir: Path) -> Path:
    ledger_dir = run_dir / "ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    out_path = ledger_dir / f"{export.screen_id}.json"
    out_path.write_text(json.dumps(asdict(export), indent=2))
    return out_path
