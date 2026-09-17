"""The report row shape. Every row carries its provenance (FR-54, design.md §18.2): n, split,
hardware, browser version, backend, model/policy versions, date — from the first Phase-1 run
onward, not added later once there is something to measure. Metric fields exist now and are
populated starting Phase 5 (design.md §18.2's five metrics plus leak count)."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class ReportRow:
    # Provenance — populated every run.
    date: str
    split: str
    screen_id: str
    hardware: str
    browser: str
    browser_version: str
    extension_version: str
    backend: str | None = None
    policy_version: str | None = None
    model_versions: str | None = None

    # Phase 1 operational diagnostics — not one of the five official metrics, kept separate from
    # them below so a reader never mistakes "page loaded in 42 ms" for a latency metric.
    fixture_load_ms: float | None = None
    peak_rss_mb: float | None = None
    mean_rss_mb: float | None = None
    peak_cpu_pct: float | None = None
    mean_cpu_pct: float | None = None
    ledger_export_path: str | None = None

    # The five official metrics + leak count (design.md §18.2). None until Phase 5.
    metric1_visual_context_accuracy: float | None = None
    metric2_pii_precision: float | None = None
    metric2_pii_recall: float | None = None
    metric3_redaction_precision: float | None = None
    metric3_over_redaction_rate: float | None = None
    metric4_client_resource_mb: float | None = None
    metric5_latency_p50_ms: float | None = None
    metric5_latency_p95_ms: float | None = None
    leak_count: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)
