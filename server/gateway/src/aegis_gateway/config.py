"""design.md §12.4 — gateway configuration, entirely from environment variables. A plain
dataclass rather than pydantic-settings: this is the only place the process reads os.environ,
and adding a dependency just to avoid one `load_settings()` function is not worth it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

Mode = Literal["live", "record", "replay"]
ResponseFormat = Literal["json_schema", "json_object", "none"]
PointFormat = Literal["rel1000_long_side", "rel1000", "image_px"]


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
    # R-2. `repr=False` keeps the key out of repr(settings), so out of any log or traceback.
    model_api_key: str | None = field(default=None, repr=False)
    model_max_tokens: int = 512
    # R-3. What differs between endpoints is these two behaviours, not a vendor name. Groq (the
    # R-1 endpoint) answers HTTP 400 to `chat_template_kwargs` and to strict json_schema.
    model_response_format: ResponseFormat = "json_object"
    model_chat_template_kwargs: bool = False
    # R-1 reliability: one bounded retry on an upstream 429 or a dropped connection.
    model_max_retries: int = 1
    model_retry_max_wait_s: float = 10.0
    # Groq's switch for Qwen's thinking ("none" = off). Hidden reasoning tokens count against the
    # completion budget and the daily token quota. Unset: not sent.
    model_reasoning_effort: str | None = None
    # None = the endpoint's default. 0 for Groq: its default sampling made the model open an
    # "explain this page" answer in prose often enough for JSON mode to reject it.
    model_temperature: float | None = None
    # How the model answers click_point coordinates. Measured for qwen/qwen3.8-27b on Groq
    # (tools/vlm/reports/r1-2026-09-28-groq-grounding-grid.json, n=4, max residual 4 px): both axes
    # in 0-1000 units of the image's LONG side.
    model_point_format: PointFormat = "rel1000_long_side"
    # Other VISION models on the same endpoint (budgets are per model upstream): a step goes to one
    # when the primary's per-minute budget would make it wait. Every route is sent the screenshot;
    # a text-only model must never be listed here. Empty = the primary only.
    model_fallbacks: tuple[str, ...] = ()
    # The primary is waited for up to this long before a step goes to a fallback instead.
    model_primary_max_wait_s: float = 4.0
    # What one screenshot costs against the per-minute token budget. Measured on Groq for
    # qwen/qwen3.8-27b (2026-09-30): 1,807 prompt tokens billed, for every size from 512 to 1236 px
    # wide and with detail "low" alike, and the same 1,807 deducted from the budget a second time
    # just after the response. A request is admitted only when all of it fits.
    model_image_budget_tokens: int = 3600
    # How long a step may wait at the gateway for the model's per-minute budget to refill, instead
    # of being sent into a 429. Above it the client is told to retry after the wait.
    model_budget_max_wait_s: float = 60.0


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes")


def load_settings() -> Settings:
    mode = os.environ.get("AEGIS_MODE", "replay")
    if mode not in ("live", "record", "replay"):
        raise ValueError(f"AEGIS_MODE must be live|record|replay, got {mode!r}")

    response_format = os.environ.get("AEGIS_MODEL_RESPONSE_FORMAT", "json_object")
    if response_format not in ("json_schema", "json_object", "none"):
        raise ValueError(
            "AEGIS_MODEL_RESPONSE_FORMAT must be json_schema|json_object|none, "
            f"got {response_format!r}"
        )

    # Every step's redacted screenshot goes to the vision model; there is no text-only mode.
    if not _env_bool("AEGIS_MODEL_VISION", True):
        raise ValueError(
            "AEGIS_MODEL_VISION=false is not supported: every step sends its redacted "
            "screenshot to the vision model"
        )

    point_format = os.environ.get("AEGIS_MODEL_POINT_FORMAT", "rel1000_long_side")
    if point_format not in ("rel1000_long_side", "rel1000", "image_px"):
        raise ValueError(
            "AEGIS_MODEL_POINT_FORMAT must be rel1000_long_side|rel1000|image_px, "
            f"got {point_format!r}"
        )

    return Settings(
        token=os.environ.get("AEGIS_TOKEN", "dev-token"),
        # R-1 decision: Groq free tier, the only vision model it serves (docs/planning/bugs/R-1).
        model_url=os.environ.get("AEGIS_MODEL_URL", "https://api.groq.com/openai/v1"),
        model_name=os.environ.get("AEGIS_MODEL_NAME", "qwen/qwen3.8-27b"),
        mode=mode,  # type: ignore[arg-type]
        record_dir=os.environ.get("AEGIS_RECORD_DIR", "./replay-store"),
        session_ttl_s=int(os.environ.get("AEGIS_SESSION_TTL_S", "900")),
        max_body_mb=int(os.environ.get("AEGIS_MAX_BODY_MB", "4")),
        log_payloads=_env_bool("AEGIS_LOG_PAYLOADS", False),
        model_timeout_s=float(os.environ.get("AEGIS_MODEL_TIMEOUT_S", "30")),
        model_api_key=os.environ.get("AEGIS_MODEL_API_KEY") or None,
        model_max_tokens=int(os.environ.get("AEGIS_MODEL_MAX_TOKENS", "512")),
        model_response_format=response_format,  # type: ignore[arg-type]
        model_chat_template_kwargs=_env_bool("AEGIS_MODEL_CHAT_TEMPLATE_KWARGS", False),
        model_max_retries=int(os.environ.get("AEGIS_MODEL_MAX_RETRIES", "1")),
        model_retry_max_wait_s=float(os.environ.get("AEGIS_MODEL_RETRY_MAX_WAIT_S", "10")),
        model_reasoning_effort=os.environ.get("AEGIS_MODEL_REASONING_EFFORT") or None,
        model_temperature=(
            float(os.environ["AEGIS_MODEL_TEMPERATURE"])
            if os.environ.get("AEGIS_MODEL_TEMPERATURE")
            else None
        ),
        model_point_format=point_format,  # type: ignore[arg-type]
        model_fallbacks=tuple(
            name.strip()
            for name in os.environ.get("AEGIS_MODEL_FALLBACKS", "").split(",")
            if name.strip()
        ),
        model_primary_max_wait_s=float(os.environ.get("AEGIS_MODEL_PRIMARY_MAX_WAIT_S", "4")),
        model_image_budget_tokens=int(os.environ.get("AEGIS_MODEL_IMAGE_BUDGET_TOKENS", "3600")),
        model_budget_max_wait_s=float(os.environ.get("AEGIS_MODEL_BUDGET_MAX_WAIT_S", "60")),
    )
