"""Settings loaded from the environment."""

from __future__ import annotations

import pytest
from aegis_gateway.config import load_settings


def test_vision_cannot_be_switched_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AEGIS_MODEL_VISION", "false")
    with pytest.raises(ValueError, match="AEGIS_MODEL_VISION"):
        load_settings()


def test_vision_on_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AEGIS_MODEL_VISION", "true")
    assert load_settings().mode == "replay"
