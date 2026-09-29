"""design.md §8.3/§12.1 (T-2.36) — an OpenAI-compatible async client (vLLM, Groq, ...). The output
format is a setting (R-3): `json_schema` sends the model-facing action schema for
grammar-constrained decoding where the endpoint enforces it; `json_object` (the default, and the
only form the R-1 endpoint, Groq, accepts for this schema) asks for JSON only. Either way the
route normalizes and validates every plan afterwards, so an out-of-schema action is rejected there.

The schema is loaded from `packages/protocol/schema/action-plan.schema.json` directly —
`packages/protocol` is the project's single source of truth for anything crossing the network
(CLAUDE.md rule 6), and re-deriving an equivalent schema from the generated Pydantic model here
would risk drifting from it. `AEGIS_ACTION_PLAN_SCHEMA_PATH` overrides the search entirely — set by
`server/deploy/gateway.Dockerfile`, which `COPY`s that one schema file into the image at a fixed
path, rather than relying on relative-parents guessing across install layouts (a repo checkout vs.
an installed package land the file at different depths).
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import httpx

from ..config import Settings
from ..errors import GatewayError, ModelRequestTooLarge, model_timeout, model_unavailable
from ..prompt.aliases import ALIAS_PATTERN
from ..structured_log import log_event
from .adapters import DEFAULT_ADAPTER, ModelAdapter
from .normalize import PlanShapeError


def _schema_candidates() -> list[Path]:
    candidates = []
    env_override = os.environ.get("AEGIS_ACTION_PLAN_SCHEMA_PATH")
    if env_override:
        candidates.append(Path(env_override))
    # repo checkout: server/gateway/src/aegis_gateway/model_client/vllm.py -> repo root
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "packages"
        / "protocol"
        / "schema"
        / "action-plan.schema.json"
    )
    return candidates


def _inline_common_refs(node: object, common_defs: dict) -> object:
    """`action-plan.schema.json` references shared definitions in a *separate* file
    (`common.schema.json#/$defs/...`) — fine for the JS/Python codegen pipeline (T-1.4/T-1.6),
    which resolves the sibling file itself, but fatal here: this exact dict is sent verbatim as
    vLLM's `response_format.json_schema.schema` for grammar-constrained decoding, and vLLM is
    never given `common.schema.json` — it has no way to resolve a `$ref` into a file it was never
    sent. [Real bug, found 2026-09-25 the first time this code path ever ran against a live model
    — OQ-13 had no GPU to run it against before]: with the ref left unresolved, xgrammar silently
    treats the field as unconstrained rather than erroring, so `stepId`'s `^s-[0-9]+$` pattern (and
    `nodeId`/`placeholderRef`/`box`'s own constraints) were never actually enforced during
    generation — confirmed by reproduction: a real live model produced `step_id: "step_1"`, which
    fails Pydantic's own post-validation *after* generation, exactly the silent-until-measured gap
    this describes. Recursively inlines every `common.schema.json#/$defs/X` reference with a deep
    copy of that def from the already-loaded sibling file, leaving same-document `#/$defs/...`
    refs untouched (vLLM resolves those fine since they're part of the one schema object sent)."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("common.schema.json#/$defs/"):
            def_name = ref.split("/")[-1]
            return _inline_common_refs(copy.deepcopy(common_defs[def_name]), common_defs)
        return {k: _inline_common_refs(v, common_defs) for k, v in node.items()}
    if isinstance(node, list):
        return [_inline_common_refs(item, common_defs) for item in node]
    return node


@lru_cache(maxsize=1)
def load_action_plan_schema() -> dict:
    candidates = _schema_candidates()
    for candidate in candidates:
        if candidate.exists():
            schema = json.loads(candidate.read_text())
            common_path = candidate.parent / "common.schema.json"
            common_defs = json.loads(common_path.read_text())["$defs"]
            return _inline_common_refs(schema, common_defs)
    raise FileNotFoundError(f"action-plan.schema.json not found in any of {candidates}")


WIRE_REF_PATTERN = "^⟪[A-Z_]+#[0-9]+⟫$"
MODEL_REF_PATTERN = "^[A-Z_]+#[0-9]+$"
WIRE_NODE_PATTERN = "^n-[0-9a-z]+$"


def _swap_ref_pattern(node: object) -> None:
    """Wire patterns -> what the model writes: bare refs, and the prompt's element aliases."""
    if isinstance(node, dict):
        if node.get("pattern") == WIRE_REF_PATTERN:
            node["pattern"] = MODEL_REF_PATTERN
        elif node.get("pattern") == WIRE_NODE_PATTERN:
            node["pattern"] = ALIAS_PATTERN
        for value in node.values():
            _swap_ref_pattern(value)
    elif isinstance(node, list):
        for item in node:
            _swap_ref_pattern(item)


@lru_cache(maxsize=1)
def load_model_facing_schema() -> dict:
    """The schema sent to the model: bare refs (matching the system prompt) and no step_id/plan_id
    (server-owned, added by normalize_plan). The wire schema itself is unchanged."""
    schema = copy.deepcopy(load_action_plan_schema())
    _swap_ref_pattern(schema)
    schema["properties"].pop("step_id", None)
    schema["properties"].pop("plan_id", None)
    schema["required"] = [key for key in schema["required"] if key != "step_id"]
    return schema


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def _retry_after_s(response: httpx.Response) -> float | None:
    try:
        return float(response.headers.get("retry-after"))
    except (TypeError, ValueError):
        return None


_SAFE_CODE = re.compile(r"[a-z_.]{1,40}")
# Groq's 413: "... on input tokens per minute (ITPM): Limit 7000, Requested 9046, ...". Only the
# two numbers are kept; the rest of an upstream message is never logged or returned.
_TOKEN_LIMIT = re.compile(r"Limit (\d{1,9}), Requested (\d{1,9})")


_ORG_ID = re.compile(r"org_[A-Za-z0-9]+")
_DATA_URL = re.compile(r"data:[^\s'\"]*")
_BASE64_RUN = re.compile(r"[A-Za-z0-9+/=]{40,}")


def _dev_text(text: str, limit: int) -> str:
    """For the opt-in dev log only: org ids, data: URLs and long base64 runs removed."""
    text = _ORG_ID.sub("org_<redacted>", text)
    text = _DATA_URL.sub("data:<redacted>", text)
    return _BASE64_RUN.sub("<base64>", text)[:limit]


def _upstream_error(response: httpx.Response) -> tuple[dict, dict]:
    """The upstream error envelope, split in two. First, closed-vocabulary fields safe for every
    log and for the client: `type`/`code`/`param` only when they are plain `[a-z_.]` identifiers,
    a token limit/request only as integers, and the rejected generation only as a length and
    whether it began as JSON. Second, the rest of the envelope (its message, the generation
    itself) for the opt-in dev log: model output from a sanitized prompt, still page text."""
    try:
        error = response.json().get("error") or {}
    except (ValueError, AttributeError):
        return {}, {}
    if not isinstance(error, dict):
        return {}, {}
    out: dict = {}
    for field in ("type", "code", "param"):
        value = error.get(field)
        if isinstance(value, str) and _SAFE_CODE.fullmatch(value):
            out[field] = value
    message = error.get("message")
    match = _TOKEN_LIMIT.search(message) if isinstance(message, str) else None
    if match:
        out["limit"], out["requested"] = int(match.group(1)), int(match.group(2))
    generation = error.get("failed_generation")
    dev: dict = {"fields": sorted(str(k) for k in error)[:10]}
    if isinstance(message, str):
        dev["message"] = _dev_text(message, 500)
    if isinstance(generation, str):
        out["failed_generation_chars"] = len(generation)
        out["failed_generation_starts_json"] = generation.lstrip().startswith("{")
        dev["failed_generation"] = _dev_text(generation, 2000)
    return out, dev


def _request_shape(payload: dict) -> dict:
    """Sizes only (characters, image bytes, format), never content: what a request cost."""
    text_chars = 0
    images: list[dict] = []
    for message in payload.get("messages", []):
        content = message.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_chars += len(part["text"])
            elif part.get("type") == "image_url":
                url = str((part.get("image_url") or {}).get("url", ""))
                head, _, data = url.partition(";base64,")
                image_format = head.removeprefix("data:")[:20]
                images.append({"format": image_format, "bytes": len(data) * 3 // 4})
    return {
        "model": payload.get("model"),
        "response_format": (payload.get("response_format") or {}).get("type"),
        "max_tokens": payload.get("max_tokens"),
        "temperature": payload.get("temperature"),
        "messages": len(payload.get("messages", [])),
        "text_chars": text_chars,
        "images": images,
        "body_bytes": len(json.dumps(payload)),
    }


# Failures where the request most likely never produced an answer: retrying once is cheap. A
# timeout is not in this list — the model may still be generating, and a retry doubles the wait
# and the tokens spent.
_RETRYABLE_TRANSPORT = (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError)
_TRANSPORT_RETRY_WAIT_S = 1.0


@dataclass(frozen=True)
class ModelRoute:
    """One vision model the gateway may send a step to (every route is sent the screenshot)."""

    name: str
    max_tokens: int
    reasoning_effort: str | None
    temperature: float | None
    chat_template_kwargs: bool


class UpstreamRateLimited(Exception):
    """A 429 on one route of the pool: another route may take the step at once."""

    def __init__(self, route: str, retry_after_s: float | None) -> None:
        super().__init__(f"429 on {route}")
        self.route = route
        self.retry_after_s = retry_after_s


class _TokenBucket:
    """The upstream's per-model tokens-per-minute budget, refilled linearly (limit/60 per second).
    Lets the gateway know BEFORE sending whether a request would be answered with a 429.

    Two views, the lower wins: the `x-ratelimit-*` headers of the last response, and the gateway's
    own record of what it sent in the last minute (each request's estimated cost, refilling from
    when it was sent). Groq charges part of a screenshot only after answering, so right after a
    step its header still shows budget that is already gone; the own record does not lag."""

    def __init__(self) -> None:
        self.limit: float | None = None
        self.remaining: float | None = None
        self.observed_at = 0.0
        self.blocked_until = 0.0
        self.sent: list[list[float]] = []  # [sent at, estimated tokens]

    def _own_available(self, now: float) -> float | None:
        if not self.limit:
            return None
        rate = self.limit / 60.0
        self.sent = [e for e in self.sent if now - e[0] < 60.0]
        outstanding = sum(max(0.0, n - rate * (now - t)) for t, n in self.sent)
        return self.limit - outstanding

    def available(self, now: float) -> float | None:
        own = self._own_available(now)
        if own is None or self.remaining is None:
            return own
        header = min(self.limit, self.remaining + self.limit / 60.0 * (now - self.observed_at))
        return min(header, own)

    def spend(self, tokens: float, now: float) -> None:
        self.sent.append([now, tokens])

    def refund(self, tokens: float) -> None:
        """The upstream gives back the unused part of max_tokens after answering; so does the
        record (from the latest request, which is the one just answered)."""
        if self.sent and tokens > 0:
            self.sent[-1][1] = max(0.0, self.sent[-1][1] - tokens)

    def update(self, headers: httpx.Headers, now: float) -> None:
        try:
            limit = float(headers.get("x-ratelimit-limit-tokens"))
            remaining = float(headers.get("x-ratelimit-remaining-tokens"))
        except (TypeError, ValueError):
            return
        self.limit, self.remaining, self.observed_at = limit, remaining, now

    def block(self, seconds: float, now: float) -> None:
        """A 429: the upstream says when to come back. Its Retry-After is trusted as given; the
        budget estimate is left alone (zeroing it turned a 5 s Retry-After into a 50 s wait)."""
        self.blocked_until = max(self.blocked_until, now + seconds)

    def wait_for(self, tokens: float, now: float) -> float:
        wait = max(0.0, self.blocked_until - now)
        available = self.available(now)
        if available is None or not self.limit or self.limit <= 0:
            return wait
        need = min(tokens, self.limit)  # larger than the whole budget: the upstream decides (413)
        return max(wait, (need - available) / (self.limit / 60.0))


# Measured on Groq for qwen/qwen3.8-27b (2026-09-30, Amazon steps): system prompt plus page text
# came to 2.36 characters per token (the element list is dense: ids, boxes, numbers); a little
# under that, so the estimate errs towards waiting.
_CHARS_PER_TOKEN = 2.3


def estimate_tokens(
    messages: list[dict[str, object]], max_tokens: int, image_token_count: int = 0
) -> int:
    """What a request needs of a tokens-per-minute budget to be admitted: prompt text, the image
    (its full per-minute cost, see `model_image_budget_tokens`) and the completion reserved."""
    chars = 0
    has_image = False
    for message in messages:
        content = message.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for part in parts:
            if (
                isinstance(part, dict)
                and part.get("type") == "text"
                and isinstance(part.get("text"), str)
            ):
                chars += len(part["text"])
            elif isinstance(part, dict) and part.get("type") == "image_url":
                has_image = True
    # Groq admits a request only if the whole max_tokens fits (measured: it is deducted up front,
    # the unused part refunded after), so that is what a request needs, not what it will use.
    return int(chars / _CHARS_PER_TOKEN) + (image_token_count if has_image else 0) + max_tokens


class VLLMClient:
    def __init__(self, settings: Settings, adapter: ModelAdapter = DEFAULT_ADAPTER) -> None:
        self._settings = settings
        self._adapter = adapter
        self._buckets: dict[str, _TokenBucket] = {}
        self.primary = ModelRoute(
            name=settings.model_name,
            max_tokens=settings.model_max_tokens,
            reasoning_effort=settings.model_reasoning_effort,
            temperature=settings.model_temperature,
            chat_template_kwargs=settings.model_chat_template_kwargs,
        )
        self.fallbacks = [
            ModelRoute(
                name=name,
                max_tokens=settings.model_max_tokens,
                reasoning_effort=settings.model_reasoning_effort,
                temperature=settings.model_temperature,
                chat_template_kwargs=settings.model_chat_template_kwargs,
            )
            for name in settings.model_fallbacks
            if name != settings.model_name
        ]

    def _bucket(self, model: str) -> _TokenBucket:
        return self._buckets.setdefault(model, _TokenBucket())

    async def complete_routed(
        self, messages: list[dict[str, object]], image_token_count: int = 0
    ) -> tuple[object, ModelRoute]:
        """Sends the step (with its screenshot) to the primary vision model when its per-minute
        token budget allows it within `model_primary_max_wait_s`; otherwise to the first vision
        fallback that can take it; otherwise to whichever route frees up first, WAITING here for
        that budget (up to `model_budget_max_wait_s`) rather than sending into a 429. A 429 on
        one route moves the step to the next. Returns the parsed plan and the route used."""
        settings = self._settings
        routes = [self.primary, *self.fallbacks]
        last_error: Exception | None = None
        for _attempt in range(len(routes) + 3):
            now = time.monotonic()
            cost = {
                r.name: estimate_tokens(messages, r.max_tokens, image_token_count) for r in routes
            }
            waits = [(self._bucket(r.name).wait_for(cost[r.name], now), r) for r in routes]
            primary_wait = waits[0][0]
            # In preference order (the primary, then the fallbacks as configured): the first that
            # can answer within the tolerance; if none can, whichever frees up first.
            ready = [w for w in waits if w[0] <= settings.model_primary_max_wait_s]
            wait, route = ready[0] if ready else min(waits, key=lambda w: w[0])
            if wait > settings.model_budget_max_wait_s:
                log_event("model_error", reason="all_routes_busy", wait_s=round(wait, 1))
                raise model_unavailable("upstream_429", retry_after_s=wait)
            if wait > 0:
                log_event("model_wait", model=route.name, wait_s=round(wait, 1))
                await asyncio.sleep(wait)
            log_event("model_route", model=route.name, primary_wait_s=round(primary_wait, 1))
            self._bucket(route.name).spend(cost[route.name], time.monotonic())
            try:
                return await self.complete(messages, route=route, pooled=True), route
            except UpstreamRateLimited as exc:
                self._bucket(exc.route).block(exc.retry_after_s or 10.0, time.monotonic())
                last_error = exc
            except GatewayError as exc:
                # A route that is down (5xx, unreachable, timeout): another may still answer.
                if not exc.retryable or len(routes) == 1:
                    raise
                self._bucket(route.name).block(30.0, time.monotonic())
                last_error = exc
        if isinstance(last_error, GatewayError):
            raise last_error
        raise model_unavailable("upstream_429")

    def _response_format(self) -> dict | None:
        fmt = self._settings.model_response_format
        if fmt == "json_schema":
            return {
                "type": "json_schema",
                "json_schema": {
                    "name": "action_plan",
                    "schema": load_model_facing_schema(),
                    "strict": True,
                },
            }
        if fmt == "json_object":
            return {"type": "json_object"}
        return None

    async def complete(
        self,
        messages: list[dict[str, object]],
        route: ModelRoute | None = None,
        pooled: bool = False,
    ) -> object:
        """Returns the parsed JSON the model produced (not yet normalized or validated). Raises a
        GatewayError (503/504/422) on every failure, never a bare exception — or, when `pooled`,
        `UpstreamRateLimited` on a 429 so the pool can move the step to another route."""
        route = route or self.primary
        payload: dict = {
            "model": route.name,
            "messages": messages,
            "max_tokens": route.max_tokens,
        }
        response_format = self._response_format()
        if response_format is not None:
            payload["response_format"] = response_format
        if route.chat_template_kwargs:
            payload.update(self._adapter.chat_template_kwargs())
        if route.reasoning_effort:
            payload["reasoning_effort"] = route.reasoning_effort
        if route.temperature is not None:
            payload["temperature"] = route.temperature
        headers = (
            {"Authorization": f"Bearer {self._settings.model_api_key}"}
            if self._settings.model_api_key
            else {}
        )
        log_event("model_request", **_request_shape(payload))
        response = await self._post(payload, headers, pooled=pooled)

        status = response.status_code
        try:
            body = response.json()
            usage = body.get("usage") or {}
            log_event(
                "model_usage",
                prompt_tokens=usage.get("prompt_tokens"),
                completion_tokens=usage.get("completion_tokens"),
            )
            completion = usage.get("completion_tokens")
            if pooled and isinstance(completion, int):
                self._bucket(route.name).refund(route.max_tokens - completion)
            content = body["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            log_event(
                "model_error", reason="bad_body", status=status, error_class=type(exc).__name__
            )
            raise model_unavailable("bad_body") from exc
        if not isinstance(content, str):
            log_event(
                "model_error", reason="bad_body", status=status, error_class="NonStringContent"
            )
            raise model_unavailable("bad_body")

        try:
            return json.loads(_strip_code_fence(content))
        except json.JSONDecodeError as exc:
            # A malformed plan is a malformed plan, whether it fails to parse or to validate: the
            # route gives both the same one corrective retry, then PLAN_INVALID.
            raise PlanShapeError(f"model response was not valid JSON: {exc.msg}") from exc

    async def _post(
        self, payload: dict, headers: dict[str, str], pooled: bool = False
    ) -> httpx.Response:
        """POST with at most `model_max_retries` retries, and only for an upstream 429 whose
        `retry-after` is within `model_retry_max_wait_s`, or a dropped connection. On Groq's free
        tier (7-8K tokens/min) a 429 is routine; waiting the time it names costs nothing, while
        retrying sooner or more often only earns further 429s. Returns a response with status
        < 400, or raises MODEL_UNAVAILABLE (retryable only for 429/5xx/unreachable; 413 as
        ModelRequestTooLarge) / MODEL_TIMEOUT. Logs carry closed-vocabulary fields
        only: never the body (it can echo the prompt) and never the key."""
        settings = self._settings
        url = f"{settings.model_url}/chat/completions"
        attempt = 0
        async with httpx.AsyncClient(timeout=settings.model_timeout_s) as client:
            while True:
                t0 = time.perf_counter()
                try:
                    response = await client.post(url, json=payload, headers=headers)
                except httpx.TimeoutException as exc:
                    log_event("model_error", reason="timeout", attempt=attempt)
                    raise model_timeout() from exc
                except httpx.HTTPError as exc:
                    error_class = type(exc).__name__
                    if attempt < settings.model_max_retries and isinstance(
                        exc, _RETRYABLE_TRANSPORT
                    ):
                        log_event(
                            "model_retry",
                            reason="unreachable",
                            error_class=error_class,
                            attempt=attempt,
                            wait_s=_TRANSPORT_RETRY_WAIT_S,
                        )
                        attempt += 1
                        await asyncio.sleep(_TRANSPORT_RETRY_WAIT_S)
                        continue
                    log_event("model_error", reason="unreachable", error_class=error_class)
                    raise model_unavailable("unreachable") from exc

                status = response.status_code
                # A 429's own budget headers are not a usable reading (they sent a 5 s Retry-After
                # into a 42 s wait): its Retry-After is what is trusted.
                if status != 429:
                    self._bucket(payload["model"]).update(response.headers, time.monotonic())
                if status < 400:
                    log_event(
                        "model_call",
                        status=status,
                        attempt=attempt,
                        seconds=round(time.perf_counter() - t0, 3),
                    )
                    return response
                if status == 429:
                    wait = _retry_after_s(response)
                    if pooled:
                        log_event("model_retry", reason="upstream_429_reroute", retry_after_s=wait)
                        raise UpstreamRateLimited(payload["model"], wait)
                    if (
                        attempt < settings.model_max_retries
                        and wait is not None
                        and wait <= settings.model_retry_max_wait_s
                    ):
                        log_event(
                            "model_retry", reason="upstream_429", attempt=attempt, wait_s=wait
                        )
                        attempt += 1
                        await asyncio.sleep(wait)
                        continue
                    log_event(
                        "model_error", reason="upstream_429", status=status, retry_after_s=wait
                    )
                    raise model_unavailable("upstream_429", retry_after_s=wait)
                upstream, dev_detail = _upstream_error(response)
                if settings.log_payloads:
                    log_event("model_error_detail", status=status, **dev_detail)
                if upstream.get("code") == "json_validate_failed":
                    # Groq ran the model and its output was not JSON: an invalid plan, caught
                    # upstream instead of by json.loads below. Same path, same one corrective
                    # retry, then PLAN_INVALID. Not "model unavailable".
                    log_event("model_error", reason="output_not_json", status=status, **upstream)
                    raise PlanShapeError("model response was not valid JSON (json_validate_failed)")
                if status >= 500:
                    # Transient server trouble: the client may re-send this step once.
                    log_event("model_error", reason="upstream_5xx", status=status, **upstream)
                    raise model_unavailable("upstream_5xx")
                if status == 413:
                    log_event("model_error", reason="upstream_too_large", status=status, **upstream)
                    raise ModelRequestTooLarge(upstream.get("limit"), upstream.get("requested"))
                # Every other 4xx is permanent for this request: re-sending it only fails again.
                reason = "upstream_auth" if status in (401, 403) else "upstream_4xx"
                log_event("model_error", reason=reason, status=status, **upstream)
                code = upstream.get("code") or upstream.get("type")
                raise model_unavailable(
                    reason, retryable=False, detail=f"{status} {code}" if code else str(status)
                )
