"""Shared FastAPI dependencies — every route reads its collaborators off `app.state` rather than
module-level globals, so tests can construct a fresh `create_app()` with its own state."""

from __future__ import annotations

from fastapi import Request

from ..config import Settings
from ..model_client.vllm import VLLMClient
from ..replay.store import ReplayStore
from ..sessions.store import SessionStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_session_store(request: Request) -> SessionStore:
    return request.app.state.session_store


def get_replay_store(request: Request) -> ReplayStore:
    return request.app.state.replay_store


def get_model_client(request: Request) -> VLLMClient:
    return request.app.state.model_client
