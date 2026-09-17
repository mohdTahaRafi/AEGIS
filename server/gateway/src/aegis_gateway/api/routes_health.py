"""design.md §4.1 (T-2.32) — GET /healthz (liveness, gateway only) and GET /readyz (readiness:
model server reachable, or a loaded replay store)."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..config import Settings
from ..replay.store import ReplayStore
from .deps import get_replay_store, get_settings

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


async def _model_reachable(settings: Settings) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{settings.model_url}/models")
            return response.status_code < 500
    except httpx.HTTPError:
        return False


@router.get("/readyz")
async def readyz(
    settings: Settings = Depends(get_settings),
    replay_store: ReplayStore = Depends(get_replay_store),
) -> JSONResponse:
    if settings.mode == "replay":
        ready = replay_store.is_loaded()
    else:
        ready = await _model_reachable(settings)
    return JSONResponse(
        status_code=200 if ready else 503, content={"status": "ok" if ready else "not ready"}
    )
