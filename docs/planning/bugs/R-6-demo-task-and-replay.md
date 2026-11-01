# R-6 — Demo task: live runs + a replay fallback that actually replays

**Priority:** P0 · **Depends on:** R-2, R-3, R-4, R-5 · **Unblocks:** R-13, R-16, R-18
**Bugs fixed:** A5 (key half), A20, A22, A23 (all new) · **Parent list:** [tasks.md](tasks.md)

Paths are relative to `AEGIS/`. `gw/` = `server/gateway/src/aegis_gateway/`, `ext/` =
`apps/extension/`.

## Goal

One primary demo task runs end to end against the R-1 model three times in a row, cleanly. Its
recording replays with the network off. Per-stage latency, including the server's own breakdown,
is recorded.

## New bugs found while writing this step

| # | Bug | Where |
|---|---|---|
| A20 | Record mode stores the model's **raw** first answer before validation, including answers that fail and get retried. Replay then serves the invalid first answer, and the retry key (it contains `_retry_note`) is recorded separately. A recorded run doesn't replay the plan the live run actually executed. | `gw/api/routes_steps.py:_get_plan` |
| A23 | After a navigation, the model can't know the refs minted on the previous page. The prompt's `REDACTIONS:` legend lists only the current payload's `redactions`. The target page's fields are empty, so `⟪AADHAAR#1⟫` from the profile page appears nowhere in the step-2 prompt, even though the gateway session has it in `sent_refs` (post-validation would accept it). The model has no conversation memory (each step is a fresh system + user message), so a cross-page fill task can't be done. | `gw/prompt/__init__.py`, `gw/sessions/store.py` |
| A22 | Replay can never match a real extension run. Node ids are random per session (`ext/src/content/screen-graph/identity.ts:11-17`, `n-<counter><random>`), and they appear in `nodes[].id`, `redactions`, history and every plan. `canonical_key` hashes them, so every run produces new keys. `eval/src/aegis_eval/runner/gateway_mock.py`'s docstring records the same finding. Only the gateway's own tests replay, because they reuse one fixed body. | `gw/replay/store.py` |

## Decisions (fixed)

- **Primary task:** "Fill the certificate application using my details from my profile and
  submit it." It runs on three same-origin pages: `profile.html` → `apply.html` →
  `submitted.html`. It exercises:
  - the image: a real face photo (public-domain portrait) gets a FACE fill;
  - Aadhaar, phone and email placeholders, typed back through rehydration;
  - a pre-filled password field that is never read;
  - two navigations (R-5);
  - a confirmation: rehydrating a CRITICAL value (Aadhaar) always asks.
- **No person name on the page until R-8.** Channel D/T can't detect a free-text name today, so it
  would ship as plain text. R-8 adds a "Full name" row and re-records.
- **Backups.**
  - B1 (read-only): "Find the helpline number on this page" on `profile.html`, which has a
    helpline line. Expected answer: a `report` or `done` whose summary contains the helpline digits
    (a toll-free number, not personal data).
  - B2 (real public page): chosen by the team at rehearsal time and never submitted. It stays
    manual, because real pages change.
- **Replay key v2** is id-independent (below). Replay maps node ids back through each node's
  descriptor `role|name|occurrence`. It must run at the same window size as the recording
  (1280×720 in the harness), because the visible node set depends on it.
- **Record the validated plan** under the first-attempt key, never the raw answer.

## Implementation

### 1. Demo pages — `eval/demo/citizen/` (new folder)

All values are synthetic. Values that must round-trip (typed on `apply.html`, shown on
`submitted.html`):

| Field | Value | Detected by |
|---|---|---|
| Aadhaar | `2345 6789 0124` (Verhoeff-valid; already the demo fixture's value) | Channel T `aadhaar` |
| Mobile | `+91 98765 43210` | Channel T `phone` |
| Email | `asha.verma@example.in` | Channel T `email` |
| Portal password (prefilled on apply) | `hunter2-correct-battery` | Channel D protected (never read) |
| Helpline (B1) | `1800-11-4000` | not sensitive |

`profile.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Citizen Services — My profile</title>
<style>body{font:16px system-ui;margin:24px;width:1100px} dt{font-weight:600} img{border-radius:8px}</style></head>
<body>
  <header><h1>Citizen Services Portal</h1><p>Helpline: 1800-11-4000</p></header>
  <main>
    <h2>My profile</h2>
    <img src="face.jpg" alt="Profile photo" width="160" height="200">
    <dl>
      <dt>Aadhaar number</dt><dd>2345 6789 0124</dd>
      <dt>Mobile</dt><dd>+91 98765 43210</dd>
      <dt>Email</dt><dd>asha.verma@example.in</dd>
    </dl>
    <a href="apply.html">Apply for a residence certificate</a>
  </main>
</body></html>
```

`apply.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Citizen Services — Residence certificate</title>
<style>body{font:16px system-ui;margin:24px;width:1100px} label{display:block;margin:12px 0}</style></head>
<body>
  <h1>Residence certificate application</h1>
  <form action="submitted.html" method="get">
    <label>Aadhaar number <input name="aadhaar" autocomplete="off" inputmode="numeric"></label>
    <label>Mobile number <input name="mobile" type="tel" autocomplete="tel"></label>
    <label>Email <input name="email" type="email" autocomplete="email"></label>
    <label>Portal password <input name="pw" type="password" value="hunter2-correct-battery"></label>
    <label><input name="consent" type="checkbox"> I confirm these details are correct</label>
    <button type="submit">Submit application</button>
  </form>
</body></html>
```

`submitted.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Citizen Services — Submitted</title></head>
<body>
  <h1>Application submitted</h1>
  <p id="summary"></p>
  <script>
    const q = new URLSearchParams(location.search);
    const digits = (s) => (s || '').replace(/\D/g, '');
    document.getElementById('summary').textContent =
      `Aadhaar ending ${digits(q.get('aadhaar')).slice(-4)}, mobile ending ${digits(q.get('mobile')).slice(-4)}, consent ${q.get('consent') ? 'yes' : 'no'}`;
  </script>
</body></html>
```

`face.jpg`: copy `ext/test/fixtures/real-face-einstein-1947-pd.jpg`. It is public domain and
already in the repo; YuNet detects it. Add `eval/demo/citizen/LICENSE.md`: one line naming the
image's source and public-domain status, copied from wherever `ext/test/fixtures/` records it
(`NOTICE` or the fixture's own comment).

The profile page shows the values as text and `apply.html` has empty fields, so the model has to
carry the refs across a navigation. Same origin, so rehydration is allowed.

### 2. Replay store v2 — rewrite `gw/replay/store.py`

```python
"""Record/replay of model plans for the offline demo. Node ids are random per extension session,
so the key and the stored plan never contain them: a node is identified by its descriptor
`role|name|n` (n = its occurrence index among nodes with the same role and name, in payload
order). A stored plan targets descriptors, and replay maps them back to this run's ids."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

FORMAT = 2


def node_descriptors(nodes: list[dict]) -> dict[str, str]:
    """node id -> descriptor."""
    seen: dict[str, int] = {}
    out: dict[str, str] = {}
    for node in nodes:
        base = f"{node['role']}|{node['name']}"
        index = seen.get(base, 0)
        seen[base] = index + 1
        out[node["id"]] = f"{base}|{index}"
    return out


def canonical_key(step_request: dict) -> str:
    image = step_request.get("image")
    key = {
        "task": step_request["task"],
        "step": int(str(step_request["step_id"]).removeprefix("s-")),
        "reason": step_request["reason"],
        "nodes": sorted(node_descriptors(step_request.get("nodes", [])).values()),
        "text": sorted(t["text"] for t in step_request.get("text", [])),
        "refs": sorted(r["ref"] for r in step_request.get("redactions", []) if r.get("ref")),
        "history": [[*(a.get("op", "?") for a in h.get("actions", [])), h.get("outcome", "")] for h in step_request.get("history", [])],
        "image": {"level": image["level"], "region": image["region"]} if image else None,
    }
    canonical = json.dumps(key, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ReplayStore:
    def __init__(self, directory: str) -> None:
        self._dir = Path(directory)

    def _path_for(self, key: str) -> Path:
        return self._dir / f"{key}.json"

    def record(self, step_request: dict, plan: dict) -> None:
        """`plan` must already be validated. Node ids become descriptors."""
        descriptors = node_descriptors(step_request.get("nodes", []))
        actions = []
        for action in plan["actions"]:
            action = dict(action)
            if "node" in action:
                action["node"] = {"$node": descriptors[action["node"]]}
            actions.append(action)
        stored = {"format": FORMAT, "plan": {**{k: v for k, v in plan.items() if k not in ("step_id", "plan_id")}, "actions": actions}}
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path_for(canonical_key(step_request)).write_text(json.dumps(stored, ensure_ascii=False))

    def lookup(self, step_request: dict) -> dict | None:
        path = self._path_for(canonical_key(step_request))
        if not path.exists():
            return None
        stored = json.loads(path.read_text())
        if stored.get("format") != FORMAT:
            return None
        by_descriptor = {d: nid for nid, d in node_descriptors(step_request.get("nodes", [])).items()}
        actions = []
        for action in stored["plan"]["actions"]:
            action = dict(action)
            if isinstance(action.get("node"), dict):
                node_id = by_descriptor.get(action["node"]["$node"])
                if node_id is None:
                    return None
                action["node"] = node_id
            actions.append(action)
        return {**stored["plan"], "actions": actions}

    def is_loaded(self) -> bool:
        return self._dir.exists() and any(self._dir.glob("*.json"))
```

Why these key fields:
- `client_timing`, `coverage`, `unexplained`, the viewport scroll position, boxes and image bytes
  all vary between otherwise identical runs, so they are left out (they don't change what the
  model decided).
- `refs` are minted in discovery order by a fresh vault per task, so they are stable per flow.
- The returned plan has no `step_id`/`plan_id`; `normalize_plan` (R-3) adds them.
- `record` requires every `node` in the plan to be a node the request sent. That always holds for
  a validated plan, because post-validation checks it.

### 2b. Earlier values in the prompt (A23)

**`gw/sessions/store.py`:** add `ref_entities: dict[str, str] = field(default_factory=dict)`
(ref → entity). In `apply_step_context`'s redaction loop, next to `self.sent_refs.add(ref)`, add
`self.ref_entities[ref] = redaction["entity"]`.

**`gw/prompt/__init__.py`:** `build_user_message` gains `earlier_refs: dict[str, str] | None = None`
(ref → entity). When it is non-empty, insert one line right after the `REDACTIONS:` line:

```python
    earlier = "".join(f"\n  {ref} | {entity}" for ref, entity in sorted((earlier_refs or {}).items()))
    ...
        f"REDACTIONS: {render_legend(...)}\n"
        + (f"EARLIER VALUES (sealed values seen on previous pages; usable with type.ref):{earlier}\n" if earlier else "")
        + f"ELEMENTS:\n..."
```

`build_messages` passes the same argument through.

**`gw/api/routes_steps.py`:** after `apply_step_context`, compute

```python
    current_refs = {r["ref"] for r in step_dict.get("redactions", []) if r.get("ref")}
    earlier_refs = {ref: entity for ref, entity in session.ref_entities.items() if ref not in current_refs}
```

and pass `earlier_refs=earlier_refs` to `build_messages`.

When nothing was seen earlier, the prompt is byte-identical to R-3's. Only refs are shown, never
values; they are the same sealed placeholders the session already sent.

**Test (`server/gateway/tests/test_full_snapshot_prompt.py`, new case):**
- step 1 carries redaction `⟪AADHAAR#1⟫`;
- step 2 (new page) carries no redactions;
- the step-2 user text contains `EARLIER VALUES` and `⟪AADHAAR#1⟫ | AADHAAR`;
- a plan typing `⟪AADHAAR#1⟫` (or bare `AADHAAR#1`) into a `type`-afforded node on step 2 is
  accepted (200).

### 3. Record the validated plan — `gw/api/routes_steps.py` (A20)

- In `_get_plan`, delete the two lines
  `if settings.mode == "record": replay_store.record(step_dict, plan)`. `_get_plan` becomes:

```python
async def _get_plan(messages, settings, replay_store, model_client, step_dict) -> object:
    if settings.mode == "replay":
        plan = replay_store.lookup(step_dict)
        if plan is None:
            raise model_unavailable()
        return plan
    return await model_client.complete(messages)
```

- After the validate block (after `timings["validate"] = …`), add:

```python
    if settings.mode == "record":
        replay_store.record(step_dict, plan)
```

  `step_dict` here is the **first-attempt** request (never `retry_step_dict`), so replay finds the
  plan on its first lookup and never retries.
- Stop adding `_retry_note` to the retry request dict. It has no reader any more. Pass
  `step_dict` in both `_get_plan` calls. In replay mode the retry lookup returns the same plan,
  and that is fine: a recorded plan was valid when recorded.

### 4. Server-Timing reaches the ledger

**Gateway** (`gw/api/routes_steps.py`, where the response is built):

```python
    response.headers["Server-Timing"] = ", ".join(f"{name};dur={duration * 1000:.1f}" for name, duration in timings.items())
    response.headers["Access-Control-Expose-Headers"] = "Server-Timing"
```

The expose header makes the value readable from the extension page even when the request is
subject to CORS.

**Extension, `ext/src/host/egress/gateway-client.ts`:**

```ts
export function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith('dur='));
    const value = dur ? Number(dur.slice(4)) : NaN;
    if (name && Number.isFinite(value)) out[name] = value;
  }
  return out;
}
```

Change `GatewayClient.sendStep` to return `Promise<{ plan: unknown; serverTiming: Record<string, number> }>`:

```ts
    async sendStep(sessionId, payload, signal) {
      const response = await egress.sendStep(payload, `${baseUrl}/v1/sessions/${sessionId}/steps`, signal, token);
      if (!response.ok) throw new Error(`STEP_FAILED: ${response.status}`);
      return { plan: await response.json(), serverTiming: parseServerTiming(response.headers.get('server-timing')) };
    },
```

**Extension, `ext/src/host/ledger/ledger.ts`:** add `serverTiming?: Record<string, number>;` to
`LedgerEntry`.

**Extension, `ext/src/host/session.ts`:**
- Add to `SessionDeps`:
  `takeServerTiming?: () => Record<string, number> | undefined;` ("Server-Timing of the step
  response just received; read once per step").
- Right after `rawPlan = await this.deps.sendToGateway(guarded, signal);` succeeds:

```ts
      const serverTiming = this.deps.takeServerTiming?.();
      const entry = this.ledger.latest();
      if (serverTiming && entry?.stepId === stepId) entry.serverTiming = serverTiming;
```

**Extension, `ext/entrypoints/sidepanel/main.tsx`:**

```ts
    let lastServerTiming: Record<string, number> | undefined;
    ...
      sendToGateway: async (payload, signal) => {
        const { plan, serverTiming } = await gateway.sendStep(created.session_id, payload, signal);
        lastServerTiming = serverTiming;
        return plan;
      },
      takeServerTiming: () => {
        const value = lastServerTiming;
        lastServerTiming = undefined;
        return value;
      },
```

**`ext/src/ui/StepTimeline.tsx`:** when `debugOverlay` is on and the step's ledger entry has
`serverTiming.model`, show `model <n> ms` next to the step's `server` stage time. The component
receives `steps`; pass the ledger entries' `serverTiming` keyed by `stepId` as a second prop,
`serverTimings: Record<string, Record<string, number>>`, built in `main.tsx` from
`session.getLedger().all()` whenever a `step` event arrives.

### 5. Answer confirmations from the harness — `eval/src/aegis_eval/runner/drive.py`

Add:

```python
LIVE_TASK_TIMEOUT_S = 300.0


def run_task_answering_confirmations(panel: Page, fixture_page: Page, task: str, allow: bool = True, timeout_s: float = LIVE_TASK_TIMEOUT_S) -> int:
    """Like run_task_in_panel, but clicks 'Allow once' (or 'Deny') on every confirmation card
    until the panel reaches a terminal label. Returns how many confirmations were answered.
    `timeout_s` defaults to 5 minutes: a multi-step task against a live model takes far longer
    than TASK_TIMEOUT_S (15 s), which is sized for the mock gateway."""
    fixture_page.bring_to_front()
    panel.evaluate(f"void window.__aegisRunTask({task!r}, [])")
    answered = 0
    deadline = time.monotonic() + timeout_s
    button = "Allow once" if allow else "Deny"
    while time.monotonic() < deadline:
        text = panel.evaluate("document.body.innerText")
        if any(word in text for word in ("Done", "Error", "Blocked")):
            return answered
        confirm = panel.get_by_role("button", name=button)
        if confirm.count() > 0:
            confirm.first.click()
            answered += 1
        time.sleep(HOOK_POLL_INTERVAL_S)
    raise TimeoutError("task did not reach a terminal state")
```

`void` makes `evaluate` return at once instead of awaiting the whole task.
`run_task_in_panel` awaits the promise, which would block on the first confirmation.

### 6. Demo runner — `eval/src/aegis_eval/demo.py` (new) + CLI

```python
"""R-6: runs the citizen demo task against a REAL gateway (no mock) N times and checks each run.
Writes eval/reports/<date>-demo.json with per-run checks and per-stage latency."""
```

Behaviour, in order:

1. `with serve_corpus(Path("eval/demo")) as base_url:`, then open an extension context using
   `runner/browser.py:extension_context(...)` with the same arguments `runner/main.py` uses for a
   dev-split run, **without** installing `MockGateway`. The panel uses its built-in gateway URL
   (`VITE_GATEWAY_URL`, default `http://localhost:8787`).
2. For each run `i` in `range(runs)`:
   - open `f"{base_url}/citizen/profile.html"`, then open the panel;
   - `answered = run_task_answering_confirmations(panel, page, TASK)`;
   - `ledger = collect_ledger_export(panel, f"citizen-demo-{i}").steps` (a list of ledger-entry
     dicts).
3. Checks per run. All must be true for a clean run:

| Check | How |
|---|---|
| `done` | panel text contains "Done" |
| `submitted` | `page.url` ends with `submitted.html?...` **and** `#summary` text == `"Aadhaar ending 0124, mobile ending 3210, consent yes"` |
| `no_raw_values` | none of `234567890124`, `2345 6789 0124`, `9876543210`, `98765 43210`, `asha.verma@example.in`, `hunter2-correct-battery` appears in `json.dumps(entry["payload"])` for any ledger entry |
| `face_redacted` | some entry has a `payload.redactions[]` with `entity == "FACE"` and `payload.image is not None` |
| `navigations` | at least 2 entries have `payload.reason == "navigation"` |
| `confirmation` | `answered >= 1` |

4. Latency, per run and pooled across runs:
   - p50/p95 of `timings.observe|perceive|sanitize|guard|server|validate|act` over ledger
     entries;
   - p50/p95 of `serverTiming.model`;
   - task wall-clock (time around `run_task_answering_confirmations`).
5. Write `eval/reports/<YYYY-MM-DDTHHMMSSZ>-demo.json`:

```json
{ "date": "...", "task": "...", "gateway_mode": "live|record|replay", "model": "<from session open>",
  "browser": "<chromium version>", "machine": "<platform.node()>", "runs": [ { "checks": {...}, "clean": true, "wall_s": 0 } ],
  "latency_ms": { "observe": {"p50":0,"p95":0}, "...": {}, "server_model": {"p50":0,"p95":0} }, "n_steps": 0 }
```

6. Exit code 0 only if every run is clean.

CLI (`eval/src/aegis_eval/cli.py`): add a subcommand
`aegis-eval demo --runs 3 [--task primary|helpline]`. `helpline` runs B1 with its own checks: done,
and the summary or report contains `1800-11-4000`, plus `no_raw_values`.

`model` comes from `SessionCreated.model`, which the panel stores in `gatewayMode`'s neighbour
state. Read it with a new debug hook:
`window.__aegisLastSession = () => ({ model, mode })`, set in `handleStart` next to
`setGatewayMode(created.mode)`.

### 7. Record, then prove offline

```bash
# 1) Record against the live model until 3 consecutive clean runs
cd server/gateway
set -a; . ../deploy/model.env; set +a
AEGIS_MODE=record AEGIS_RECORD_DIR=../deploy/replay-store/demo AEGIS_TOKEN=dev-token \
  .venv/bin/uvicorn aegis_gateway.main:app --port 8787 &
cd ../../eval && .venv/bin/aegis-eval demo --runs 3          # repeat until exit code 0

# 2) Replay with no network for the gateway
podman build -f server/deploy/gateway.Dockerfile -t aegis-gateway:latest server
podman run --rm --network=none -p 8787:8000 \
  -e AEGIS_MODE=replay -e AEGIS_TOKEN=dev-token -e AEGIS_RECORD_DIR=/replay \
  -v "$PWD/server/deploy/replay-store/demo:/replay:ro,Z" aegis-gateway:latest
cd eval && .venv/bin/aegis-eval demo --runs 3                  # must exit 0
```

`--network=none` blocks the container's outbound traffic, and the `-p` port mapping still lets the
harness reach it. If the image's port or env names differ, take them from
`server/deploy/docker-compose.replay.yml`. Commit `server/deploy/replay-store/demo/*.json`.
They hold only sanitized plans (actions with descriptors), no page data.

Delete stale format-1 recordings (`*.json` without `"format": 2`) from any replay directory you
reuse; `lookup` ignores them.

## Tests

### Gateway (`server/gateway/tests/test_replay.py`)

- `test_canonical_key_ignores_client_timing_but_not_task_content`: keep it as is (still true).
- New `test_canonical_key_ignores_node_ids_boxes_and_image_bytes`: two bodies identical except
  node ids (`n-1`→`n-9x`), boxes, `image.data`, `image.sha256`, `coverage` → same key.
- New `test_canonical_key_changes_with_node_names_refs_or_step`: changing a node name, a
  redaction ref, or `step_id` changes the key.
- New `test_replay_remaps_descriptors_to_this_runs_ids`: record with nodes `n-1` (textbox
  "Username") and `n-2` (button "Sign in") and a plan clicking `n-2`. Look up with the same nodes
  renamed to `n-a`/`n-b` → the plan clicks `n-b`.
- New `test_replay_miss_when_a_target_descriptor_is_gone`: look up with the button renamed
  "Log in" → `None`.
- New `test_duplicate_role_name_is_disambiguated_by_order`: two buttons both named "Next"; the
  plan clicks the second; replay picks the second.
- `test_record_then_replay_serves_the_identical_plan_with_no_model_call`: still passes. The plan
  gains `plan_id: "p-1"` from normalization in both modes, so compare the two responses with each
  other, not with `fake_plan`. Change the first assertion to
  `assert record_res.json()["actions"] == fake_plan["actions"]`.
- New `test_record_stores_the_validated_plan_not_the_invalid_first_answer`: `complete` returns an
  invalid plan (unsent node) and then a valid one; record mode → exactly one file, and replaying
  it serves the valid plan with no retry. Count the lookups with a spy on `ReplayStore.lookup` →
  1.
- `test_is_loaded_reflects_whether_any_recording_exists`: its plan has no `node`; it still passes.

`test_server_timing.py`: add
`assert res.headers["access-control-expose-headers"] == "Server-Timing"`.

### Extension

- `ext/test/unit/gateway-client.spec.ts`:
  - `parseServerTiming('queue;dur=1.2, prompt;dur=0.3, model;dur=812.5')` →
    `{ queue: 1.2, prompt: 0.3, model: 812.5 }`;
  - `parseServerTiming(null)` → `{}`;
  - `sendStep` returns `{ plan, serverTiming }` from a `Response` carrying the header;
  - update the existing `sendStep` tests for the new return shape.
- `ext/test/unit/session.spec.ts`: with `takeServerTiming: () => ({ model: 812.5 })`, the ledger's
  latest entry has `serverTiming.model === 812.5`.

### Eval

- `eval/tests/test_gateway_mock.py` is unaffected.
- New `eval/tests/test_demo_checks.py`: unit-test the check functions of `demo.py` on hand-built
  ledger dicts. A ledger containing `asha.verma@example.in` in a payload → `no_raw_values` false.
  Two `reason: navigation` entries → `navigations` true.
- New `eval/tests/test_demo_flow_mock.py`: the citizen flow through the real built extension with
  R-5's `ScriptedGateway`. The script reads the request and picks nodes with `node_id(body, role,
  name)`:

| Step | Condition | Plan |
|---|---|---|
| 1 | `reason == "initial"` | click the link "Apply for a residence certificate" |
| 2 | `reason == "navigation"` and a node named "Aadhaar number" exists | type the AADHAAR ref into "Aadhaar number", the PHONE ref into "Mobile number", the EMAIL ref into "Email"; click the checkbox "I confirm these details are correct"; click "Submit application". The script remembers the refs from step 1's `body["redactions"]` (entity → ref) in its own closure. The vault numbers refs with one counter across entities, so never hard-code `#1`. |
| 3 | `reason == "navigation"` and a heading "Application submitted" exists | done |

  Assert every row of the §6 check table except the live-model ones. This runs in CI with no
  model.

## Acceptance

- [ ] `aegis-eval demo --runs 3` against the live R-1 model (record mode) exits 0: 3/3 clean,
  consecutive.
- [ ] Same command against the `--network=none` replay container exits 0.
- [ ] B1 (`--task helpline`) passes live once.
- [ ] B2 is chosen, run once live by hand, and noted (URL category only, no personal data) in
  `tasks.md`.
- [ ] `eval/reports/<date>-demo.json` is committed. Its latency table, with n, model, machine and
  date, is copied into `tasks.md` §1 as the new "Metric 5: latency (live model)" row.
- [ ] All gateway, extension and eval tests above pass.
- [ ] The Decision-log rows R6-replay-key-v2, R6-record-validated and R6-demo-task in `tasks.md`
  still match what was built. Update them if anything changed during implementation.
