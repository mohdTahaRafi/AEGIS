"""FastAPI app factory (architecture.md §8.2, design.md §12, phase_2_spine.md §6, T-2.31/T-2.32)."""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError

from .api import routes_health, routes_sessions, routes_steps
from .auth import make_require_token
from .config import Settings, load_settings
from .errors import GatewayError, gateway_error_handler, request_validation_error_handler
from .middleware import BodySizeLimitMiddleware, RequestIdMiddleware
from .model_client.vllm import VLLMClient
from .replay.store import ReplayStore
from .sessions.store import SessionStore


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(title="AEGIS Agent Gateway", version="0.1.0")

    app.state.settings = settings
    app.state.session_store = SessionStore(ttl_s=settings.session_ttl_s)
    app.state.replay_store = ReplayStore(settings.record_dir)
    app.state.model_client = VLLMClient(settings)

    app.add_middleware(BodySizeLimitMiddleware, max_body_mb=settings.max_body_mb)
    app.add_middleware(RequestIdMiddleware)

    app.add_exception_handler(GatewayError, gateway_error_handler)
    app.add_exception_handler(RequestValidationError, request_validation_error_handler)

    require_token = make_require_token(settings)
    app.include_router(routes_health.router)
    app.include_router(routes_sessions.router, dependencies=[Depends(require_token)])
    app.include_router(routes_steps.router, dependencies=[Depends(require_token)])

    return app


app = create_app()
