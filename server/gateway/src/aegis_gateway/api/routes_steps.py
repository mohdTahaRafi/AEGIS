"""design.md §4.1/§12.3 (T-2.32, T-2.38, T-2.39, T-2.40) — POST /v1/sessions/{id}/steps: one
sanitized observation in, one plan out. Strict schema validation (T-2.33), step-lease ordering,
a per-session rate limit, the prompt build, the model call (or replay lookup), post-validation
with one retry, and a `Server-Timing` breakdown on the response.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ..config import Settings
from ..errors import (
    model_unavailable,
    plan_invalid,
    rate_limited,
    schema_invalid,
    session_not_found,
    step_out_of_order,
)
from ..model_client.vllm import VLLMClient
from ..prompt import build_messages
from ..protocol.action_plan import ActionPlan
from ..protocol.sanitized_context import SanitizedContext
from ..replay.store import ReplayStore
from ..sessions.store import Session, SessionStore
from ..structured_log import log_event, log_payload
from ..validation.post_validate import PostValidationError, validate_plan_against_session
from .deps import get_model_client, get_replay_store, get_session_store, get_settings

router = APIRouter()

RATE_LIMIT_WINDOW_S = 1.0
RATE_LIMIT_MAX_PER_WINDOW = 5

# Per-session sliding-window request timestamps. Module-level and keyed by session id (not stored
# on Session itself) because it's rate-limiting infrastructure, not step context — deliberately
# separate so `Session` stays about "what has this session seen", not "how fast is it calling us".
_recent_request_times: dict[str, list[float]] = {}


def _check_rate_limit(session_id: str, now: float) -> None:
    timestamps = _recent_request_times.setdefault(session_id, [])
    timestamps[:] = [t for t in timestamps if now - t < RATE_LIMIT_WINDOW_S]
    if len(timestamps) >= RATE_LIMIT_MAX_PER_WINDOW:
        raise rate_limited()
    timestamps.append(now)


def _step_number(step_id: str) -> int:
    return int(step_id.split("-", 1)[1])


def _validate_candidate_plan(plan: dict, session: Session) -> ActionPlan:
    validated = ActionPlan.model_validate(plan)
    validate_plan_against_session(plan, session)
    return validated


async def _get_plan(
    messages: list[dict],
    settings: Settings,
    replay_store: ReplayStore,
    model_client: VLLMClient,
    step_dict: dict,
) -> dict:
    if settings.mode == "replay":
        plan = replay_store.lookup(step_dict)
        if plan is None:
            raise model_unavailable()
        return plan
    plan = await model_client.complete(messages)
    if settings.mode == "record":
        replay_store.record(step_dict, plan)
    return plan


@router.post("/v1/sessions/{session_id}/steps")
async def post_step(
    session_id: str,
    request: Request,
    settings: Settings = Depends(get_settings),
    store: SessionStore = Depends(get_session_store),
    replay_store: ReplayStore = Depends(get_replay_store),
    model_client: VLLMClient = Depends(get_model_client),
) -> JSONResponse:
    t_start = time.perf_counter()
    raw_body = await request.json()
    try:
        step_request = SanitizedContext.model_validate(raw_body)
    except ValidationError as exc:
        raise schema_invalid(str(exc)) from exc

    session = store.get(session_id)
    if session is None:
        raise session_not_found(session_id)

    _check_rate_limit(session_id, time.time())

    if session.last_step_id is not None and _step_number(step_request.step_id) <= _step_number(
        session.last_step_id
    ):
        raise step_out_of_order(step_request.step_id)

    step_dict = step_request.model_dump(by_alias=True, mode="json")
    log_payload(step_dict, settings.log_payloads)

    # Applied *before* the model is even asked: the plan it returns is a reaction to exactly this
    # context, so post-validation (§12.3) must check it against nodes/refs/affordances as of *this*
    # step, not just prior ones — otherwise every single-step session would fail post-validation
    # for referencing the very nodes it was just shown.
    session.apply_step_context(
        step_id=step_request.step_id,
        nodes=step_dict.get("nodes", []),
        removed=step_dict.get("removed") or [],
        redactions=step_dict.get("redactions", []),
        image_region=step_dict["image"]["region"] if step_dict.get("image") else None,
        viewport=step_dict["viewport"],
    )
    store.touch(session_id)

    # design.md §4.1's Server-Timing components: queue (everything before prompt-building — auth,
    # parsing, session/lease/rate checks all ran as FastAPI dependencies or above, before this
    # function even started timing "prompt"), prompt, model, validate.
    timings: dict[str, float] = {"queue": time.perf_counter() - t_start}

    t_prompt = time.perf_counter()
    messages = build_messages(step_dict)
    timings["prompt"] = time.perf_counter() - t_prompt

    t_model = time.perf_counter()
    plan = await _get_plan(messages, settings, replay_store, model_client, step_dict)
    timings["model"] = time.perf_counter() - t_model

    t_validate = time.perf_counter()
    try:
        _validate_candidate_plan(plan, session)
    except (ValidationError, PostValidationError) as first_error:
        retry_note = (
            f"Your previous output was invalid: {first_error}. "
            "Correct it and output only valid JSON."
        )
        retry_messages = [*messages, {"role": "system", "content": retry_note}]
        try:
            retry_step_dict = {**step_dict, "_retry_note": str(first_error)}
            plan = await _get_plan(
                retry_messages, settings, replay_store, model_client, retry_step_dict
            )
            _validate_candidate_plan(plan, session)
        except (ValidationError, PostValidationError) as second_error:
            raise plan_invalid(str(second_error)) from second_error
    timings["validate"] = time.perf_counter() - t_validate

    log_event(
        "step_processed",
        request_id=getattr(request.state, "request_id", None),
        mode=settings.mode,
        step_number=_step_number(step_request.step_id),
    )

    response = JSONResponse(content=plan)
    response.headers["Server-Timing"] = ", ".join(
        f"{name};dur={duration * 1000:.1f}" for name, duration in timings.items()
    )
    return response
