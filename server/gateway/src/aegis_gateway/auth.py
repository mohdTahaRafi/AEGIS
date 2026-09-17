"""T-2.31 — bearer token on every /v1 call (design.md §4.1)."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Header

from .config import Settings
from .errors import unauthorized


def make_require_token(settings: Settings) -> Callable[[str | None], None]:
    def require_token(authorization: str | None = Header(default=None)) -> None:
        if authorization is None:
            raise unauthorized()
        scheme, _, token = authorization.partition(" ")
        if scheme != "Bearer" or token != settings.token:
            raise unauthorized()

    return require_token
