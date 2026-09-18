from aegis_eval.runner.resources import ResourceSample
from aegis_eval.scorers.metric4 import bundled_model_mb_from_manifest, percentile, score_metric4


def test_percentile_p50_of_sorted_sample() -> None:
    assert percentile([10, 20, 30, 40, 50], 50) == 30


def test_percentile_empty_is_none() -> None:
    assert percentile([], 95) is None


def test_bundled_model_mb_sums_manifest_bytes() -> None:
    manifest = {"models": [{"bytes": 232589}, {"bytes": 1000000}]}
    mb = bundled_model_mb_from_manifest(manifest)
    assert mb == (232589 + 1000000) / (1024 * 1024)


def test_score_metric4_with_no_samples_reports_none_not_zero() -> None:
    result = score_metric4(bundled_model_mb=21.4, task_sample=None, idle_sample=None)
    assert result.task_peak_rss_mb is None
    assert result.idle_cpu_mean_pct is None
    assert result.gpu_time_ms is None  # "not available," never silently 0


def test_score_metric4_aggregates_real_samples() -> None:
    task = ResourceSample(
        peak_rss_mb=200, mean_rss_mb=150, peak_cpu_pct=40, mean_cpu_pct=20, n_samples=10,
        n_processes=4, cpu_samples_pct=[10, 20, 30, 40], rss_samples_mb=[100, 150, 200],
    )
    idle = ResourceSample(
        peak_rss_mb=100, mean_rss_mb=90, peak_cpu_pct=1, mean_cpu_pct=0.2, n_samples=10,
        n_processes=4, cpu_samples_pct=[0, 0, 1], rss_samples_mb=[90, 100],
    )
    result = score_metric4(bundled_model_mb=21.4, task_sample=task, idle_sample=idle)
    assert result.task_peak_rss_mb == 200
    assert result.task_cpu_p95_pct is not None
    assert result.idle_cpu_mean_pct == 0.2
