# R-2 — Gateway: send the sanitized image to the VLM (+ API key)

**Priority:** P0 · **Depends on:** R-1 · **Unblocks:** R-3, R-6, R-10, R-12
**Bugs fixed:** A5 (logging half), A12 · **Parent list:** [tasks.md](tasks.md)

> **Status (2026-09-28):** §1–§6 (gateway) and their tests are **implemented**, as part of
> R-1's Groq integration (see [R-1](R-1-vlm-endpoint.md#second-pass-2026-09-28-gateway-integration-and-reliability)).
> `scripts/r2_live_check.py` exists; live result so far 2/3, the third run hit Groq's daily token
> limit. **Still open:** §7 (extension session metadata, A12) and its tests, and the live box at
> 3/3.

Paths are relative to `AEGIS/`. The gateway package root is `server/gateway/src/aegis_gateway/`,
shortened below to `gw/`.

## Goal

The guarded WebP the extension already sends reaches the model as an OpenAI image content part.
The gateway can call an authenticated hosted endpoint. The base64 image is never logged.

Nothing new leaves the device. The gateway only ever receives the guarded payload (guard step 5
runs client-side before egress); this step stops the gateway discarding the image.

## Scope decisions (fixed)

- **The replay key moves to R-6.** Node ids are random per session
  (`content/screen-graph/identity.ts:11-17`), so no key that contains them can ever match across
  real runs. Excluding `image.data` alone (the old plan) would not make replay work. R-6 replaces
  the key with an id-independent one. R-2 fixes only the **logging** half of A5.
- **The provider switch and `chat_template_kwargs` move to R-3.** They are output-format concerns.
  R-2 adds only what's needed to send an image to an authenticated endpoint: key, vision flag,
  `max_tokens`.
- **`build_messages` keeps working without the new argument.** `vision` defaults to `False`, so
  `tools/vlm/smoke.py` and the existing tests keep their current behaviour. The route passes
  `settings.model_vision` explicitly.

## Today (verified)

- `gw/prompt/__init__.py`: `build_messages(step_request) -> list[dict[str, str]]` builds the text
  user message and ignores `step_request["image"]`.
- `gw/prompt/legend.py`: `render_legend` renders `ref | entity | class` with no boxes. Its
  docstring says `redactions[]` is never populated; that is stale.
- `gw/model_client/vllm.py:VLLMClient.complete(messages: list[dict[str, str]])`:
  - posts `{"model", "messages", "response_format", **chat_template_kwargs}`;
  - no `Authorization` header, no `max_tokens`.
- `gw/structured_log.py:log_payload` dumps the whole step dict, base64 image included, when
  `AEGIS_LOG_PAYLOADS=true`.
- `gw/config.py:Settings` is a frozen dataclass whose fields all lack defaults.
  `tests/conftest.py:make_settings` builds it with every field explicitly.
- `apps/extension/src/host/egress/gateway-client.ts:defaultSessionCreate` sends
  `policy: 'phase2-none'`, `backend: 'wasm'` and
  `capabilities: { l1_image: false, l2_crop: false, click_point: true }` (A12).
  `openSession()` runs in `main.tsx:316` **before** the perception worker's `init`, so the real
  backend isn't known yet at that point.

## Implementation

### 1. `gw/config.py`

Add three fields **at the end** of `Settings`, with defaults, so existing constructions (tests)
keep working:

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Settings:
    token: str
    model_url: str
    model_name: str
    mode: Mode
    record_dir: str
    session_ttl_s: int
    max_body_mb: int
    log_payloads: bool
    model_timeout_s: float
    model_api_key: str | None = field(default=None, repr=False)
    model_vision: bool = True
    model_max_tokens: int = 512
```

In `load_settings()` add:

```python
        model_api_key=os.environ.get("AEGIS_MODEL_API_KEY") or None,
        model_vision=_env_bool("AEGIS_MODEL_VISION", True),
        model_max_tokens=int(os.environ.get("AEGIS_MODEL_MAX_TOKENS", "512")),
```

`repr=False` keeps the key out of `repr(settings)` and so out of any accidental log or traceback.

### 2. `gw/prompt/legend.py`

Replace the whole file:

```python
"""design.md §4.3/§12.2 — the redaction legend. One line per redaction. With an image attached,
each line also carries the redaction's first box, so the model can match a black box in the image
to its placeholder."""

from __future__ import annotations


def _box(box: list[float]) -> str:
    return f"[{box[0]:g},{box[1]:g},{box[2]:g},{box[3]:g}]"


def render_legend(redactions: list[dict], *, with_boxes: bool = False) -> str:
    if not redactions:
        return "(none)"
    lines = []
    for entry in redactions:
        ref = entry.get("ref") or "(unresolvable)"
        line = f"{ref} | {entry['entity']} | {entry['class']}"
        boxes = entry.get("boxes") or []
        if with_boxes and boxes:
            line += f" | {_box(boxes[0])}"
        lines.append(line)
    return "\n".join(lines)
```

With `with_boxes=False` the output is byte-identical to today.

### 3. `gw/prompt/__init__.py`

Replace the whole file:

```python
"""design.md §12.2 — assembles the system + user messages for one step. The system message is
always the exact same string (system.SYSTEM_PROMPT); everything per-request lives in the user
message. Without an image (or with vision off) the user text is byte-identical to the pre-R-2
format, which keeps the provider's prefix cache and existing replay entries valid."""

from __future__ import annotations

from .elements import render_elements
from .history import render_history
from .legend import render_legend
from .system import SYSTEM_PROMPT

__all__ = ["SYSTEM_PROMPT", "build_messages", "build_user_message"]


def _image_lines(step_request: dict) -> str:
    image = step_request["image"]
    region = image["region"]
    coverage = step_request["coverage"]
    return (
        f"\nIMAGE: level={image['level']} "
        f"region=[{region[0]:g},{region[1]:g},{region[2]:g},{region[3]:g}] "
        f"scale={image['scale']:g} "
        f"cleared={coverage['cleared']:.2f} redacted={coverage['redacted']:.2f} "
        f"unanalysed={coverage['unanalysed']:.2f}\n"
        f"LEGEND: {image['legend']}"
    )


def build_user_message(step_request: dict, *, with_image: bool = False) -> str:
    viewport = step_request["viewport"]
    text_runs = "\n".join(f'{t["id"]}: "{t["text"]}"' for t in step_request.get("text", []))
    message = (
        f"TASK: {step_request['task']}\n"
        f"HISTORY: {render_history(step_request.get('history', []))}\n"
        f"VIEWPORT: {viewport['w']}x{viewport['h']}, scroll_y={viewport['scroll_y']}\n"
        f"REDACTIONS: {render_legend(step_request.get('redactions', []), with_boxes=with_image)}\n"
        f"ELEMENTS:\n{render_elements(step_request.get('nodes', []))}\n"
        f"TEXT: {text_runs or '(none)'}"
    )
    if with_image:
        message += _image_lines(step_request)
    return message


def build_messages(step_request: dict, *, vision: bool = False) -> list[dict[str, object]]:
    image = step_request.get("image") if vision else None
    text = build_user_message(step_request, with_image=image is not None)
    user_content: str | list[dict[str, object]] = text
    if image is not None:
        user_content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image['format']};base64,{image['data']}"},
            },
        ]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
```

The IMAGE and LEGEND lines go **after** `TEXT:`, so everything before them keeps the same prefix as
a no-image step. `image["legend"]` is the extension's string, e.g. "Grey = unanalysed. Black boxes
are redacted (labelled with their placeholder or type). Everything else is shown as captured."
(`host/session.ts:460`).

### 4. `gw/model_client/vllm.py`

Change only `complete`'s signature, the payload, and the post call:

```python
    async def complete(self, messages: list[dict[str, object]]) -> dict:
        schema = load_action_plan_schema()
        payload = {
            "model": self._settings.model_name,
            "messages": messages,
            "max_tokens": self._settings.model_max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "action_plan", "schema": schema, "strict": True},
            },
            **self._adapter.chat_template_kwargs(),
        }
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
        ...  # rest unchanged
```

`response_format` and `chat_template_kwargs` change again in R-3; don't pre-empt that here.

### 5. `gw/api/routes_steps.py`

Line 131: `messages = build_messages(step_dict)` → `messages = build_messages(step_dict, vision=settings.model_vision)`.

In `_get_plan`, the `messages` parameter type becomes `list[dict[str, object]]`.

### 6. `gw/structured_log.py` — never log the image bytes (A5, logging half)

Replace `log_payload`:

```python
def _without_image_bytes(step_request: dict) -> dict:
    image = step_request.get("image")
    if not image:
        return step_request
    return {**step_request, "image": {**image, "data": f"<{len(image.get('data', ''))} b64 chars>"}}


def log_payload(step_request: dict, enabled: bool) -> None:
    if enabled:
        logger.info(json.dumps({"event": "payload", "payload": _without_image_bytes(step_request)}))
```

No log call anywhere may include `settings.model_api_key`. Today none does; the test below keeps
it that way.

### 7. Extension session metadata (A12) — `apps/extension/src/host/egress/gateway-client.ts`

Replace `defaultSessionCreate`, the `GatewayClient` interface, `openSession`, and the header
comment:

```ts
// design.md §4.1 — session open/close carry no page data (architecture §8.1), so they bypass the
// guard; only `sendStep` goes through `EgressClient`, which refuses anything not `GuardedPayload`.

export interface SessionMeta {
  /** `<policy.id>@<policy.version>`, ≤ 60 chars (session.schema.json). */
  policy: string;
  /** The backend preference from Settings; the worker's real backend isn't known until after
   * the session opens. 'auto' is sent as 'wasm', the backend every machine has. */
  backend: 'webgpu' | 'wasm';
}

export interface GatewayClient {
  openSession(meta: SessionMeta): Promise<SessionCreated>;
  sendStep(sessionId: string, payload: GuardedPayload, signal: AbortSignal): Promise<unknown>;
  closeSession(sessionId: string): Promise<void>;
}

function sessionCreate(browserName: 'chrome' | 'firefox', meta: SessionMeta): SessionCreate {
  return {
    schema: 'AEGIS/1',
    client: {
      browser: browserName,
      extension_version: '0.1.0',
      backend: meta.backend,
      detectors: {},
      policy: meta.policy.slice(0, 60),
      capabilities: { l1_image: true, l2_crop: false, click_point: true },
    },
  };
}
```

`openSession(meta)` posts `JSON.stringify(sessionCreate(browserName, meta))`.
`l2_crop: false` stays until R-10 implements L2.

In `entrypoints/sidepanel/main.tsx` line 316:

```ts
const sessionPolicy = applyAlwaysRedact(defaultPolicy, settingsRef.current.alwaysRedact);
created = await gateway.openSession({
  policy: `${sessionPolicy.id}@${sessionPolicy.version}`,
  backend: settingsRef.current.backend === 'webgpu' ? 'webgpu' : 'wasm',
});
```

Then reuse `sessionPolicy` for the `policy:` field of `new Session({...})` (line 431), instead of
calling `applyAlwaysRedact` a second time.

Update `test/unit/gateway-client.spec.ts`: every `client.openSession()` call becomes
`client.openSession({ policy: 'default@1', backend: 'wasm' })`. Add one assertion to the first
test:

```ts
expect(body.client.capabilities).toEqual({ l1_image: true, l2_crop: false, click_point: true });
expect(body.client.policy).toBe('default@1');
```

Also update `server/gateway/tests/conftest.py:session_create_body()`: set
`"policy": "default@1"` and `"l1_image": True`. This is cosmetic; the gateway doesn't read these
fields.

## Tests (gateway) — `server/gateway/tests/`

### New file `test_prompt_image.py`

```python
from __future__ import annotations

from aegis_gateway.prompt import build_messages, build_user_message

from .conftest import sanitized_context_body

IMAGE = {
    "level": "L1",
    "region": [0, 0, 1280, 720],
    "scale": 1,
    "format": "image/webp",
    "sha256": "0" * 64,
    "data": "UklGRg==",
    "legend": "Grey = unanalysed.",
}
REDACTION = {
    "ref": "⟪AADHAAR#1⟫", "entity": "AADHAAR", "class": "CRITICAL", "boxes": [[220, 418, 340, 40]],
    "method": "placeholder", "confidence": 1, "sources": ["dom:aadhaar"], "unverified": False,
}


def _user(messages):
    return next(m["content"] for m in messages if m["role"] == "user")


def test_no_image_keeps_the_text_format_byte_identical() -> None:
    step = sanitized_context_body(redactions=[REDACTION])
    golden = build_user_message(step)            # pre-R-2 call shape
    assert _user(build_messages(step)) == golden
    assert _user(build_messages(step, vision=True)) == golden   # vision on, but no image
    assert "IMAGE:" not in golden
    assert "[220,418,340,40]" not in golden


def test_image_with_vision_on_becomes_two_content_parts() -> None:
    step = sanitized_context_body(
        image=IMAGE, redactions=[REDACTION],
        coverage={"cleared": 0.62, "redacted": 0.04, "unanalysed": 0.34},
    )
    content = _user(build_messages(step, vision=True))
    assert isinstance(content, list) and len(content) == 2
    assert content[0]["type"] == "text"
    assert content[1] == {"type": "image_url", "image_url": {"url": "data:image/webp;base64,UklGRg=="}}
    text = content[0]["text"]
    assert text.endswith(
        "IMAGE: level=L1 region=[0,0,1280,720] scale=1 cleared=0.62 redacted=0.04 unanalysed=0.34\n"
        "LEGEND: Grey = unanalysed."
    )
    assert "⟪AADHAAR#1⟫ | AADHAAR | CRITICAL | [220,418,340,40]" in text


def test_image_with_vision_off_is_text_only_and_mentions_no_image() -> None:
    step = sanitized_context_body(image=IMAGE)
    content = _user(build_messages(step, vision=False))
    assert isinstance(content, str)
    assert "IMAGE:" not in content and "UklGRg" not in content
```

### Additions to `test_model_client.py`

- Update every `FakeAsyncClient.post` to `async def post(self, url: str, json: dict, **kwargs)`,
  and store `captured["headers"] = kwargs.get("headers", {})`.
- New tests:

```python
@pytest.mark.asyncio
async def test_complete_sends_bearer_key_and_max_tokens_when_configured(monkeypatch) -> None:
    captured = _install_fake_client(monkeypatch)   # helper: the FakeAsyncClient above, returning a valid plan
    client = VLLMClient(make_settings(mode="live", model_api_key="sk-test", model_max_tokens=321))
    await client.complete([{"role": "user", "content": "x"}])
    assert captured["headers"] == {"Authorization": "Bearer sk-test"}
    assert captured["payload"]["max_tokens"] == 321


@pytest.mark.asyncio
async def test_complete_sends_no_auth_header_without_a_key(monkeypatch) -> None:
    captured = _install_fake_client(monkeypatch)
    await VLLMClient(make_settings(mode="live")).complete([{"role": "user", "content": "x"}])
    assert captured["headers"] == {}


def test_settings_repr_never_contains_the_key() -> None:
    assert "sk-test" not in repr(make_settings(model_api_key="sk-test"))
```

Factor the repeated `FakeResponse`/`FakeAsyncClient` classes into `_install_fake_client(monkeypatch,
content=...)` at the top of the file while doing this.

### New file `test_payload_logging.py`

```python
import logging

from aegis_gateway.structured_log import log_payload

from .conftest import sanitized_context_body


def test_log_payload_never_writes_image_bytes(caplog) -> None:
    step = sanitized_context_body(image={
        "level": "L1", "region": [0, 0, 10, 10], "scale": 1, "format": "image/webp",
        "sha256": "0" * 64, "data": "QUJDREVGR0g=", "legend": "x",
    })
    with caplog.at_level(logging.INFO, logger="aegis_gateway"):
        log_payload(step, enabled=True)
    assert "QUJDREVGR0g=" not in caplog.text
    assert "<12 b64 chars>" in caplog.text
```

### Route wiring test (append to `test_server_timing.py` or a new `test_route_vision.py`)

Monkeypatch `VLLMClient.complete` to capture `messages`. POST a step with `image` set, using
`make_settings(mode="live", model_vision=True)`, and assert the user content is a 2-part list. Do
the same with `model_vision=False` and assert it is a `str`.

## Tests (extension)

- `test/unit/gateway-client.spec.ts`, as described in §7.
- `pnpm --filter @aegis/extension exec vitest run --project node` is green.

## Live check (acceptance)

1. Start the gateway against the R-1 endpoint:

```bash
cd server/gateway
set -a; . ../deploy/model.env; set +a        # AEGIS_MODE=live, R-1 values
AEGIS_TOKEN=dev-token .venv/bin/uvicorn aegis_gateway.main:app --port 8787
```

2. Send one step with an image in which the only way to identify the target is visual. Use
   `smoke.py`'s fixture: a green button with no accessible name under a red banner. Create
   `server/gateway/scripts/r2_live_check.py`:

```python
"""R-2 live check: the model must pick a node only identifiable from the image."""
import base64, json, sys, urllib.request
sys.path.insert(0, "../../tools/vlm")
from smoke import make_fixture_image  # synthetic image, BUTTON_BOX = (880, 420, 1120, 500)

BASE, TOKEN = "http://127.0.0.1:8787", "dev-token"
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

sid = post("/v1/sessions", {"schema": "AEGIS/1", "client": {"browser": "chrome", "extension_version": "0.1.0",
      "backend": "wasm", "detectors": {}, "policy": "r2-check", "capabilities": {"l1_image": True, "click_point": True}}})["session_id"]
webp = make_fixture_image("ZEBRA-42")
node = lambda i, box: {"id": i, "role": "button", "name": "", "box": box, "frame": "f-0", "z": 0,
                       "state": {}, "affordances": ["click"]}
step = {"schema": "AEGIS/1", "step_id": "s-1", "task": "Click the green button below the red banner.",
        "reason": "initial", "delta_of": None,
        "viewport": {"w": 1280, "h": 720, "dpr": 1, "scroll_y": 0, "doc_h": 720},
        "page": {"category": "unknown", "title": "Citizen Services Portal"},
        "nodes": [node("n-a1", [260, 520, 200, 60]), node("n-b2", [880, 420, 240, 80]), node("n-c3", [40, 640, 160, 50])],
        "text": [], "redactions": [], "unexplained": [],
        "coverage": {"cleared": 0.8, "redacted": 0.02, "unanalysed": 0.18},
        "image": {"level": "L1", "region": [0, 0, 1280, 720], "scale": 1, "format": "image/webp",
                  "sha256": "0" * 64, "data": base64.b64encode(webp).decode(), "legend": "Grey = unanalysed."},
        "history": [], "client_timing": {}}
plan = post(f"/v1/sessions/{sid}/steps", step)
print(json.dumps(plan))
assert any(a.get("op") == "click" and a.get("node") == "n-b2" for a in plan["actions"]), "model did not use the image"
print("R-2 live check: PASS")
```

   All three buttons have empty names, so the model can pick `n-b2` only from the pixels. The
   gateway doesn't verify `sha256`; the extension's guard does.

**Acceptance:**
- [ ] The live check prints `R-2 live check: PASS` against the R-1 endpoint. Until R-3 lands, a
  `PLAN_INVALID` caused by `step_id`/ref shape is possible; if so, run it again after R-3. This
  box closes when it passes.
- [ ] Gateway pytest is green, including the new tests.
- [ ] Extension node tests are green.
- [ ] `AEGIS_LOG_PAYLOADS=true` with an image step: the log line contains `b64 chars` and no image
  bytes.
