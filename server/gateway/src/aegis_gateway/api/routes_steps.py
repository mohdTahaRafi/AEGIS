"""design.md §4.1/§12.3 (T-2.32, T-2.38, T-2.39, T-2.40) — POST /v1/sessions/{id}/steps: one
sanitized observation in, one plan out. Strict schema validation (T-2.33), step-lease ordering,
a per-session rate limit, the prompt build, the model call (or replay lookup), post-validation
with one retry, and a `Server-Timing` breakdown on the response.
"""

from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ..config import Settings
from ..errors import (
    GatewayError,
    ModelRequestTooLarge,
    model_unavailable,
    plan_invalid,
    rate_limited,
    schema_invalid,
    session_not_found,
    step_out_of_order,
    unsanitized_context,
)
from ..model_client.adapters import image_point_to_viewport
from ..model_client.normalize import normalize_plan
from ..model_client.vllm import VLLMClient
from ..prompt import SYSTEM_PROMPT, build_messages, build_user_message
from ..prompt.aliases import resolve_aliases
from ..protocol.action_plan import ActionPlan
from ..protocol.sanitized_context import SanitizedContext
from ..replay.store import ReplayStore
from ..sessions.store import Session, SessionStore, record_typed
from ..structured_log import log_event, log_payload
from ..validation.post_validate import PostValidationError, validate_plan_against_session
from ..validation.pre_validate import find_unsanitized
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


def forget_rate_limit(session_id: str) -> None:
    _recent_request_times.pop(session_id, None)


def _error_fields(error: Exception) -> list:
    """Where a plan failed validation (field path + error type), never the offending values."""
    if isinstance(error, ValidationError):
        return [{"loc": [str(p) for p in e["loc"]], "type": e["type"]} for e in error.errors()][:5]
    return [{"type": "post_validation"}]


# design note: a 413 "too many input tokens" costs no quota (Groq refuses it before running the
# model), so rebuilding the prompt smaller is cheap. Each rebuild keeps FIT_MARGIN * limit /
# requested of the element/text caps; the fixed part (system prompt, image) does not shrink, hence
# a second rebuild with the new numbers when the first still does not fit.
MAX_FIT_REBUILDS = 2
FIT_MARGIN = 0.85
MIN_FIT = 0.1


def _smaller_fit(fit: float, error: ModelRequestTooLarge) -> float | None:
    if not error.limit or not error.requested or fit <= MIN_FIT:
        return None
    return max(MIN_FIT, fit * FIT_MARGIN * error.limit / error.requested)


def _retry_messages(
    step_dict: dict, previous: object, error: Exception, fit: float = 1.0
) -> list[dict[str, object]]:
    """The one corrective retry, sized for a per-minute token budget the first call has mostly
    used (Groq free tier: 8K/min; resending the image got HTTP 413). A shape error needs only the
    model's own output and the error; a plan that named a wrong element or ref also gets the
    page as text (never the image again)."""
    note = f"Your previous output was invalid: {error}. Reply with only the corrected JSON object."
    messages: list[dict[str, object]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if isinstance(error, PostValidationError):
        messages.append({"role": "user", "content": build_user_message(step_dict, fit=fit)})
    else:
        messages.append({"role": "user", "content": f"TASK: {step_dict['task']}"})
    previous_json = json.dumps(previous, ensure_ascii=False)[:2000]
    messages.append({"role": "assistant", "content": previous_json})
    messages.append({"role": "user", "content": note})
    return messages


def _loggable_action(action: dict) -> dict:
    """The validated action minus anything the model wrote as prose or literal text: op, target id,
    sealed ref name, point, stop reason. Enough to trace a run, never page or typed text."""
    keys = ("op", "node", "ref", "reason", "direction", "level", "key")
    out = {k: action[k] for k in keys if k in action}
    if "url" in action:  # the site only: a path or query can carry anything
        out["url_host"] = urlsplit(action["url"]).hostname
    if "text" in action:
        out["text_len"] = len(action["text"])
    if action.get("op") == "click_point":
        out["x"], out["y"] = round(action["x"]), round(action["y"])
    return out


def _step_number(step_id: str) -> int:
    return int(step_id.split("-", 1)[1])


def _ground_click_points(plan: dict, image: dict | None, point_format: str) -> None:
    """The model answers click_point in its own grounding convention (`point_format`); the
    extension executes in viewport CSS pixels. Converted here, before validation checks the point
    lies in the image."""
    if not image:
        return
    for action in plan.get("actions", []):
        if not isinstance(action, dict) or action.get("op") != "click_point":
            continue
        x, y = action.get("x"), action.get("y")
        if isinstance(x, int | float) and isinstance(y, int | float):
            action["x"], action["y"] = image_point_to_viewport(
                x, y, image["region"], image["scale"], point_format
            )


def _validate_candidate_plan(
    raw_plan: object,
    session: Session,
    step_dict: dict,
    point_format: str = "rel1000_long_side",
) -> dict:
    """R-3 A10: the model's JSON is never trusted to follow the schema (json_object mode enforces
    nothing). Normalize the shape, map the prompt's element aliases back to node ids, then validate
    against the wire schema and the session."""
    plan = normalize_plan(raw_plan, step_dict["step_id"])
    resolve_aliases(plan, step_dict)
    _ground_click_points(plan, step_dict.get("image"), point_format)
    ActionPlan.model_validate(plan)
    validate_plan_against_session(plan, session)
    return plan


async def _get_plan(
    messages: list[dict[str, object]],
    settings: Settings,
    replay_store: ReplayStore,
    model_client: VLLMClient,
    step_dict: dict,
) -> tuple[object, str]:
    """The plan, and the model that wrote it."""
    if settings.mode == "replay":
        plan = replay_store.lookup(step_dict)
        if plan is None:
            raise model_unavailable()
        return plan, "replay"
    has_image = any(
        isinstance(m.get("content"), list)
        and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m["content"])
        for m in messages
    )
    plan, route = await model_client.complete_routed(
        messages, settings.model_image_budget_tokens if has_image else 0
    )
    if settings.mode == "record":
        replay_store.record(step_dict, plan)
    return plan, route.name


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
    leaked = find_unsanitized(step_dict)
    if leaked:
        log_event(
            "unsanitized_context",
            request_id=getattr(request.state, "request_id", None),
            entities=leaked,
            step_number=_step_number(step_request.step_id),
        )
        raise unsanitized_context(leaked)
    log_payload(step_dict, settings.log_payloads)

    previous_step_id = session.last_step_id

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
        full_snapshot=step_dict.get("delta_of") is None,
    )
    store.touch(session_id)

    # design.md §4.1's Server-Timing components: queue (everything before prompt-building — auth,
    # parsing, session/lease/rate checks all ran as FastAPI dependencies or above, before this
    # function even started timing "prompt"), prompt, model, validate.
    timings: dict[str, float] = {"queue": time.perf_counter() - t_start}

    t_prompt = time.perf_counter()
    messages = build_messages(step_dict)
    timings["prompt"] = time.perf_counter() - t_prompt
    timings["model"] = 0.0
    timings["validate"] = 0.0

    last_raw: list[object] = []
    routes_used: list[str] = []

    async def attempt(attempt_messages: list[dict[str, object]], replay_key: dict) -> dict:
        t_model = time.perf_counter()
        try:
            raw_plan, route = await _get_plan(
                attempt_messages, settings, replay_store, model_client, replay_key
            )
            last_raw[:] = [raw_plan]
            routes_used.append(route)
        finally:
            timings["model"] += time.perf_counter() - t_model
        t_validate = time.perf_counter()
        try:
            return _validate_candidate_plan(
                raw_plan, session, step_dict, settings.model_point_format
            )
        finally:
            timings["validate"] += time.perf_counter() - t_validate

    fit = 1.0

    async def first_attempt() -> dict:
        nonlocal fit, messages
        for rebuild in range(MAX_FIT_REBUILDS + 1):
            try:
                return await attempt(messages, step_dict)
            except ModelRequestTooLarge as too_large:
                smaller = _smaller_fit(fit, too_large) if rebuild < MAX_FIT_REBUILDS else None
                if smaller is None:
                    raise
                fit = smaller
                log_event(
                    "prompt_refit",
                    request_id=getattr(request.state, "request_id", None),
                    limit=too_large.limit,
                    requested=too_large.requested,
                    fit=round(fit, 3),
                )
                messages = build_messages(step_dict, fit=fit)
        raise AssertionError("unreachable")

    retried = False
    try:
        try:
            plan = await first_attempt()
        except (ValidationError, PostValidationError) as first_error:
            # One corrective retry. A user turn, not a second system message: several chat
            # templates (and hosted endpoints) accept only one system message, at the start.
            retried = True
            log_event(
                "plan_retry",
                request_id=getattr(request.state, "request_id", None),
                error_class=type(first_error).__name__,
                errors=_error_fields(first_error),
            )
            retry_messages = _retry_messages(
                step_dict, last_raw[0] if last_raw else None, first_error, fit
            )
            try:
                # The same step's correction: the model already saw this step's screenshot, so
                # the retry sends the page as text and the rejected output (never the image again).
                plan = await attempt(retry_messages, {**step_dict, "_retry_note": str(first_error)})
            except (ValidationError, PostValidationError) as second_error:
                raise plan_invalid(str(second_error)) from second_error
    except GatewayError:
        # The model call or validation failed, so this step produced nothing: release its lease so
        # the client may re-send the same step once (its bounded retry).
        session.last_step_id = previous_step_id
        raise

    record_typed(session, plan)

    log_event(
        "step_processed",
        request_id=getattr(request.state, "request_id", None),
        mode=settings.mode,
        step_number=_step_number(step_request.step_id),
        nodes=len(step_dict.get("nodes", [])),
        redactions=len(step_dict.get("redactions", [])),
        image=step_dict.get("image") is not None,
        retried=retried,
        routes=routes_used,
        fit=round(fit, 3),
        ops=[a.get("op") for a in plan.get("actions", [])],
        plan=[_loggable_action(a) for a in plan.get("actions", [])],
        model_s=round(timings["model"], 3),
    )

    response = JSONResponse(content=plan)
    response.headers["Server-Timing"] = ", ".join(
        f"{name};dur={duration * 1000:.1f}" for name, duration in timings.items()
    )
    # Which model answered (a configured model name), for the panel's run log.
    response.headers["X-Aegis-Model-Route"] = (
        routes_used[-1] if routes_used else settings.model_name
    )
    return response
