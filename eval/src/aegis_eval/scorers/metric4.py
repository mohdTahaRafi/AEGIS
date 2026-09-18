"""design.md §18.2, metric 4 — client resources: bundled model MB (from the manifest); peak and
mean memory during a task; CPU% mean and p95 during a task and at idle; GPU time where available.
Each figure carries the machine and browser version (design.md's provenance rule) — this module
computes the numbers, `report/rows.py`/`report/scoreboard.py` attach the provenance.

This is pure aggregation over already-collected samples (`runner/resources.py`'s `ResourceSample`)
— it has no opinion about how those samples were collected, so it is fully testable without a real
browser or reference hardware, even though the SAMPLES themselves need both (OQ-16)."""

from __future__ import annotations

from dataclasses import dataclass

from aegis_eval.runner.resources import ResourceSample


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    idx = min(len(sorted_values) - 1, max(0, round((p / 100) * (len(sorted_values) - 1))))
    return sorted_values[idx]


@dataclass
class Metric4Result:
    bundled_model_mb: float
    task_peak_rss_mb: float | None
    task_mean_rss_mb: float | None
    task_cpu_mean_pct: float | None
    task_cpu_p95_pct: float | None
    idle_cpu_mean_pct: float | None
    idle_cpu_p95_pct: float | None
    gpu_time_ms: float | None  # None means "not available on this run," never "zero"


def score_metric4(
    bundled_model_mb: float,
    task_sample: ResourceSample | None,
    idle_sample: ResourceSample | None,
    gpu_time_ms: float | None = None,
) -> Metric4Result:
    return Metric4Result(
        bundled_model_mb=bundled_model_mb,
        task_peak_rss_mb=task_sample.peak_rss_mb if task_sample else None,
        task_mean_rss_mb=task_sample.mean_rss_mb if task_sample else None,
        task_cpu_mean_pct=task_sample.mean_cpu_pct if task_sample else None,
        task_cpu_p95_pct=percentile(task_sample.cpu_samples_pct, 95) if task_sample else None,
        idle_cpu_mean_pct=idle_sample.mean_cpu_pct if idle_sample else None,
        idle_cpu_p95_pct=percentile(idle_sample.cpu_samples_pct, 95) if idle_sample else None,
        gpu_time_ms=gpu_time_ms,
    )


def bundled_model_mb_from_manifest(manifest: dict) -> float:
    """Sums `bytes` across every entry in `models.manifest.json`'s `models[]` — metric 4's
    headline number (phase_4_vision.md §13)."""
    total_bytes = sum(m.get("bytes", 0) for m in manifest.get("models", []))
    return total_bytes / (1024 * 1024)
