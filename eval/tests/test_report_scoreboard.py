from aegis_eval.report.scoreboard import Provenance, write_scoreboard
from aegis_eval.scorers.matching import Detection, GroundTruth
from aegis_eval.scorers.metric2 import score_metric2


def make_provenance() -> Provenance:
    return Provenance(
        date="2026-01-01",
        split="dev",
        hardware="test-machine",
        browser="chromium",
        browser_version="128.0",
        backend="wasm",
        policy_version="1",
        model_versions="face-yunet-2023mar",
    )


def test_write_scoreboard_with_no_data_states_not_measured(tmp_path) -> None:
    out = tmp_path / "scoreboard.md"
    write_scoreboard(out, make_provenance(), (None, None), None, None, None, None, None)
    text = out.read_text()
    assert "not measured" in text
    assert "AEGIS evaluation scoreboard" in text


def test_write_scoreboard_renders_real_metric2_data(tmp_path) -> None:
    out = tmp_path / "scoreboard.md"
    screens = [([Detection("EMAIL", (0, 0, 10, 10))], [GroundTruth("EMAIL", (0, 0, 10, 10))])]
    m2 = score_metric2(screens)
    write_scoreboard(out, make_provenance(), (None, None), m2, None, None, None, None)
    text = out.read_text()
    assert "EMAIL" in text
    assert "1.000" in text  # perfect precision/recall


def test_scoreboard_never_omits_leak_count_section() -> None:
    from aegis_eval.report.scoreboard import render_leak_count

    lines = render_leak_count(None)
    assert any("Leak count" in line for line in lines)


def test_score_and_write_scoreboard_reports_the_actual_split_it_was_run_against(tmp_path) -> None:
    """Regression test for a real bug found via a genuine held-out run (T-5.10, 2026-09-18):
    `runner/main.py`'s `score_and_write_scoreboard` used to hardcode `split="dev"` when building
    its `Provenance`, so a `--split heldout` run's own rich-scoreboard.md always printed
    `**split:** dev` regardless — a report-metadata bug, not a scoring bug (metric2/metric3/leak
    count were computed correctly against the real held-out payloads; only the displayed label was
    wrong). No existing test caught it because `test_write_scoreboard_*` above call
    `write_scoreboard` directly with a hand-built `Provenance`, never through
    `score_and_write_scoreboard`'s own wiring from the run's actual `split` argument."""
    from aegis_eval.runner.main import score_and_write_scoreboard

    out_path = score_and_write_scoreboard(
        ledger_exports={}, run_dir=tmp_path, date="2026-01-01",
        hardware="test-machine", browser_version="128.0", split="heldout",
    )
    text = out_path.read_text()
    assert "**split:** heldout" in text
    assert "**split:** dev" not in text


def test_score_and_write_scoreboard_computes_real_metric4_and_metric5(
    tmp_path, monkeypatch
) -> None:
    """Metrics 4 and 5 were left permanently `None` in `score_and_write_scoreboard` even though
    everything they need — `runner/resources.py`'s OS-level samples and `LedgerEntry.timings`'s
    real per-stage timestamps (`session.ts` computes these regardless of a live vs. mocked
    gateway) — was already being collected by every run. Found and fixed 2026-09-18 (phase
    doc §16i). This test locks in that the wiring actually produces real numbers, not just that
    the function doesn't crash."""
    import aegis_eval.runner.main as runner_main
    from aegis_eval.runner.main import score_and_write_scoreboard
    from aegis_eval.runner.resources import ResourceSample

    manifest_path = tmp_path / "models.manifest.json"
    manifest_path.write_text('{"models": [{"bytes": 1048576}]}')
    monkeypatch.setattr(runner_main, "MODELS_MANIFEST_PATH", manifest_path)

    ledger_exports = {
        "bank-001": [  # a real screen_id with a real label file — _load_label() needs one to exist
            {
                "stepId": "s-1",
                "payload": {"redactions": [], "viewport": {"w": 1280, "h": 720}},
                "timings": {
                    "observe": 10, "perceive": 5, "sanitize": 8, "guard": 3,
                    "server": 12, "validate": 2, "act": 1,
                },
                "guardVerdict": {"ok": True},
            }
        ]
    }
    task_sample = ResourceSample(
        peak_rss_mb=500.0, mean_rss_mb=400.0, peak_cpu_pct=20.0, mean_cpu_pct=10.0,
        n_samples=5, n_processes=3, rss_samples_mb=[400.0, 500.0], cpu_samples_pct=[10.0, 20.0],
    )
    idle_sample = ResourceSample(
        peak_rss_mb=300.0, mean_rss_mb=290.0, peak_cpu_pct=2.0, mean_cpu_pct=1.0,
        n_samples=5, n_processes=3, rss_samples_mb=[290.0, 300.0], cpu_samples_pct=[1.0, 2.0],
    )

    out_path = score_and_write_scoreboard(
        ledger_exports, run_dir=tmp_path, date="2026-01-01", hardware="test-machine",
        browser_version="128.0", split="dev",
        task_samples=[task_sample], idle_sample=idle_sample, task_wall_clock_ms=[41.0],
    )
    text = out_path.read_text()
    assert "Metric 4 — Client resources" in text
    assert "1.0" in text  # bundled model MB (1048576 bytes)
    assert "500.0" in text  # task peak RSS
    assert "Metric 5 — End-to-end latency" in text
    assert "n=1 steps, n=1 tasks" in text
    assert "not measured" not in text.split("Metric 4")[1].split("Metric 5")[0]
    assert "Not measured" not in text.split("Metric 5")[1].split("Leak count")[0]
