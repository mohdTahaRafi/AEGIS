# R-3 — Robust model output + the model sees the whole page

**Priority:** P0 · **Depends on:** R-2 · **Unblocks:** R-5, R-6
**Bugs fixed:** A1, A13, A17 (new), A21 (new) · **Parent list:** [tasks.md](tasks.md)

> **Status (2026-09-28):** A1–A6 and A10's normalize → validate → user-turn retry are
> **implemented** (A21 fixed), with `test_normalize.py`, `test_model_facing_schema.py`, the
> `test_model_client.py` cases and route tests in `test_route_model_output.py` (which also covers
> the bare-ref round trip). Done as part of R-1's Groq integration; see
> [R-1](R-1-vlm-endpoint.md#second-pass-2026-09-28-gateway-integration-and-reliability). Two
> additions beyond this spec: a bounded retry in `VLLMClient._post` (decision `R1-retry`) and a
> `Retry-After` header on `MODEL_UNAVAILABLE upstream_429`. **Still open:** A7–A9, the rest of
> A10 (`prompt_view`, `changed_ids`, prompt-size log), A11, Part B, `test_full_snapshot_prompt.py`,
> `test_rate_limit_cleanup.py`, and the live check (`scripts/r3_live_check.py` exists; 1/10 so
> far, blocked by Groq's daily token limit).

`gw/` = `server/gateway/src/aegis_gateway/`, `ext/` = `apps/extension/`. Paths are relative to
`AEGIS/`.

## Goal

1. Every well-meant model answer becomes a valid plan: bare refs, a bare action, a missing or
   wrong `step_id`, or code fences around the JSON.
2. The output format matches what the endpoint supports: `json_schema`, `json_object`, or none.
3. An upstream failure gives a specific `MODEL_UNAVAILABLE` reason, never an unhandled 500.
4. From step 2 on, the model sees the whole current page, not only what changed.

## New bugs found while writing this step

| # | Bug | Where |
|---|---|---|
| A17 | The host builds each step from `graphMessage.nodes`, which is a **delta**. (a) Graphs the content script auto-sends between steps (`content/port.ts` `startObserving` → `sendGraph('after_action')`) are folded into `allSeenNodes`, but their nodes are never sent to the gateway: the next requested graph's delta no longer contains them. (b) The content script sends a full graph every 10 steps or on a privacy-epoch change, always with `removed: []`, but `onGraph` only merges. Nodes that vanished stay in `allSeenNodes` forever. (c) `runPerceptionStep`, `collectFreeTextSources` and `buildSanitizedContext` all run on the delta. So on step ≥ 2 the structural coverage, the vision nodes and the clearance boxes cover only changed nodes, and unchanged regions of the image go grey. | `ext/src/host/session.ts:304-446`, `ext/src/content/port.ts:sendGraph` |
| A21 | `VLLMClient.complete` calls `response.raise_for_status()` **outside** its `try`. Any upstream 4xx (401 bad key, 402 no credit, 429 rate limit) raises `httpx.HTTPStatusError` into FastAPI as an unhandled 500. An HTTP-200 body without `choices` (OpenRouter's error envelope) raises a bare `KeyError`, also a 500. | `gw/model_client/vllm.py:112-116` |

## Decisions (fixed)

- **D-R3-full-snapshot.** The extension sends the **full current node set every step**, with
  `delta_of: null` and no `removed`. The gateway treats `delta_of: null` as "replace the page" and
  computes which nodes are new or changed itself. Why: the host-side delta is wrong three ways
  (A17), the model needs the whole page anyway, and a full snapshot is the only form both ends can
  get right without shared state. Cost: a larger request body. `tasks.md`'s delta-reconstruction
  item is superseded; the gateway still accepts deltas from other clients.
- **D-R3-ref-form.** The model writes bare refs (`AADHAAR#1`); `normalize.py` wraps them. The wire
  schema is unchanged.
- **D-R3-server-ids.** `step_id` and `plan_id` are set by the server. The model-facing schema
  doesn't contain them.
- **D-R3-response-format.** Output format is one setting, not a provider name:
  `AEGIS_MODEL_RESPONSE_FORMAT = json_schema | json_object | none` (default `json_object`: the
  R-1 endpoint, Groq `qwen/qwen3.8-27b`, answers HTTP 400 to `strict: true` with this schema and
  failed strict generation even on an all-required schema; measured 2026-09-28).
  `chat_template_kwargs` are sent only when `AEGIS_MODEL_CHAT_TEMPLATE_KWARGS=true` (default
  `false`; set it `true` for self-hosted vLLM). This replaces `tasks.md`'s
  `AEGIS_MODEL_PROVIDER`: what differs between endpoints is these two behaviours, not a vendor.
- **D-R3-reason.** The **host** decides `reason`: `initial` on step 1, `after_action` after a plan
  executed, `reconcile` after a rejected plan. R-5 adds `navigation`. The content script's own
  `reason` field is ignored for the payload; it reflects which trigger sent the graph, not why the
  step is happening.
- The class stays named `VLLMClient`. Renaming it touches many tests and adds nothing.

---

## Part A — Gateway

### A1. Settings (`gw/config.py`)

Append after the R-2 fields:

```python
ResponseFormat = Literal["json_schema", "json_object", "none"]
...
    model_response_format: ResponseFormat = "json_object"
    model_chat_template_kwargs: bool = False
    prompt_max_elements: int = 150
```

In `load_settings()`:

```python
    response_format = os.environ.get("AEGIS_MODEL_RESPONSE_FORMAT", "json_object")
    if response_format not in ("json_schema", "json_object", "none"):
        raise ValueError(
            f"AEGIS_MODEL_RESPONSE_FORMAT must be json_schema|json_object|none, got {response_format!r}"
        )
    ...
        model_response_format=response_format,  # type: ignore[arg-type]
        model_chat_template_kwargs=_env_bool("AEGIS_MODEL_CHAT_TEMPLATE_KWARGS", False),
        prompt_max_elements=int(os.environ.get("AEGIS_PROMPT_MAX_ELEMENTS", "150")),
```

### A2. `gw/model_client/normalize.py` (new)

```python
"""Turns a well-meant model answer into the wire plan shape before validation. It never invents a
node id, a ref or an op; post-validation still rejects anything the session didn't send."""

from __future__ import annotations

import re

from ..validation.post_validate import PostValidationError

BARE_REF = re.compile(r"^[A-Z_]+#[0-9]+$")
MODEL_KEYS = ("actions", "risk_hint", "stop_if", "note")


class PlanShapeError(PostValidationError):
    """Raised when the output can't be read as a plan at all. A PostValidationError subclass, so
    the route's one-retry path handles it like any other invalid plan."""


def normalize_plan(raw: object, step_id: str) -> dict:
    if isinstance(raw, list):
        raw = {"actions": raw}
    elif isinstance(raw, dict) and "op" in raw and "actions" not in raw:
        raw = {"actions": [raw]}
    if not isinstance(raw, dict) or not isinstance(raw.get("actions"), list):
        raise PlanShapeError("model output has no 'actions' list")
    plan: dict = {key: raw[key] for key in MODEL_KEYS if key in raw}
    plan["step_id"] = step_id
    plan["plan_id"] = f"p-{step_id.removeprefix('s-')}"
    for action in plan["actions"]:
        if isinstance(action, dict):
            ref = action.get("ref")
            if isinstance(ref, str) and BARE_REF.match(ref):
                action["ref"] = f"⟪{ref}⟫"
    return plan
```

`plan_id` is deterministic, so replay stays stable. Actions are mutated in place; `raw` is a fresh
dict from `json.loads` or the replay file, so nothing shared is changed.

### A3. Model-facing schema (`gw/model_client/vllm.py`)

Add below `load_action_plan_schema`:

```python
WIRE_REF_PATTERN = "^⟪[A-Z_]+#[0-9]+⟫$"
MODEL_REF_PATTERN = "^[A-Z_]+#[0-9]+$"


def _swap_ref_pattern(node: object) -> None:
    if isinstance(node, dict):
        if node.get("pattern") == WIRE_REF_PATTERN:
            node["pattern"] = MODEL_REF_PATTERN
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
```

### A4. `VLLMClient.complete` (replace the whole method)

```python
    def _response_format(self) -> dict | None:
        fmt = self._settings.model_response_format
        if fmt == "json_schema":
            return {
                "type": "json_schema",
                "json_schema": {"name": "action_plan", "schema": load_model_facing_schema(), "strict": True},
            }
        if fmt == "json_object":
            return {"type": "json_object"}
        return None

    async def complete(self, messages: list[dict[str, object]]) -> object:
        """Returns the parsed JSON the model produced (not yet normalized or validated). Raises a
        GatewayError (503/504/422) on every failure, never a bare exception."""
        payload: dict = {
            "model": self._settings.model_name,
            "messages": messages,
            "max_tokens": self._settings.model_max_tokens,
        }
        response_format = self._response_format()
        if response_format is not None:
            payload["response_format"] = response_format
        if self._settings.model_chat_template_kwargs:
            payload.update(self._adapter.chat_template_kwargs())
        headers = (
            {"Authorization": f"Bearer {self._settings.model_api_key}"}
            if self._settings.model_api_key
            else {}
        )
        try:
            async with httpx.AsyncClient(timeout=self._settings.model_timeout_s) as client:
                response = await client.post(
                    f"{self._settings.model_url}/chat/completions", json=payload, headers=headers
                )
        except httpx.TimeoutException as exc:
            raise model_timeout() from exc
        except httpx.HTTPError as exc:
            log_event("model_error", reason="unreachable", error_class=type(exc).__name__)
            raise model_unavailable("unreachable") from exc

        status = response.status_code
        if status >= 400:
            reason = "upstream_429" if status == 429 else "upstream_4xx" if status < 500 else "upstream_5xx"
            log_event("model_error", reason=reason, status=status)
            raise model_unavailable(reason)

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            log_event("model_error", reason="bad_body", status=status, error_class=type(exc).__name__)
            raise model_unavailable("bad_body") from exc
        if not isinstance(content, str):
            log_event("model_error", reason="bad_body", status=status, error_class="NonStringContent")
            raise model_unavailable("bad_body")

        try:
            return json.loads(_strip_code_fence(content))
        except json.JSONDecodeError as exc:
            raise plan_invalid(f"model response was not valid JSON: {exc}") from exc
```

And a module-level helper:

```python
def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()
```

Import `log_event` from `..structured_log`. The logs carry closed-vocabulary fields only: never the
body, which can echo the prompt, and never the key.

### A5. Error reasons (`gw/errors.py`)

```python
def model_unavailable(reason: str = "no_replay_match") -> GatewayError:
    return GatewayError(503, "MODEL_UNAVAILABLE", f"Model unavailable: {reason}", retryable=True)
```

`reason` ∈ `no_replay_match | unreachable | upstream_429 | upstream_4xx | upstream_5xx | bad_body`.
The replay-miss call site in `routes_steps._get_plan` keeps calling `model_unavailable()`, which
now reads "Model unavailable: no_replay_match". `routes_health.py` doesn't use
`model_unavailable`; leave it alone.

### A6. System prompt (`gw/prompt/system.py`)

With `json_object` or `none`, the model never sees the schema, so the prompt must spell out the
shape. Replace the last bullet (`• Output only JSON matching the provided schema.`) with these two
bullets, verbatim:

```
• Actions (use only these): {"op":"click","node":id} · {"op":"type","node":id,"ref":"ENTITY#n"} ·
  {"op":"type","node":id,"text":"..."} · {"op":"select","node":id,"option":"..."} ·
  {"op":"scroll","direction":"up|down|left|right","amount":"small|page|end"} · {"op":"wait","ms":50-5000} ·
  {"op":"click_point","x":number,"y":number,"label":"..."} · {"op":"request_observation","level":"L1|L2"} ·
  {"op":"report","content":"..."} · {"op":"ask_user","question":"..."} · {"op":"done","summary":"..."} ·
  {"op":"stop","reason":"captcha|blocked|cannot_proceed|unsafe"}
• Output only one JSON object: {"actions":[ ...1 to 5 actions... ]}. Nothing before or after it.
```

The system prompt's bytes change once. That is fine: the prefix cache refills on the first request.

### A7. Session state + full snapshots (`gw/sessions/store.py`)

Add a field and replace `apply_step_context`:

```python
    nodes_by_id: dict[str, dict] = field(default_factory=dict)

    def apply_step_context(
        self,
        step_id: str,
        nodes: list[dict],
        removed: list[str],
        redactions: list[dict],
        image_region: list[float] | None,
        viewport: dict,
        *,
        full: bool,
    ) -> set[str]:
        """Updates the session's view of the page and returns the ids of nodes that are new or
        changed since the previous step (empty on the first step). `full` (delta_of is null)
        replaces the page; otherwise `nodes` are upserted and `removed` dropped."""
        previous = self.nodes_by_id
        if full:
            current = {node["id"]: node for node in nodes}
        else:
            current = dict(previous)
            for node in nodes:
                current[node["id"]] = node
            for node_id in removed:
                current.pop(node_id, None)
        changed = {nid for nid, node in current.items() if previous.get(nid) != node} if previous else set()
        self.nodes_by_id = current
        self.sent_node_ids = set(current)
        self.node_affordances = {nid: node.get("affordances", []) for nid, node in current.items()}
        self.last_step_id = step_id
        self.step_count += 1
        for redaction in redactions:
            ref = redaction.get("ref")
            if ref:
                self.sent_refs.add(ref)
        if image_region is not None:
            self.recent_image_regions.append((image_region, viewport["w"], viewport["h"]))
            del self.recent_image_regions[:-2]
        return changed
```

`sent_node_ids` now means "on the current page". Before, it meant "ever sent and not removed".
For a delta client the two are the same; with full snapshots this is stricter and correct. A model
can no longer target a node from a page that has gone. `test_post_validate.py` builds `Session`
objects directly and is unaffected.

Update the module docstring's second paragraph to say `sent_node_ids` is the current page's ids.

### A8. Prompt elements (`gw/prompt/elements.py`)

```python
def render_element_line(node: dict, *, changed: bool = False) -> str:
    box = node["box"]
    parts = [node["id"], node["role"], f'"{node["name"]}"', f"[{box[0]:g},{box[1]:g},{box[2]:g},{box[3]:g}]"]
    flags = _state_flags(node.get("state", {}))
    if changed:
        flags.append("new")
    if flags:
        parts.append(", ".join(flags))
    return " | ".join(parts)


def _select(nodes: list[dict], viewport: dict | None, limit: int) -> list[dict]:
    """Keeps `limit` nodes: interactive first (non-empty affordances), then nearest to the viewport
    centre. Returns them in their original order, so the output is deterministic."""
    if len(nodes) <= limit:
        return nodes
    cx = (viewport or {}).get("w", 0) / 2
    cy = (viewport or {}).get("h", 0) / 2

    def rank(indexed: tuple[int, dict]) -> tuple[int, float, int]:
        i, node = indexed
        x, y, w, h = node["box"]
        distance = ((x + w / 2 - cx) ** 2 + (y + h / 2 - cy) ** 2) ** 0.5
        return (0 if node.get("affordances") else 1, distance, i)

    keep = {i for i, _ in sorted(enumerate(nodes), key=rank)[:limit]}
    return [node for i, node in enumerate(nodes) if i in keep]


def render_elements(
    nodes: list[dict],
    *,
    viewport: dict | None = None,
    limit: int = 150,
    changed_ids: frozenset[str] | set[str] = frozenset(),
) -> str:
    return "\n".join(
        render_element_line(node, changed=node["id"] in changed_ids)
        for node in _select(nodes, viewport, limit)
    )
```

With no changes and ≤ `limit` nodes, the output is byte-identical to today.

### A9. `gw/prompt/__init__.py`

`build_user_message` and `build_messages` gain two keyword arguments and pass them through:

```python
def build_user_message(
    step_request: dict,
    *,
    with_image: bool = False,
    changed_ids: frozenset[str] | set[str] = frozenset(),
    max_elements: int = 150,
) -> str:
    ...
        f"ELEMENTS:\n{render_elements(step_request.get('nodes', []), viewport=viewport, limit=max_elements, changed_ids=changed_ids)}\n"
    ...

def build_messages(
    step_request: dict,
    *,
    vision: bool = False,
    changed_ids: frozenset[str] | set[str] = frozenset(),
    max_elements: int = 150,
) -> list[dict[str, object]]:
    image = step_request.get("image") if vision else None
    text = build_user_message(step_request, with_image=image is not None, changed_ids=changed_ids, max_elements=max_elements)
    ...  # rest as in R-2
```

### A10. Route (`gw/api/routes_steps.py`)

Replace everything from `session.apply_step_context(` through the end of the validate block
(lines 115–155):

```python
    changed_ids = session.apply_step_context(
        step_id=step_request.step_id,
        nodes=step_dict.get("nodes", []),
        removed=step_dict.get("removed") or [],
        redactions=step_dict.get("redactions", []),
        image_region=step_dict["image"]["region"] if step_dict.get("image") else None,
        viewport=step_dict["viewport"],
        full=step_dict.get("delta_of") is None,
    )
    store.touch(session_id)

    timings: dict[str, float] = {"queue": time.perf_counter() - t_start}

    t_prompt = time.perf_counter()
    prompt_view = {**step_dict, "nodes": list(session.nodes_by_id.values())}
    messages = build_messages(
        prompt_view,
        vision=settings.model_vision,
        changed_ids=changed_ids,
        max_elements=settings.prompt_max_elements,
    )
    timings["prompt"] = time.perf_counter() - t_prompt

    t_model = time.perf_counter()
    raw_plan = await _get_plan(messages, settings, replay_store, model_client, step_dict)
    timings["model"] = time.perf_counter() - t_model

    t_validate = time.perf_counter()
    try:
        plan = _validate_candidate_plan(raw_plan, session, step_request.step_id)
    except (ValidationError, PostValidationError) as first_error:
        retry_messages = [
            *messages,
            {"role": "user", "content": f"Your previous output was invalid: {first_error}. Reply with only the corrected JSON object."},
        ]
        try:
            retry_step_dict = {**step_dict, "_retry_note": str(first_error)}
            raw_plan = await _get_plan(retry_messages, settings, replay_store, model_client, retry_step_dict)
            plan = _validate_candidate_plan(raw_plan, session, step_request.step_id)
        except (ValidationError, PostValidationError) as second_error:
            raise plan_invalid(str(second_error)) from second_error
    timings["validate"] = time.perf_counter() - t_validate
```

and replace `_validate_candidate_plan`:

```python
def _validate_candidate_plan(raw_plan: object, session: Session, step_id: str) -> dict:
    plan = normalize_plan(raw_plan, step_id)
    ActionPlan.model_validate(plan)
    validate_plan_against_session(plan, session)
    return plan
```

`JSONResponse(content=plan)` now returns the normalized plan. `_get_plan` still records the raw
model output in record mode; R-6 changes recording to the validated plan. Add the import
`from ..model_client.normalize import normalize_plan`.

Also, in `step_processed`, log the prompt size (closed vocabulary):

```python
    log_event(
        "step_processed",
        request_id=getattr(request.state, "request_id", None),
        mode=settings.mode,
        step_number=_step_number(step_request.step_id),
        nodes_rendered=min(len(session.nodes_by_id), settings.prompt_max_elements),
        prompt_chars=sum(len(m["content"]) if isinstance(m["content"], str) else len(m["content"][0]["text"]) for m in messages),
    )
```

### A11. Rate-limit leak (A13)

In `gw/api/routes_steps.py`, add:

```python
def forget_session_rate_limit(session_id: str) -> None:
    _recent_request_times.pop(session_id, None)
```

- `gw/api/routes_sessions.py:delete_session`: call `forget_session_rate_limit(session_id)` before
  `store.delete(session_id)`.
- `gw/sessions/store.py:SessionStore`: add an optional `on_evict: Callable[[str], None] | None = None`
  constructor argument, called with each id removed by `get()` expiry and by `sweep_expired()`.
  `gw/main.py`:
  `SessionStore(ttl_s=settings.session_ttl_s, on_evict=routes_steps.forget_session_rate_limit)`.

---

## Part B — Extension: full snapshot every step (A17)

### B1. `ext/src/shared/messages.ts`

Add to `GraphMessage`:

```ts
  /** True when `nodes` is the complete current graph (the content DeltaTracker's own `full`), so
   * the host must replace — not merge into — its node set. Absent means false. */
  full?: boolean;
```

In `isContentToHostMessage`'s `graph` branch, add
`(value.full === undefined || typeof value.full === 'boolean') &&`.

### B2. `ext/src/content/port.ts:sendGraph`

Add `full: delta.full,` to the posted graph message, next to `removed: delta.removed`.

### B3. `ext/src/host/session.ts`

1. `onGraph`:

```ts
  onGraph(message: GraphMessage): void {
    this.lastGraphMessage = message;
    if (message.full) this.allSeenNodes = new Map();
    for (const node of message.nodes) this.allSeenNodes.set(node.id, node);
    for (const id of message.removed) this.allSeenNodes.delete(id);
    this.pendingGraph?.resolve(message);
    this.pendingGraph = null;
  }
```

   `allSeenNodes` is declared `private allSeenNodes = new Map<string, WireScreenNode>();`. It must
   not be `readonly`.

2. In `stepLoop`:
   - Delete `let deltaOf: string | null = null;` and the `deltaOf = stepId;` at the end of the
     loop.
   - Add `let stepReason: SanitizedContext['reason'] = 'initial';` before the `while`. Import the
     `SanitizedContext` type from `@aegis/protocol`.
   - Right after `const graphMessage = await this.requestGraph();`, add
     `const currentNodes = [...this.allSeenNodes.values()];`.
   - Pass `currentNodes` wherever `graphMessage.nodes` is used today:
     - `runPerceptionStep(currentNodes, …)`
     - `collectFreeTextSources({ …, nodes: currentNodes, … })`
     - `buildSanitizedContext({ …, nodes: currentNodes, … })`
   - In `buildSanitizedContext({...})`, set `reason: stepReason`, `deltaOf: null` and `removed: []`.
   - Where `validation_rejected` leads to `continue`, set `stepReason = 'reconcile';` just before
     `continue`.
   - At the end of the loop body (where `deltaOf = stepId` was), set `stepReason = 'after_action';`.

`graphMessage.textRuns` is already a full list each time (`extractTextRuns` walks the whole page),
so it stays as is.

---

## Tests

### Gateway (`server/gateway/tests/`)

**New `test_normalize.py`:**

```python
import pytest
from aegis_gateway.model_client.normalize import PlanShapeError, normalize_plan


def test_bare_ref_is_wrapped_and_wrapped_ref_untouched():
    plan = normalize_plan({"actions": [{"op": "type", "node": "n-1", "ref": "AADHAAR#2"},
                                       {"op": "type", "node": "n-2", "ref": "⟪PAN#1⟫"}]}, "s-3")
    assert plan["actions"][0]["ref"] == "⟪AADHAAR#2⟫"
    assert plan["actions"][1]["ref"] == "⟪PAN#1⟫"

def test_top_level_action_and_list_are_wrapped():
    assert normalize_plan({"op": "done"}, "s-1")["actions"] == [{"op": "done"}]
    assert normalize_plan([{"op": "done"}], "s-1")["actions"] == [{"op": "done"}]

def test_server_owns_step_and_plan_id_and_unknown_keys_drop():
    plan = normalize_plan({"step_id": "step_1", "plan_id": "x", "junk": 1, "actions": [{"op": "done"}]}, "s-4")
    assert plan == {"actions": [{"op": "done"}], "step_id": "s-4", "plan_id": "p-4"}

def test_idempotent():
    once = normalize_plan({"actions": [{"op": "type", "node": "n-1", "ref": "EMAIL#1"}]}, "s-2")
    assert normalize_plan(once, "s-2") == once

@pytest.mark.parametrize("raw", [None, 3, "x", {"foo": 1}, {"actions": "no"}])
def test_unreadable_output_raises_plan_shape_error(raw):
    with pytest.raises(PlanShapeError):
        normalize_plan(raw, "s-1")
```

**New `test_model_facing_schema.py`:**

```python
import json
from aegis_gateway.model_client.vllm import load_action_plan_schema, load_model_facing_schema

def test_model_schema_uses_bare_refs_and_omits_server_ids():
    model = load_model_facing_schema()
    text = json.dumps(model, ensure_ascii=False)
    assert "⟪" not in text and "^[A-Z_]+#[0-9]+$" in text
    assert "step_id" not in model["properties"] and "plan_id" not in model["properties"]
    assert model["required"] == ["actions"]

def test_wire_schema_is_unchanged():
    wire = load_action_plan_schema()
    assert "step_id" in wire["required"]
    assert "⟪" in json.dumps(wire, ensure_ascii=False)
```

**`test_model_client.py` changes:**
- `test_complete_sends_the_schema_as_response_format`: build the client with
  `model_response_format="json_schema"` (the default is now `json_object`); compare against
  `load_model_facing_schema()`; assert `"chat_template_kwargs" not in captured["payload"]` (the
  default is off).
- New: default settings → `response_format == {"type": "json_object"}`; `none` → no
  `response_format` key; `model_chat_template_kwargs=True` →
  `payload["chat_template_kwargs"] == {"enable_thinking": False}`.
- New: status 401, 429 and 500 → `GatewayError` with code `MODEL_UNAVAILABLE` and messages ending
  `upstream_4xx`, `upstream_429` and `upstream_5xx`. The fake response needs only `status_code`.
- New: a 200 body `{"error": {"message": "x"}}` → `MODEL_UNAVAILABLE`, `bad_body`.
- New: content ```` ```json\n{"actions":[{"op":"done"}]}\n``` ```` parses to
  `{"actions": [{"op": "done"}]}`.
- `test_complete_raises_model_unavailable_on_a_5xx` keeps passing as is.

**New `test_full_snapshot_prompt.py`** (route level, `make_settings(mode="live")`, `complete`
monkeypatched to capture `messages` and return `{"actions": [{"op": "done"}]}`):
1. Step `s-1` with nodes n-1, n-2 → the user text has no `new` flag.
2. Step `s-2` (`delta_of: None`) with n-2 renamed and n-3 added, n-1 absent → the ELEMENTS block
   lists exactly n-2 (with `new`) and n-3 (with `new`); n-1 is absent.
3. A plan clicking n-1 at step `s-3` is rejected after one retry → 422, because n-1 is no longer
   on the page.

**New `test_bare_ref_roundtrip.py`:** the model returns
`{"actions":[{"op":"type","node":"n-1","ref":"AADHAAR#2"}]}` for a step whose `redactions` contains
`⟪AADHAAR#2⟫`, with n-1 having `type` affordance → 200, and the response ref is `⟪AADHAAR#2⟫` with
`step_id` equal to the request's.

**`test_post_validate.py`, `test_errors.py`:** unchanged. They must pass; the fake plans with
`step_id: "s-1"` are overwritten with the same value.

**New `test_rate_limit_cleanup.py`:** open a session, post one step (live mode, fake complete),
DELETE the session → `session_id not in routes_steps._recent_request_times`.

### Extension

- `test/unit/messages.spec.ts`: a graph with `full: true` is accepted; `full: 'yes'` is rejected.
- `test/unit/port.spec.ts` ("the top frame connects, sends ready and an initial graph"): assert
  the first graph message has `full: true`.
- `test/unit/session.spec.ts`, new describe `Session — full snapshot every step (A17)`:
  1. **Auto-sent graph between steps is included.** The responder answers step 1's `extract` with
     `[NODE]`. After the click's `action-result`, it emits an unsolicited graph `{nodes: [NODE_C],
     removed: []}`, then answers step 2's `extract` with `{nodes: [], removed: []}`. Assert the
     second `sendToGateway` payload's `nodes` ids are `['n-1', 'n-c']`.
  2. **A full graph prunes.** Step 1 `[NODE, NODE_B]`; step 2 answers with
     `{nodes: [NODE], removed: [], full: true}` → the second payload's node ids are `['n-1']`.
  3. **Reason and delta_of.** Payload 1 has `reason: 'initial'` and `delta_of: null`; payload 2
     (after an executed click) has `reason: 'after_action'` and `delta_of: null`.
  4. **Rejected plan → reconcile.** The first gateway answer is schema-invalid, the second is
     `done` → payload 2 has `reason: 'reconcile'`.

## Live check

Against the R-1 endpoint, with `AEGIS_MODE=live` and `AEGIS_MODEL_RESPONSE_FORMAT` set per the R-1
report:

```bash
cd server/gateway && .venv/bin/python scripts/r3_live_check.py
```

Create `server/gateway/scripts/r3_live_check.py` from the R-2 script, changed to:
- post the login fixture step 10 times, each in a new session: nodes `n-u` (textbox "Username",
  `type` affordance), `n-p` (textbox "Password", value `presence`), `n-s` (button "Sign in"),
  plus a redaction `⟪USERNAME#1⟫`;
- use the task "Type my username into the username field, then click Sign in.";
- count HTTP 200s, 503s and 422s, and time each call;
- print `ok=<n>/10 p50=<s> p95=<s>`, and exit non-zero unless `ok == 10`.

**Acceptance:**
- [ ] The live check prints `ok=10/10`. Record p50/p95 in `tasks.md` §1 as "Live model step via
  gateway".
- [ ] Gateway pytest is green, including every new test above.
- [ ] Extension node tests are green, including the new session tests.
- [ ] An upstream 401/402/429 returns 503 `MODEL_UNAVAILABLE` with the reason in the message,
  never 500 (covered by the unit tests).
- [ ] The Decision-log rows R3-full-snapshot, R3-response-format and R3-reason in `tasks.md` still
  match what was built. Update them if anything changed during implementation.
