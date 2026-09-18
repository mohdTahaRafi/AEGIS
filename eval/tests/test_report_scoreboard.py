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
