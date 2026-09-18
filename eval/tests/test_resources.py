from aegis_eval.runner.resources import ResourceSample, merge_samples


def test_merge_samples_pools_raw_series_not_just_aggregates() -> None:
    """merge_samples must recompute peak/mean from the pooled raw series, not average the
    per-fixture peaks (which would understate the true peak — see resources.py's own docstring
    for why this matters for metric 4's CPU p95)."""
    a = ResourceSample(
        peak_rss_mb=100.0, mean_rss_mb=90.0, peak_cpu_pct=10.0, mean_cpu_pct=8.0,
        n_samples=2, n_processes=3, rss_samples_mb=[80.0, 100.0], cpu_samples_pct=[6.0, 10.0],
    )
    b = ResourceSample(
        peak_rss_mb=150.0, mean_rss_mb=140.0, peak_cpu_pct=5.0, mean_cpu_pct=4.0,
        n_samples=2, n_processes=4, rss_samples_mb=[130.0, 150.0], cpu_samples_pct=[3.0, 5.0],
    )

    merged = merge_samples([a, b])

    assert merged is not None
    assert merged.peak_rss_mb == 150.0
    assert merged.mean_rss_mb == (80.0 + 100.0 + 130.0 + 150.0) / 4
    assert merged.peak_cpu_pct == 10.0
    assert merged.mean_cpu_pct == (6.0 + 10.0 + 3.0 + 5.0) / 4
    assert merged.n_processes == 4
    assert merged.rss_samples_mb == [80.0, 100.0, 130.0, 150.0]


def test_merge_samples_of_empty_list_is_none() -> None:
    assert merge_samples([]) is None
