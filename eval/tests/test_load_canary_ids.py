"""design.md §7.6 step 6 / T-5.8 — loading a screen's own labelled canary ids to feed the real
guard's debug/harness-only check (phase_5_measurement.md §16a)."""

from __future__ import annotations

import json

from aegis_eval.runner.main import load_canary_ids


def test_loads_canary_ids_from_a_real_label_file() -> None:
    # hardneg-001 is a real corpus fixture with exactly one planted canary.
    ids = load_canary_ids("hardneg-001")
    assert len(ids) == 1
    assert ids[0].startswith("CANARY")


def test_returns_empty_list_for_a_screen_with_no_label_file() -> None:
    assert load_canary_ids("no-such-screen-999") == []


def test_ignores_items_without_canary_true(tmp_path, monkeypatch) -> None:
    from aegis_eval.runner import main as main_module

    fake_labels_dir = tmp_path
    monkeypatch.setattr(main_module, "LABELS_DIR", fake_labels_dir)
    label = {
        "screen_id": "fake-001",
        "items": [
            {"entity": "EMAIL", "box": [0, 0, 1, 1], "value_hash": "sha256:" + "0" * 64},
            {"entity": "UNKNOWN_SENSITIVE", "box": [0, 0, 1, 1], "canary": True, "canary_id": "CANARYABC"},
        ],
    }
    (fake_labels_dir / "fake-001.json").write_text(json.dumps(label))

    assert load_canary_ids("fake-001") == ["CANARYABC"]
