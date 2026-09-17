"""design.md §12.4 — gateway configuration, entirely from environment variables. A plain
dataclass rather than pydantic-settings: this is the only place the process reads os.environ,
and adding a dependency just to avoid one `load_settings()` function is not worth it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

Mode = Literal["live", "record", "replay"]


@dataclass(frozen=True)
class Settings:
    token: str
    model_url: str
    model_name: str
    mode: Mode
    record_dir: str
    session_ttl_s: int
    max_body_mb: int
    log_payloads: bool
    model_timeout_s: float


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes")


def load_settings() -> Settings:
    mode = os.environ.get("AEGIS_MODE", "replay")
    if mode not in ("live", "record", "replay"):
        raise ValueError(f"AEGIS_MODE must be live|record|replay, got {mode!r}")

    return Settings(
        token=os.environ.get("AEGIS_TOKEN", "dev-token"),
        model_url=os.environ.get("AEGIS_MODEL_URL", "http://localhost:8000/v1"),
        model_name=os.environ.get("AEGIS_MODEL_NAME", "qwen3-vl-8b-instruct"),
        mode=mode,  # type: ignore[arg-type]
        record_dir=os.environ.get("AEGIS_RECORD_DIR", "./replay-store"),
        session_ttl_s=int(os.environ.get("AEGIS_SESSION_TTL_S", "900")),
        max_body_mb=int(os.environ.get("AEGIS_MAX_BODY_MB", "4")),
        log_payloads=_env_bool("AEGIS_LOG_PAYLOADS", False),
        model_timeout_s=float(os.environ.get("AEGIS_MODEL_TIMEOUT_S", "20")),
    )
