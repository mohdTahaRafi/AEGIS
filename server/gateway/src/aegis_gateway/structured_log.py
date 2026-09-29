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


def configure_logging() -> None:
    """Every record is one JSON line on stderr. Without a handler of its own, this logger's INFO
    records fell through to Python's last-resort handler, which prints WARNING and above only:
    no structured event (step_processed, model_error, ...) was ever written (found 2026-09-28).
    Idempotent, so create_app() can be called once per test."""
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def log_event(event: str, request_id: str | None = None, **fields: object) -> None:
    """`fields` values must themselves be closed-vocabulary (numbers, bools, short enum-like
    strings) — this function does not scrub free text; callers are responsible, exactly as
    apps/extension/src/shared/logger.ts's `log()` puts that burden on its own callers."""
    record = {"event": event, "request_id": request_id, "ts": time.time(), **fields}
    logger.info(json.dumps(record))


def _without_image_bytes(step_request: dict) -> dict:
    image = step_request.get("image")
    if not image:
        return step_request
    data = image.get("data", "")
    return {**step_request, "image": {**image, "data": f"<{len(data)} b64 chars>"}}


def log_payload(step_request: dict, enabled: bool) -> None:
    if enabled:
        payload = _without_image_bytes(step_request)
        logger.info(json.dumps({"event": "payload", "payload": payload}))
