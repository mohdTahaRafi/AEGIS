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
    wrong). No existing test caught it because `test_write_scoreboard_*` above call `write_scoreboard`
    directly with a hand-built `Provenance`, never through `score_and_write_scoreboard`'s own wiring
    from the run's actual `split` argument."""
    from aegis_eval.runner.main import score_and_write_scoreboard

    out_path = score_and_write_scoreboard(
        ledger_exports={}, run_dir=tmp_path, date="2026-01-01",
        hardware="test-machine", browser_version="128.0", split="heldout",
    )
    text = out_path.read_text()
    assert "**split:** heldout" in text
    assert "**split:** dev" not in text
