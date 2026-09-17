"""design.md §4.7 — the one error envelope shape, and the HTTP-status → code table (T-2.42).
Every raise site in this codebase should raise `GatewayError`, never a bare `HTTPException`, so
the envelope (and its `request_id`) is always built the same way, in one place.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse


class GatewayError(Exception):
    def __init__(self, status_code: int, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable


# design.md §4.7's table, each row a distinct client-visible outcome.
def schema_invalid(message: str) -> GatewayError:
    return GatewayError(400, "SCHEMA_INVALID", message, retryable=False)


def unauthorized() -> GatewayError:
    return GatewayError(401, "UNAUTHORIZED", "Missing or invalid bearer token", retryable=False)


def session_not_found(session_id: str) -> GatewayError:
    return GatewayError(404, "SESSION_NOT_FOUND", f"No session {session_id}", retryable=False)


def step_out_of_order(step_id: str) -> GatewayError:
    return GatewayError(409, "STEP_OUT_OF_ORDER", f"Step {step_id} is not newer than the last seen step", retryable=False)


def payload_too_large(limit_mb: int) -> GatewayError:
    return GatewayError(413, "PAYLOAD_TOO_LARGE", f"Body exceeds {limit_mb} MB", retryable=True)


def plan_invalid(message: str) -> GatewayError:
    return GatewayError(422, "PLAN_INVALID", message, retryable=False)


def rate_limited() -> GatewayError:
    return GatewayError(429, "RATE_LIMITED", "Too many steps for this session", retryable=True)


def model_unavailable() -> GatewayError:
    return GatewayError(503, "MODEL_UNAVAILABLE", "Model server unreachable and no replay match", retryable=True)


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
    response = JSONResponse(status_code=exc.status_code, content=body)
    request_id = request_id_of(request)
    if request_id:
        response.headers["X-Request-Id"] = request_id
    return response
