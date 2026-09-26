"""Orchestrates one harness run (T-1.17, T-1.18, T-1.19). Launch → load extension → for every
fixture: open the page, drive a real task through the real panel (via a mock gateway —
`gateway_mock.py`, since OQ-13 leaves no live model to call), collect the real ledger export →
sample resources → write a report row. No product assertions — see runner/__init__.py."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

from aegis_eval.auditor.recover import LabelledValue
from aegis_eval.corpus.labels import LABELS_DIR
from aegis_eval.report.rows import ReportRow
from aegis_eval.report.scoreboard import Provenance
from aegis_eval.report.scoreboard import write_scoreboard as write_rich_scoreboard
from aegis_eval.report.writer import hardware_description, new_run_dir, write_csv, write_markdown
from aegis_eval.runner.browser import DEBUG_EXTENSION_DIR, EXTENSION_DIR, extension_context, extension_id
from aegis_eval.runner.collect import (
    LedgerExportMissingError,
    collect_ledger_export,
    write_ledger_export,
)
from aegis_eval.runner.drive import (
    CORPUS_DIR,
    FixturePageMissingError,
    PanelHookMissingError,
    list_fixtures,
    open_fixture,
    open_panel,
    run_task_in_panel,
)
from aegis_eval.runner.fixture_server import serve_corpus
from aegis_eval.runner.gateway_mock import MockGateway
from aegis_eval.runner.heldout_guard import guard_heldout_access
from aegis_eval.runner.resources import (
    ResourceSample,
    find_browser_root_pid,
    merge_samples,
    sample_process_tree,
)
from aegis_eval.scorers.leak import PayloadToAudit, score_leak_count
from aegis_eval.scorers.matching import Detection, GroundTruth
from aegis_eval.scorers.metric2 import score_metric2
from aegis_eval.scorers.metric3 import score_metric3
from aegis_eval.scorers.metric4 import bundled_model_mb_from_manifest, score_metric4
from aegis_eval.scorers.metric5 import STAGES, StepTimings, score_metric5

MODELS_MANIFEST_PATH = EXTENSION_DIR / "models" / "models.manifest.json"

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


def _metric2_summary(m) -> dict | None:
    if m is None:
        return None
    groups = ("structured", "free_text", "visual")
    return {
        "macro_recall": m.macro_recall(),
        "macro_precision": m.macro_precision(),
        "micro_recall": m.micro_recall(),
        "micro_precision": m.micro_precision(),
        "by_group": {
            g: {"macro_recall": m.macro_recall(g), "macro_precision": m.macro_precision(g)}
            for g in groups
        },
    }


def _metric3_summary(m) -> dict | None:
    if m is None:
        return None
    return {
        "pixel_precision": m.pixel_precision,
        "over_redaction_rate": m.over_redaction_rate,
        "mean_iou": m.mean_iou,
    }


def _metric5_summary(m) -> dict | None:
    if m is None:
        return None
    return {
        "task_wall_clock_p95_ms": m.task_wall_clock_p95_ms,
        "step_round_trip_p95_ms": m.step_round_trip_p95_ms,
        "per_stage_p95": m.per_stage_p95,
    }


def _leak_summary(m) -> dict | None:
    if m is None:
        return None
    return {"leak_count": m.leak_count, "n_payloads": m.n_payloads}


def score_and_write_scoreboard(
    ledger_exports: dict[str, list[dict]],
    run_dir,
    date: str,
    hardware: str,
    browser_version: str,
    split: str,
    task_samples: list[ResourceSample] | None = None,
    idle_sample: ResourceSample | None = None,
    task_wall_clock_ms: list[float] | None = None,
):
    """Real scoring against the real corpus (T-5.2…T-5.9, T-5.12's leak-count half). Metric 1
    stays `None` here — its primary reading needs two live-model runs (OQ-13), which no environment
    without a GPU can produce. Metrics 4 and 5, by contrast, only need what a mocked-gateway run
    already collects: `runner/resources.py`'s OS-level process sampling and
    `LedgerEntry.timings`'s real per-stage timestamps (`session.ts` computes these for real,
    regardless of whether the gateway behind them is live or mocked) — see
    `docs/planning/phase_5_measurement.md` §16i for why these were previously left unwired despite
    being fully computable. Numbers are real for THIS machine, not OQ-16's reference laptop, and
    `model_share_pct`/`model_time_ms` stay `None` (the mock gateway sets no `Server-Timing` header)
    — both disclosed via `hardware`/`model_versions` in the provenance line every report already
    carries, not hidden."""
    metric2_screens: list[tuple[list[Detection], list[GroundTruth]]] = []
    metric3_screens: list[tuple[list[Detection], list[GroundTruth], int, int]] = []
    leak_payloads: list[PayloadToAudit] = []
    step_timings: list[StepTimings] = []

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

            timings = step.get("timings")
            if timings and all(stage in timings for stage in STAGES):
                step_timings.append(StepTimings(**{stage: timings[stage] for stage in STAGES}))

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

    metric4 = None
    if MODELS_MANIFEST_PATH.exists():
        merged_task_sample = merge_samples(task_samples) if task_samples else None
        with open(MODELS_MANIFEST_PATH) as f:
            manifest = json.load(f)
        metric4 = score_metric4(
            bundled_model_mb=bundled_model_mb_from_manifest(manifest),
            task_sample=merged_task_sample,
            idle_sample=idle_sample,
        )

    metric5 = score_metric5(step_timings, task_wall_clock_ms or []) if step_timings else None

    policy_version = next(
        (s["policyVersion"] for steps in ledger_exports.values() for s in steps if s.get("policyVersion")), None
    )
    provenance = Provenance(
        date=date, split=split, hardware=hardware, browser="chromium", browser_version=browser_version,
        backend=None, policy_version=policy_version, model_versions="mock (OQ-13 — no live model in this environment)",
    )
    out_path = run_dir / "rich-scoreboard.md"
    write_rich_scoreboard(out_path, provenance, (None, None), metric2, metric3, metric4, metric5, leak)
    # T-6.10: the ablation runner needs the actual metric OBJECTS, not a markdown file it would
    # otherwise have to re-parse — returned alongside the path so every pre-T-6.10 caller (this
    # function's own return type) still gets exactly what it always has.
    results = {
        "metric2": metric2,
        "metric3": metric3,
        "metric4": metric4,
        "metric5": metric5,
        "leak": leak,
    }
    return out_path, results


def run(
    split: str,
    *,
    heldout_confirmed: bool = False,
    heldout_reason: str | None = None,
    headless: bool = True,
    resource_sample_s: float = 1.0,
    ablation_arm: str | None = None,
    ner_profile: str | None = None,
) -> int:
    """`ablation_arm` (T-6.9/T-6.10, design.md §18.3): `None` (the default) selects the ordinary
    `fused` pipeline (every channel on, no debug switch flipped); any of `'fused' | 'dom_only' |
    'pixel_only' | 'blackbox'` instead selects that arm via `storage.local`, the mechanism
    `debug/ablations.ts` expects.

    `ner_profile` (T-6.8, OQ-7): `None` (the default) leaves the extension's own default (`'S'`,
    settings/store.ts) in place; `'L'` writes `chrome.storage.local`'s real `aegis_settings` blob
    (the same key/shape `host/settings/store.ts` reads) with `nerProfile: 'L'` before any fixture
    runs, so `perception/worker.ts`'s real `openai/privacy-filter` model is what backs Channel N
    for this run instead of the disclosed profile-S no-op — the only way to get a real,
    corpus-scale recall number for design.md's actual shipping condition.

    [Real bug found and fixed, 2026-09-25 — see docs/HISTORY.md]: this used to also pick the
    extension BUILD by `ablation_arm` (`None` → the release build at `EXTENSION_DIR`, anything
    else → `DEBUG_EXTENSION_DIR`), on the theory that a plain harness run should exercise the
    real release artifact. That is dead code that has never actually completed a single fixture:
    `entrypoints/sidepanel/main.tsx`'s `handleStart` calls `ensureHostPermission`, which on the
    release manifest (`optional_host_permissions` only, no auto-grant) falls through to
    `chrome.permissions.request(...)` — and confirmed by direct reproduction, that call never
    resolves OR rejects without a real user gesture, which headless Playwright automation can
    never supply. There is no timeout anywhere in that path, so a plain (non-ablation) run just
    hangs forever on fixture 1 with zero output, zero error, zero worker ever created — exactly
    what a from-scratch run in a fresh sandbox instance hit after 90 minutes of silence. Every
    historical "n=166 dev" report in this repo's HISTORY.md was, in retrospect, necessarily
    produced via `--ablation fused` (the debug build, `host_permissions` auto-granted) — the
    'plain' code path had silently never been exercised end-to-end by anyone.

    Fixed by always using `DEBUG_EXTENSION_DIR` here, regardless of `ablation_arm`. The two
    builds' manifests differ by exactly one key (`host_permissions: ["<all_urls>"]`, diffed for
    real) — nothing about the redaction/fusion/guard pipeline this harness measures changes."""
    audit_line = guard_heldout_access(split, heldout_confirmed, heldout_reason)

    screen_ids = list_fixtures(split)
    if not screen_ids:
        print(f"[aegis-eval] no fixtures found for split={split}; nothing to run")
        return 1

    report_split = f"{split}-{ablation_arm}" if ablation_arm else split
    report_split = f"{report_split}-ner{ner_profile}" if ner_profile else report_split
    run_dir = new_run_dir(report_split)
    hardware = hardware_description()
    date = datetime.now(UTC).isoformat()

    rows: list[ReportRow] = []
    errors: list[str] = []
    ledger_exports: dict[str, list[dict]] = {}  # screen_id -> LedgerExport.steps, for real scoring below
    task_samples: list[ResourceSample] = []
    task_wall_clock_ms: list[float] = []

    # Always the debug build — see this function's own doc comment for the real, reproduced
    # reason (the release manifest's host-permission model cannot be satisfied headlessly).
    extension_dir = DEBUG_EXTENSION_DIR
    # T-6.10: fixture pages are served over real HTTP now, not `file://` — a `file://` origin can
    # never be granted `captureVisibleTab` access (see `fixture_server.py`'s own doc comment for
    # the real, previously-undiscovered bug this was found fixing: the vision/image path has
    # never actually run through this harness before, in any phase, regardless of ablation arm).
    with serve_corpus(CORPUS_DIR) as base_url, extension_context(
        headless=headless, extension_dir=extension_dir
    ) as context:
        browser_version = context.browser.version if context.browser else "unknown"
        root_pid = find_browser_root_pid(str(extension_dir))
        ext_id = extension_id(context)
        # phase_5_measurement.md §16a: no real gateway process needed — see gateway_mock.py's own
        # doc comment for why route interception, not a live model or byte-exact replay, is the
        # right stand-in for a harness run that only needs the real OUTGOING payload, not a real
        # plan back.
        mock_gateway = MockGateway()
        mock_gateway.install(context)

        if ablation_arm:
            # Set once, extension-wide, before any fixture runs — every fixture's own panel page
            # re-reads it fresh at task-start time (`main.tsx`'s debug-only branch), so one write
            # here is enough for the whole run, not one per fixture.
            setup_page = context.new_page()
            setup_page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            setup_page.evaluate(
                "(arm) => chrome.storage.local.set({ aegis_debug_ablation_arm: arm })", ablation_arm
            )
            setup_page.close()

        if ner_profile:
            # Same one-write-for-the-whole-run pattern as the ablation switch above, but through
            # `host/settings/store.ts`'s real `aegis_settings` key (not a debug-only switch) —
            # `loadSettings` merges this partial blob field-by-field over its own defaults, so
            # only `nerProfile` needs to be set here.
            setup_page = context.new_page()
            setup_page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            setup_page.evaluate(
                "(profile) => chrome.storage.local.set({ aegis_settings: { nerProfile: profile } })",
                ner_profile,
            )
            setup_page.close()

        # Metric 4's idle baseline (T-5.5): one sample taken with the extension loaded but before
        # any fixture/task has run, so "task" vs "idle" resource use is a real comparison against
        # this same run, not an assumption. A settle delay is deliberate, not padding: sampling
        # immediately after `extension_context` returns caught the extension's own cold-start
        # bootstrap (service worker init, side-panel pre-load) rather than steady-state idle,
        # producing a nonsensical first result where "idle" CPU exceeded "task" CPU — found by
        # actually reading the number rather than trusting that "idle" and "not yet done anything"
        # are the same thing.
        if root_pid is not None:
            time.sleep(2.0)
        idle_sample = sample_process_tree(root_pid, duration_s=resource_sample_s) if root_pid is not None else None

        for screen_id in screen_ids:
            try:
                opened, fixture_page = open_fixture(context, split, screen_id, base_url)
            except FixturePageMissingError as exc:
                errors.append(f"{screen_id}: {exc}")
                continue

            try:
                panel = open_panel(context, ext_id)
                canaries = load_canary_ids(screen_id)
                task_start = time.monotonic()
                run_task_in_panel(panel, fixture_page, DEFAULT_TASK, canaries)
                task_elapsed_ms = (time.monotonic() - task_start) * 1000
                export = collect_ledger_export(panel, screen_id)
            except (PanelHookMissingError, LedgerExportMissingError) as exc:
                errors.append(f"{screen_id}: {exc}")
                fixture_page.close()
                continue
            task_wall_clock_ms.append(task_elapsed_ms)
            ledger_path = write_ledger_export(export, run_dir)
            ledger_exports[screen_id] = export.steps
            fixture_page.close()
            panel.close()

            sample = None
            if root_pid is not None:
                sample = sample_process_tree(root_pid, duration_s=resource_sample_s)
                task_samples.append(sample)

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
    md_path = write_markdown(rows, run_dir, split=report_split, audit_lines=[audit_line] if audit_line else None)
    scoreboard_path, scoreboard_results = score_and_write_scoreboard(
        ledger_exports, run_dir, date, hardware, browser_version, report_split,
        task_samples=task_samples, idle_sample=idle_sample, task_wall_clock_ms=task_wall_clock_ms,
    )

    print(f"[aegis-eval] {len(rows)}/{len(screen_ids)} fixtures processed")
    print(f"[aegis-eval] report: {md_path}")
    print(f"[aegis-eval] csv: {csv_path}")
    print(f"[aegis-eval] rich scoreboard (T-5.9): {scoreboard_path}")
    if ablation_arm:
        # T-6.10: `ablations/runner.py` reads this back to build the cross-arm comparison table —
        # a small, stable JSON summary rather than re-parsing the markdown report.
        summary_path = run_dir / "ablation-summary.json"
        with open(summary_path, "w") as f:
            json.dump(
                {
                    "arm": ablation_arm,
                    "split": split,
                    "n_screens": len(rows),
                    "run_dir": str(run_dir),
                    "metric2": _metric2_summary(scoreboard_results["metric2"]),
                    "metric3": _metric3_summary(scoreboard_results["metric3"]),
                    "metric5": _metric5_summary(scoreboard_results["metric5"]),
                    "leak": _leak_summary(scoreboard_results["leak"]),
                },
                f,
                indent=2,
            )
        print(f"[aegis-eval] ablation summary ({ablation_arm}): {summary_path}")
    if errors:
        print(f"[aegis-eval] {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        return 1
    return 0
