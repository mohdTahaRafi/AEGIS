"""T-2.41 AC: closed vocabulary; no page text or node names; sanitized payloads logged only
when AEGIS_LOG_PAYLOADS=true."""

from __future__ import annotations

import json
import logging

from aegis_gateway.structured_log import log_event, log_payload

from .conftest import sanitized_context_body


def test_log_event_emits_a_single_json_object_with_only_closed_vocabulary_fields(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_event("step_processed", request_id="req-1", mode="replay", step_number=3)

    assert len(caplog.records) == 1
    record = json.loads(caplog.records[0].message)
    assert record["event"] == "step_processed"
    assert record["request_id"] == "req-1"
    assert record["mode"] == "replay"
    assert record["step_number"] == 3
    assert "ts" in record


def test_log_payload_is_silent_by_default(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_payload(sanitized_context_body(), enabled=False)
    assert len(caplog.records) == 0


def test_log_payload_logs_the_sanitized_context_only_when_explicitly_enabled(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_payload(sanitized_context_body(), enabled=True)
    assert len(caplog.records) == 1
    record = json.loads(caplog.records[0].message)
    assert record["event"] == "payload"
    assert record["payload"]["task"] == "log in and submit the form"
