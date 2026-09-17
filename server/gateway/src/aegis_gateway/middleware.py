"""T-2.31 — request id echo and body-size limit. Both apply to every request, before auth or
routing, so a 413 or the X-Request-Id header behave identically regardless of which route is hit.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Uses the client's `X-Request-Id` if present (design.md §4.1: "client-generated UUID,
    echoed back"), otherwise generates one — every response gets the header either way."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        return response


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, max_body_mb: int) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.max_bytes = max_body_mb * 1024 * 1024
        self.max_body_mb = max_body_mb

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        content_length = request.headers.get("content-length")
        if content_length is not None and int(content_length) > self.max_bytes:
            # Read the header directly rather than `request.state.request_id` — middleware
            # ordering in Starlette means this may run before RequestIdMiddleware sets it.
            request_id = request.headers.get("X-Request-Id")
            return JSONResponse(
                status_code=413,
                content={
                    "error": {
                        "code": "PAYLOAD_TOO_LARGE",
                        "message": f"Body exceeds {self.max_body_mb} MB",
                        "request_id": request_id,
                        "retryable": True,
                    }
                },
                headers={"X-Request-Id": request_id} if request_id else None,
            )
        return await call_next(request)
