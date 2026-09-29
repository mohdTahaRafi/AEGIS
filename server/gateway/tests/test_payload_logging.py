"""R-2 (A5, logging half): even with AEGIS_LOG_PAYLOADS=true, image bytes are never logged."""

from __future__ import annotations

import logging

from aegis_gateway.main import create_app
from aegis_gateway.structured_log import log_payload, logger

from .conftest import make_settings, sanitized_context_body


def test_log_payload_never_writes_image_bytes(caplog) -> None:
    step = sanitized_context_body(
        image={
            "level": "L1",
            "region": [0, 0, 10, 10],
            "scale": 1,
            "format": "image/webp",
            "sha256": "0" * 64,
            "data": "QUJDREVGR0g=",
            "legend": "x",
        }
    )
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_payload(step, enabled=True)
    assert "QUJDREVGR0g=" not in caplog.text
    assert "<12 b64 chars>" in caplog.text


def test_log_payload_is_silent_when_disabled(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_payload(sanitized_context_body(), enabled=False)
    assert caplog.text == ""


def test_structured_events_are_actually_emitted() -> None:
    """They used to be dropped: the logger had no handler, and INFO is below the last-resort
    handler's WARNING threshold."""
    create_app(make_settings())
    create_app(make_settings())
    assert len(logger.handlers) == 1
    assert isinstance(logger.handlers[0], logging.StreamHandler)
    assert logger.isEnabledFor(logging.INFO)
