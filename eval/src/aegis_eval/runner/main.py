"""Orchestrates one harness run (T-1.17, T-1.18, T-1.19). Phase 1 scope: launch → load extension
→ open every fixture in the split → collect a ledger export (placeholder) → sample resources →
write a report row. No product assertions — see runner/__init__.py."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from aegis_eval.report.rows import ReportRow
from aegis_eval.report.writer import hardware_description, new_run_dir, write_csv, write_markdown
from aegis_eval.runner.browser import EXTENSION_DIR, extension_context
from aegis_eval.runner.collect import LedgerExportMissingError, collect_ledger_export, write_ledger_export
from aegis_eval.runner.drive import FixturePageMissingError, list_fixtures, open_fixture
from aegis_eval.runner.heldout_guard import guard_heldout_access
from aegis_eval.runner.resources import find_browser_root_pid, sample_process_tree


def extension_version() -> str:
    manifest_path = EXTENSION_DIR / "manifest.json"
    if not manifest_path.exists():
        return "unknown (extension not built)"
    with open(manifest_path) as f:
        return json.load(f).get("version", "unknown")


def run(
    split: str,
    *,
    heldout_confirmed: bool = False,
    heldout_reason: str | None = None,
    headless: bool = True,
    resource_sample_s: float = 1.0,
) -> int:
    audit_line = guard_heldout_access(split, heldout_confirmed, heldout_reason)

    screen_ids = list_fixtures(split)
    if not screen_ids:
        print(f"[aegis-eval] no fixtures found for split={split}; nothing to run")
        return 1

    run_dir = new_run_dir(split)
    hardware = hardware_description()
    date = datetime.now(UTC).isoformat()

    rows: list[ReportRow] = []
    errors: list[str] = []

    with extension_context(headless=headless) as context:
        browser_version = context.browser.version if context.browser else "unknown"
        root_pid = find_browser_root_pid(str(EXTENSION_DIR))

        for screen_id in screen_ids:
            try:
                opened = open_fixture(context, split, screen_id)
            except FixturePageMissingError as exc:
                errors.append(f"{screen_id}: {exc}")
                continue

            page = context.pages[-1] if context.pages else context.new_page()
            try:
                export = collect_ledger_export(page, screen_id)
            except LedgerExportMissingError as exc:
                errors.append(f"{screen_id}: ledger export missing — {exc}")
                continue
            ledger_path = write_ledger_export(export, run_dir)

            sample = None
            if root_pid is not None:
                sample = sample_process_tree(root_pid, duration_s=resource_sample_s)

            rows.append(
                ReportRow(
                    date=date,
                    split=split,
                    screen_id=screen_id,
                    hardware=hardware,
                    browser="chromium",
                    browser_version=browser_version,
                    extension_version=extension_version(),
                    fixture_load_ms=opened.load_ms,
                    peak_rss_mb=sample.peak_rss_mb if sample else None,
                    mean_rss_mb=sample.mean_rss_mb if sample else None,
                    peak_cpu_pct=sample.peak_cpu_pct if sample else None,
                    mean_cpu_pct=sample.mean_cpu_pct if sample else None,
                    ledger_export_path=str(ledger_path),
                )
            )

    csv_path = write_csv(rows, run_dir)
    md_path = write_markdown(rows, run_dir, split=split, audit_lines=[audit_line] if audit_line else None)

    print(f"[aegis-eval] {len(rows)}/{len(screen_ids)} fixtures processed")
    print(f"[aegis-eval] report: {md_path}")
    print(f"[aegis-eval] csv: {csv_path}")
    if errors:
        print(f"[aegis-eval] {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        return 1
    return 0
