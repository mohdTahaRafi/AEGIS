"""design.md §4.7 — the one error envelope shape, and the HTTP-status → code table (T-2.42).
Every raise site in this codebase should raise `GatewayError`, never a bare `HTTPException`, so
the envelope (and its `request_id`) is always built the same way, in one place.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class GatewayError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.headers = headers or {}


# design.md §4.7's table, each row a distinct client-visible outcome.
def schema_invalid(message: str) -> GatewayError:
    return GatewayError(400, "SCHEMA_INVALID", message, retryable=False)


def unauthorized() -> GatewayError:
    return GatewayError(401, "UNAUTHORIZED", "Missing or invalid bearer token", retryable=False)


def session_not_found(session_id: str) -> GatewayError:
    return GatewayError(404, "SESSION_NOT_FOUND", f"No session {session_id}", retryable=False)


def step_out_of_order(step_id: str) -> GatewayError:
    return GatewayError(
        409,
        "STEP_OUT_OF_ORDER",
        f"Step {step_id} is not newer than the last seen step",
        retryable=False,
    )


def payload_too_large(limit_mb: int) -> GatewayError:
    return GatewayError(413, "PAYLOAD_TOO_LARGE", f"Body exceeds {limit_mb} MB", retryable=True)


def unsanitized_context(entities: list[str]) -> GatewayError:
    # Entity names only: the matched text is never echoed back or logged.
    return GatewayError(
        422,
        "UNSANITIZED_CONTEXT",
        f"Step carries unredacted {', '.join(entities)}; nothing was sent to the model",
        retryable=False,
    )


def plan_invalid(message: str) -> GatewayError:
    return GatewayError(422, "PLAN_INVALID", message, retryable=False)


def rate_limited() -> GatewayError:
    return GatewayError(429, "RATE_LIMITED", "Too many steps for this session", retryable=True)


# R-3 A5: `reason` is closed vocabulary — no_replay_match | unreachable | upstream_429 |
# upstream_5xx | bad_body (transient: retryable) and upstream_auth | upstream_too_large |
# upstream_4xx (permanent: the same request fails the same way again, so not retryable). `detail`
# is built only from numbers, HTTP statuses and the upstream's own `[a-z_]` error code, so the
# message stays safe to show and to log.
def model_unavailable(
    reason: str = "no_replay_match",
    *,
    retry_after_s: float | None = None,
    retryable: bool = True,
    detail: str | None = None,
) -> GatewayError:
    headers = {"Retry-After": str(max(1, round(retry_after_s)))} if retry_after_s else None
    message = f"Model unavailable: {reason}" + (f" ({detail})" if detail else "")
    return GatewayError(
        503 if retryable else 502,
        "MODEL_UNAVAILABLE",
        message,
        retryable=retryable,
        headers=headers,
    )


class ModelRequestTooLarge(GatewayError):
    """The upstream refused this request's size (Groq: HTTP 413, input tokens over the
    per-minute limit). Permanent for these exact messages; the route may rebuild them smaller."""

    def __init__(self, limit: int | None, requested: int | None) -> None:
        detail = (
            f"input {requested} tokens > limit {limit} per minute"
            if limit and requested
            else "request too large"
        )
        base = model_unavailable("upstream_too_large", retryable=False, detail=detail)
        super().__init__(base.status_code, base.code, base.message, retryable=False)
        self.limit = limit
        self.requested = requested


def model_timeout() -> GatewayError:
    return GatewayError(504, "MODEL_TIMEOUT", "Model exceeded its deadline", retryable=True)


def request_id_of(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


async def gateway_error_handler(request: Request, exc: GatewayError) -> JSONResponse:
    body = {
        "error": {
            "code": exc.code,
            "message": exc.message,
            "request_id": request_id_of(request),
            "retryable": exc.retryable,
        }
    }
    response = JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers)
    request_id = request_id_of(request)
    if request_id:
        response.headers["X-Request-Id"] = request_id
    return response


async def request_validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's own body-parameter validation (a route declared with a pydantic-model
    parameter, e.g. `routes_sessions.create_session`) raises this and, left unhandled, answers
    with FastAPI's own 422 shape — not design.md §4.7's `{"error": {...}}` 400 `SCHEMA_INVALID`
    contract. Routes that manually call `Model.model_validate(body)` inside the handler (e.g.
    `routes_steps.post_step`) never hit this; it exists as the catch-all for any route that
    doesn't, present or future."""
    return await gateway_error_handler(request, schema_invalid(str(exc)))
