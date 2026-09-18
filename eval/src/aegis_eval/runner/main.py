"""Orchestrates one harness run (T-1.17, T-1.18, T-1.19). Launch → load extension → for every
fixture: open the page, drive a real task through the real panel (via a mock gateway —
`gateway_mock.py`, since OQ-13 leaves no live model to call), collect the real ledger export →
sample resources → write a report row. No product assertions — see runner/__init__.py."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from aegis_eval.auditor.recover import LabelledValue
from aegis_eval.corpus.labels import LABELS_DIR
from aegis_eval.report.rows import ReportRow
from aegis_eval.report.scoreboard import Provenance
from aegis_eval.report.scoreboard import write_scoreboard as write_rich_scoreboard
from aegis_eval.report.writer import hardware_description, new_run_dir, write_csv, write_markdown
from aegis_eval.runner.browser import EXTENSION_DIR, extension_context, extension_id
from aegis_eval.runner.collect import LedgerExportMissingError, collect_ledger_export, write_ledger_export
from aegis_eval.runner.drive import (
    FixturePageMissingError,
    PanelHookMissingError,
    list_fixtures,
    open_fixture,
    open_panel,
    run_task_in_panel,
)
from aegis_eval.runner.gateway_mock import MockGateway
from aegis_eval.runner.heldout_guard import guard_heldout_access
from aegis_eval.runner.resources import find_browser_root_pid, sample_process_tree
from aegis_eval.scorers.leak import PayloadToAudit, score_leak_count
from aegis_eval.scorers.matching import Detection, GroundTruth
from aegis_eval.scorers.metric2 import score_metric2
from aegis_eval.scorers.metric3 import score_metric3

# design.md doesn't script a real per-fixture task for detection-only screens (most of the
# corpus) — a generic observation task is enough to drive one real step through the full
# pipeline and produce a real sanitized payload, which is what T-5.1's future scorers need.
DEFAULT_TASK = "observe and report what is on the page"


def extension_version() -> str:
    manifest_path = EXTENSION_DIR / "manifest.json"
    if not manifest_path.exists():
        return "unknown (extension not built)"
    with open(manifest_path) as f:
        return json.load(f).get("version", "unknown")


def load_canary_ids(screen_id: str) -> list[str]:
    """design.md §7.6 step 6 / T-5.8 — the screen's own labelled canary ids, fed to the real
    guard's debug/harness-only check via `run_task_in_panel`. Missing/malformed label files never
    fail the run itself (a fixture with no label yet still gets driven, just without this one
    extra check) — `validate-labels` is the tool that enforces label completeness, not this path."""
    label_path = LABELS_DIR / f"{screen_id}.json"
    if not label_path.exists():
        return []
    with open(label_path) as f:
        label = json.load(f)
    return [item["canary_id"] for item in label.get("items", []) if item.get("canary") and "canary_id" in item]


def _load_label(screen_id: str) -> dict | None:
    path = LABELS_DIR / f"{screen_id}.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def score_and_write_scoreboard(ledger_exports: dict[str, list[dict]], run_dir, date: str, hardware: str, browser_version: str, split: str):
    """Real scoring against the real corpus (T-5.2…T-5.9, T-5.12's leak-count half). Metrics 1, 4
    and 5 stay `None` here — they need a live model (OQ-13) and reference hardware (OQ-16), neither
    of which exists in this environment; see `docs/planning/phase_5_measurement.md` §16a. Metrics 2
    and 3 and the leak count need only the real (payload, label) pairs a driven harness run now
    actually produces (phase_5_measurement.md §16a's harness-integration work)."""
    metric2_screens: list[tuple[list[Detection], list[GroundTruth]]] = []
    metric3_screens: list[tuple[list[Detection], list[GroundTruth], int, int]] = []
    leak_payloads: list[PayloadToAudit] = []

    for screen_id, steps in ledger_exports.items():
        label = _load_label(screen_id)
        if label is None or not steps:
            continue
        ground_truth = [GroundTruth(entity=item["entity"], box=tuple(item["box"])) for item in label.get("items", [])]
        labelled_values = [LabelledValue(entity=i["entity"], value_hash=i["value_hash"]) for i in label.get("items", []) if "value_hash" in i]
        canary_ids = [i["canary_id"] for i in label.get("items", []) if i.get("canary")]

        for step in steps:
            payload = step.get("payload")
            if not payload:
                continue
            detections = [Detection(entity=r["entity"], box=tuple(r["boxes"][0])) for r in payload.get("redactions", []) if r.get("boxes")]
            metric2_screens.append((detections, ground_truth))
            viewport = payload.get("viewport", {})
            metric3_screens.append((detections, ground_truth, int(viewport.get("w", 0)), int(viewport.get("h", 0))))

            # Leak count: only steps that actually passed the guard were ever sent — a blocked
            # step's pre-guard payload is retained in the ledger for local audit only and never
            # crosses egress, so scoring it would misreport a successful block as a leak.
            if step.get("guardVerdict", {}).get("ok"):
                leak_payloads.append(
                    PayloadToAudit(
                        screen_id=screen_id,
                        step_id=step.get("stepId", "s-1"),
                        payload_text=json.dumps(payload),
                        labelled_values=labelled_values,
                        canary_ids=canary_ids,
                    )
                )

    metric2 = score_metric2(metric2_screens) if metric2_screens else None
    metric3 = score_metric3(metric3_screens) if metric3_screens else None
    leak = score_leak_count(leak_payloads) if leak_payloads else None

    policy_version = next(
        (s["policyVersion"] for steps in ledger_exports.values() for s in steps if s.get("policyVersion")), None
    )
    provenance = Provenance(
        date=date, split=split, hardware=hardware, browser="chromium", browser_version=browser_version,
        backend=None, policy_version=policy_version, model_versions="mock (OQ-13 — no live model in this environment)",
    )
    out_path = run_dir / "rich-scoreboard.md"
    write_rich_scoreboard(out_path, provenance, (None, None), metric2, metric3, None, None, leak)
    return out_path


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
    ledger_exports: dict[str, list[dict]] = {}  # screen_id -> LedgerExport.steps, for real scoring below

    with extension_context(headless=headless) as context:
        browser_version = context.browser.version if context.browser else "unknown"
        root_pid = find_browser_root_pid(str(EXTENSION_DIR))
        ext_id = extension_id(context)
        # phase_5_measurement.md §16a: no real gateway process needed — see gateway_mock.py's own
        # doc comment for why route interception, not a live model or byte-exact replay, is the
        # right stand-in for a harness run that only needs the real OUTGOING payload, not a real
        # plan back.
        mock_gateway = MockGateway()
        mock_gateway.install(context)

        for screen_id in screen_ids:
            try:
                opened, fixture_page = open_fixture(context, split, screen_id)
            except FixturePageMissingError as exc:
                errors.append(f"{screen_id}: {exc}")
                continue

            try:
                panel = open_panel(context, ext_id)
                canaries = load_canary_ids(screen_id)
                run_task_in_panel(panel, fixture_page, DEFAULT_TASK, canaries)
                export = collect_ledger_export(panel, screen_id)
            except (PanelHookMissingError, LedgerExportMissingError) as exc:
                errors.append(f"{screen_id}: {exc}")
                fixture_page.close()
                continue
            ledger_path = write_ledger_export(export, run_dir)
            ledger_exports[screen_id] = export.steps
            fixture_page.close()
            panel.close()

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
    scoreboard_path = score_and_write_scoreboard(ledger_exports, run_dir, date, hardware, browser_version, split)

    print(f"[aegis-eval] {len(rows)}/{len(screen_ids)} fixtures processed")
    print(f"[aegis-eval] report: {md_path}")
    print(f"[aegis-eval] csv: {csv_path}")
    print(f"[aegis-eval] rich scoreboard (T-5.9): {scoreboard_path}")
    if errors:
        print(f"[aegis-eval] {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        return 1
    return 0
