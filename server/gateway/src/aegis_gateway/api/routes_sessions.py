"""design.md §4.1/§4.2 (T-2.32) — POST /v1/sessions and DELETE /v1/sessions/{id}. The request body
carries client capabilities only — no page data (architecture §8.1) — so these two routes never
touch the guard, the validator, or the model client at all."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..config import Settings
from ..protocol.session import Limits, SessionCreate, SessionCreated
from ..sessions.store import SessionStore
from .deps import get_session_store, get_settings

router = APIRouter()

MAX_IMAGE_PX = 1_600_000  # design.md §4.2's example value; Phase 4 owns the real image path


@router.post("/v1/sessions", status_code=201, response_model=SessionCreated)
def create_session(
    body: SessionCreate,
    settings: Settings = Depends(get_settings),
    store: SessionStore = Depends(get_session_store),
) -> SessionCreated:
    max_steps = 30  # design.md §4.2: "a safety budget [TD] with a configurable default"
    session = store.create(model=settings.model_name, max_steps=max_steps)
    return SessionCreated(session_id=session.session_id, model=session.model, limits=Limits(max_steps=max_steps, max_image_px=MAX_IMAGE_PX))


@router.delete("/v1/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, store: SessionStore = Depends(get_session_store)) -> Response:
    store.delete(session_id)
    return Response(status_code=204)
