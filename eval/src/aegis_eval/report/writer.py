"""CSV + Markdown scoreboard writer (T-1.21)."""

from __future__ import annotations

import csv
import platform
from dataclasses import fields
from datetime import UTC, datetime
from pathlib import Path

from aegis_eval.report.rows import ReportRow

REPORTS_DIR = Path(__file__).resolve().parents[4] / "eval" / "reports"


def hardware_description() -> str:
    """Best-effort machine description. Not the reference laptop — OQ-16 (docs/DECISIONS.md) has
    not been closed; once it is, the harness should be run there and this becomes that fixed
    description rather than whatever machine happened to run it."""
    return f"{platform.system()} {platform.machine()} ({platform.node()})"


def new_run_dir(split: str) -> Path:
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H%M%SZ")
    run_dir = REPORTS_DIR / f"{stamp}-{split}"
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def write_csv(rows: list[ReportRow], run_dir: Path) -> Path:
    out_path = run_dir / "scoreboard.csv"
    fieldnames = [f.name for f in fields(ReportRow)]
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row.as_dict())
    return out_path


def write_markdown(rows: list[ReportRow], run_dir: Path, *, split: str, audit_lines: list[str] | None = None) -> Path:
    out_path = run_dir / "scoreboard.md"
    n = len(rows)
    date = rows[0].date if rows else datetime.now(UTC).isoformat()
    hardware = rows[0].hardware if rows else hardware_description()
    browser = f"{rows[0].browser} {rows[0].browser_version}" if rows else "n/a"
    ext_version = rows[0].extension_version if rows else "n/a"

    lines = [
        "# AEGIS evaluation scoreboard",
        "",
        f"- **n:** {n} screens",
        f"- **split:** {split}",
        f"- **hardware:** {hardware}",
        f"- **browser:** {browser}",
        f"- **extension version:** {ext_version}",
        f"- **date:** {date}",
        "",
    ]

    if audit_lines:
        lines += ["## Held-out audit", ""]
        lines += [f"- {line}" for line in audit_lines]
        lines += [""]

    lines += [
        "## Official metrics",
        "",
        "Every cell below is `—` until Phase 5's scorers run — see design.md §18.2 and "
        "docs/planning/phase_5_measurement.md. A number here before then would be an assertion, "
        "not a measurement.",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| 1. Visual context accuracy | {_fmt(_first(rows, 'metric1_visual_context_accuracy'))} |",
        f"| 2. PII precision / recall | {_fmt(_first(rows, 'metric2_pii_precision'))} / {_fmt(_first(rows, 'metric2_pii_recall'))} |",
        f"| 3. Redaction precision / over-redaction rate | {_fmt(_first(rows, 'metric3_redaction_precision'))} / {_fmt(_first(rows, 'metric3_over_redaction_rate'))} |",
        f"| 4. Client resources (MB) | {_fmt(_first(rows, 'metric4_client_resource_mb'))} |",
        f"| 5. Latency p50 / p95 (ms) | {_fmt(_first(rows, 'metric5_latency_p50_ms'))} / {_fmt(_first(rows, 'metric5_latency_p95_ms'))} |",
        f"| Leak count | {_fmt(_first(rows, 'leak_count'))} |",
        "",
        "## Per-screen rows",
        "",
        "| screen_id | fixture load ms | peak RSS MB | peak CPU % |",
        "|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row.screen_id} | {_fmt(row.fixture_load_ms)} | {_fmt(row.peak_rss_mb)} | {_fmt(row.peak_cpu_pct)} |"
        )

    out_path.write_text("\n".join(lines) + "\n")
    return out_path


def _first(rows: list[ReportRow], attr: str):
    return getattr(rows[0], attr) if rows else None


def _fmt(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)
