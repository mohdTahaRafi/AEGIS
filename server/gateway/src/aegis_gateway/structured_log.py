"""T-2.41 — structured server logs, closed vocabulary. Numbers, enums, versions, request ids —
never page text or node names. Full sanitized payloads are logged only behind the explicit
`AEGIS_LOG_PAYLOADS=true` opt-in, and even then it's still the *sanitized* context, never
anything from before the Phase-2 guard stub (which itself does no sanitizing — this flag exists
for gateway-side debugging of the wire format, not as a way around that).
"""

from __future__ import annotations

import json
import logging
import time

logger = logging.getLogger("aegis_gateway")


def log_event(event: str, request_id: str | None = None, **fields: object) -> None:
    """`fields` values must themselves be closed-vocabulary (numbers, bools, short enum-like
    strings) — this function does not scrub free text; callers are responsible, exactly as
    apps/extension/src/shared/logger.ts's `log()` puts that burden on its own callers."""
    record = {"event": event, "request_id": request_id, "ts": time.time(), **fields}
    logger.info(json.dumps(record))


def log_payload(step_request: dict, enabled: bool) -> None:
    if enabled:
        logger.info(json.dumps({"event": "payload", "payload": step_request}))
