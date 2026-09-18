"""design.md §18.3/§18.4, T-6.10 — runs all four arms on the SAME corpus and tasks, then writes
one comparison table to `docs/planning/ablations_phase6.md`. Each arm's own `runner.main.run()`
call does the real work (real browser, real extension, real DOM/recognizers/fusion/guard/
compositor pipeline, real scorers) — this module only sequences the four runs and reads back
each one's `ablation-summary.json` (written by `run()` itself) to build the table.

Metric 1 (task success) is deliberately absent from every row: `runner/gateway_mock.py` returns
the identical scripted plan regardless of payload, so there is no real task-success signal to
differ between arms here — the same root cause already disclosed for OQ-13/T-5.13's live-vLLM
gap. Reported as "not measured" in every row, not silently omitted and not guessed at."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from aegis_eval.ablations.arms import ARM_CLAIMS, ARMS
from aegis_eval.report.writer import hardware_description
from aegis_eval.runner.main import run as run_harness

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_OUT_PATH = REPO_ROOT / "docs" / "planning" / "ablations_phase6.md"


@dataclass
class ArmRunResult:
    arm: str
    exit_code: int
    summary: dict | None  # None if the run produced no fixtures / errored before writing one


def run_all_arms(split: str = "dev", *, headless: bool = True) -> list[ArmRunResult]:
    """Runs every arm in `ARMS` order, sequentially (Playwright drives one real browser context
    per arm — running them concurrently would contend for the same CPU this project's own metric
    4/5 numbers are trying to measure honestly). Never raises on a single arm's failure: a bad
    run still produces a row (marked as such) so one arm's problem doesn't hide the other three's
    real numbers."""
    results: list[ArmRunResult] = []
    for arm in ARMS:
        print(f"[ablations] running arm={arm} split={split}")
        exit_code = run_harness(split, headless=headless, ablation_arm=arm)
        summary = _latest_summary_for_arm(arm)
        results.append(ArmRunResult(arm=arm, exit_code=exit_code, summary=summary))
    return results


def _latest_summary_for_arm(arm: str) -> dict | None:
    """`run()` writes `ablation-summary.json` inside its own timestamped `run_dir`
    (`eval/reports/<timestamp>-<split>-<arm>/`) — find the most recent one for this arm rather
    than threading the exact path back through `run_harness`'s existing `int`-returning contract,
    which every pre-T-6.10 caller (`cli.py`) still depends on unchanged."""
    reports_dir = REPO_ROOT / "eval" / "reports"
    candidates = sorted(
        reports_dir.glob(f"*-{arm}/ablation-summary.json"), key=lambda p: p.stat().st_mtime
    )
    if not candidates:
        return None
    with open(candidates[-1]) as f:
        return json.load(f)


def _fmt(value: float | None, digits: int = 3) -> str:
    return "not measured" if value is None else f"{value:.{digits}f}"


def render_comparison_table(results: list[ArmRunResult], split: str) -> str:
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    hardware = hardware_description()
    lines = [
        "# Ablations — Phase 6",
        "",
        f"**Generated:** {date} · **Split:** {split} · **Hardware:** {hardware} · "
        "**Browser:** Chromium (Playwright)",
        "",
        "design.md §18.3's four arms, run on the same corpus and the same task through the real "
        "extension pipeline (not simulated — `eval/src/aegis_eval/ablations/runner.py`). "
        "Metric 1 (task success) is not measured for any arm: the mock gateway "
        "(`runner/gateway_mock.py`) returns the identical scripted plan regardless of payload "
        "content, so there is no real task-success signal to differ between arms in this "
        "environment (OQ-13, no live model here) — the same disclosed gap as every other "
        "mock-gateway-driven scoreboard in this project, not something this ablation run "
        "resolves.",
        "",
        "| Arm | n screens | Metric 2 macro recall (overall) | ...by group: structured | "
        "...free_text | ...visual | Metric 3 pixel precision | over-redaction rate | "
        "Metric 5 task p95 (ms) | Leak count |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        s = r.summary
        if s is None:
            lines.append(
                f"| {r.arm} | — | run produced no summary (exit {r.exit_code}) — see "
                "errors above | | | | | | | |"
            )
            continue
        m2 = s.get("metric2") or {}
        m2g = m2.get("by_group", {})
        m3 = s.get("metric3") or {}
        m5 = s.get("metric5") or {}
        leak = s.get("leak") or {}
        row = (
            "| {arm} | {n} | {m2} | {structured} | {free_text} | {visual} | {precision} "
            "| {overredact} | {p95} | {leak} |"
        )
        lines.append(
            row.format(
                arm=r.arm,
                n=s.get("n_screens", "—"),
                m2=_fmt(m2.get("macro_recall")),
                structured=_fmt((m2g.get("structured") or {}).get("macro_recall")),
                free_text=_fmt((m2g.get("free_text") or {}).get("macro_recall")),
                visual=_fmt((m2g.get("visual") or {}).get("macro_recall")),
                precision=_fmt(m3.get("pixel_precision")),
                overredact=_fmt(m3.get("over_redaction_rate")),
                p95=_fmt(m5.get("task_wall_clock_p95_ms"), digits=1),
                leak=leak.get("leak_count", "not measured"),
            )
        )

    lines += ["", "## Claims tested", ""]
    for arm in ARMS:
        lines.append(f"- **{arm}**: {ARM_CLAIMS[arm]}")

    lines += [
        "",
        "## Disclosed gaps",
        "",
        "- Metric 1 (task success) is not measured for any arm — see the note above the table.",
        "- Metric 2's group breakdown here is by ENTITY GROUP (structured/free_text/visual, "
        "`scorers/entity_groups.py`), not by page CATEGORY (canvas/PDF/etc.) — a canvas- or "
        "PDF-specific recall column would need a corpus-category filter this run does not "
        "currently apply. The `dom_only` row's `visual` recall is the closest existing proxy for "
        "\"leaks on canvas/PDF/image pages,\" since canvas/img/video content is exactly what "
        "Channel V (now disabled under `dom_only`) is responsible for.",
        "- Each arm is one full run of the given split; n is stated per row, not assumed equal "
        "across rows (a run that errors on some fixtures still reports the rest).",
    ]
    return "\n".join(lines) + "\n"


def main(split: str = "dev", *, headless: bool = True, out_path: Path = DEFAULT_OUT_PATH) -> int:
    results = run_all_arms(split, headless=headless)
    table = render_comparison_table(results, split)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(table)
    print(f"[ablations] wrote comparison table: {out_path}")
    return 0 if all(r.exit_code == 0 for r in results) else 1


if __name__ == "__main__":
    import sys

    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "dev"))
