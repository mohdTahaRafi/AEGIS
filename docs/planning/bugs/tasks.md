# AEGIS remediation tasks (R-0 … R-18)

**Created:** 2026-09-28 · **Owner:** team · **Status:** R-1 open (Groq free tier chosen, gateway reaches it; live n=10 check blocked by the daily token limit, see [R-1](R-1-vlm-endpoint.md)); R-2 gateway half and R-3 A1–A6 + A10 validation done for Groq; R-0 deferred by the team

This is the single task list for bringing AEGIS in line with problem statement 26171. It replaces
`remediation_plan.md` (the why and the order) and `remediation_implementation.md` (the how).

**The code is the source of truth.** The "Today" notes were checked against the source on
2026-09-28. Anything that needs a run to confirm is marked **[verify]**, with the command that
settles it. Paths are relative to the `AEGIS/` repo root. The old status docs (`CURRENT_BUILD.md`,
`context.md`, `DECISIONS.md`, `HISTORY.md`, `TASKS.md`) are retired. Decisions go in the
[Decision log](#decision-log) at the end of this file.

**Rules for every task:**
- Sanitize before any network call.
- Network code lives only in `apps/extension/src/host/egress/`.
- The vault stays in memory, and only the guard calls `normalizedValues()`.
- Fail closed: a crash, timeout or missing model gives grey pixels or a blocked request, never
  content.
- Nothing may send unsanitized data or weaken fail-closed behaviour.
- The team does all commits and pushes.

Tick a box only when its acceptance check passes.

---

## 1. Baseline (measured 2026-09-28)

| Area | Measured / observed | Source |
|---|---|---|
| Gateway tests | 69/69 pass | `pytest`, `server/gateway` |
| Extension tests (node project) | 560/560 pass (browser project not run) | `vitest run --project node` |
| Live model step via gateway | **3/3 failed, HTTP 503 after ~135 s**. Ollama's runner crashes on the strict `json_schema` grammar | live run, `llama3:8b-instruct`, Ollama 0.22.0, CPU only |
| Same prompt without schema | 200 after **132 s**, wrong shape (bare action, not a plan), bare ref `AADHAAR#2` | direct Ollama call |
| Sanitized image reaching the model | **Never.** The extension sends it, but `prompt/__init__.py` builds text-only messages | code |
| Model in use | `llama3:8b-instruct`, **text-only**. No vision model installed, no GPU (Intel Arc iGPU) | `ollama list`, `lspci` |
| Metric 1: visual context accuracy (25 %) | **Not measured** | `eval/reports/2026-09-27T100621Z-dev` |
| Metric 2: structured PII recall | macro 0.826 (Aadhaar/PAN/email/phone ≈ 1.0) | same report, n=166 |
| Metric 2: free-text recall | **PERSON_NAME 0/57, ADDRESS 0/10, USERNAME 0/5** | same report |
| Metric 2: visual recall | **0** (FACE/ID/QR/SIGNATURE fixtures are inline SVG, never analysed) | same report |
| Metric 3: pixel precision | 0.978, over-redaction on hard negatives 0.0 | same report |
| Metric 4: resources | 104.5 MB models; peak RSS 1158.6 MB (whole browser tree) | same report |
| Metric 5: latency | **guard p50 17.9 s / p95 26.3 s**; task wall-clock p50 19.7 s (mock server) | same report |
| Firefox | builds, never loaded | — |
| Uncommitted work | 57 modified + 30 new files since 2026-09-26 | `git status` |

---

## 2. Step overview

Priorities:
- **P0**: without it there is no working end-to-end demo.
- **P1**: output quality on real sites.
- **P2**: scoring evidence, compliance and submission.

| ID | Step | Pri | Metrics moved | Depends on |
|---|---|---|---|---|
| R-0 | Cleanup, commit, baseline | P0 | — | — |
| R-1 | Choose and stand up a vision-language model (VLM) | P0 | 1, 5 | R-0 |
| R-2 | Gateway: send the sanitized image to the VLM (+ API key) | P0 | 1 | R-1 |
| R-3 | Gateway: robust model output (schema, refs, envelope, deltas) | P0 | 1, 5 | R-2 |
| R-4 | Fix the guard's image rescan (halo check) | P0 | 1, 3, 5 | R-0 |
| R-5 | Keep the task alive across page navigation | P0 | 1, 5 | R-0 |
| R-6 | Demo task: live runs + recorded replay fallback | P0 | 1, 5 | R-2…R-5 |
| R-7 | Guard PATTERN hits: redact and continue | P1 | 2, 5 | R-4 |
| R-8 | Free-text PII: NER + name/address heuristics | P1 | 2, 3 | R-0 |
| R-9 | Vision coverage: full-frame faces, backgrounds, SVG | P1 | 2, 3 | R-4 |
| R-10 | Better image for the VLM: less grey, Set-of-Marks ids | P1 | 1 | R-2, R-4 |
| R-11 | Let the local ViT drive decisions | P1 | 1, 4 | R-10 |
| R-12 | `click_point` coordinate calibration | P1 | 1 | R-2 |
| R-13 | Metric 1: ground truth and measurement | P2 | 1 | R-6 |
| R-14 | Visual corpus with real images + image leak audit | P2 | 2, 3 | R-9 |
| R-15 | Unseen real-page evaluation | P2 | 1–5 | R-6…R-11 |
| R-16 | Firefox parity | P2 | PS compliance | R-6 |
| R-17 | Resource and latency pass | P2 | 4, 5 | R-4, R-8 |
| R-18 | Demo video, slides, rehearsal | P2 | — | all |

**Execution order:** R-0 → R-1 → … → R-18 in sequence. Once R-3 lands, R-4, R-5 and R-8 don't
block each other and can run in parallel if two people are working.

---

## 3. Bugs found in the code audit

Each bug is fixed inside the step named in the last column.

| # | Bug | Where | Effect | Fixed in |
|---|---|---|---|---|
| A1 | The gateway renders only the **delta** nodes/text of each step. The client sends deltas after step 1 (`session.ts` passes `graphMessage.nodes`), but `build_messages` renders `step_request["nodes"]` as the whole page, and the gateway `Session` keeps only node ids + affordances. From step 2 on, the model sees only what changed. | `server/gateway/src/aegis_gateway/prompt/__init__.py`, `sessions/store.py` | Metric 1; multi-step tasks | R-3 |
| A2 | The image rescan never looks at a halo. `session.ts` calls `client.rescan(bytes, boxes, [])`, and `worker.ts:handleRescan` then falls back to `halos = msg.redactionBoxes`. It OCRs **inside** the black boxes, where the compositor drew the white `⟪AADHAAR#n⟫`/`FACE` label. Any labelled box is a guaranteed hit → recompose → hit → dropped. | `host/session.ts`, `perception/worker.ts:handleRescan`, `perception/rescan/halo.ts` | The image almost never ships; guard latency | R-4 |
| A3 | Rescan boxes are CSS-pixel boxes applied to the **scaled** composed image (`scale = min(1, 1600/longSide)`). Crops are misplaced whenever `scale < 1`. | same | The wrong pixels are checked | R-4 |
| A4 | **[verify] Device-pixel-ratio mismatch.** `captureVisibleTab` returns device pixels and `captureTabAsBitmap` decodes it at native size. `cropRegion`, `compose` and `detectFaces` then index that bitmap with CSS-pixel boxes. On a `dpr = 2` screen, cleared regions copy pixels from the wrong place and redaction boxes land at half their true position. | `entrypoints/sidepanel/main.tsx:captureTabAsBitmap`, `perception/preprocess/crop.ts`, `perception/compose/compositor.ts` | Possible leak on HiDPI screens | R-4 |
| A5 | The replay key hashes the whole request, `image.data` included. Screenshot bytes differ on every run, so a recorded image step never replays. With `AEGIS_LOG_PAYLOADS=true` the base64 image is logged in full. | `replay/store.py`, `structured_log.py` | Offline demo fallback broken for image steps | R-2, R-6 |
| A6 | After a failed action or a refused rehydration, `actOnPlan` returns `'stopped'` and `stepLoop` returns with no `stopped` event and no state change. The panel stays "running" forever. | `host/session.ts:actOnPlan`, `stepLoop` | Task hangs silently | R-5 |
| A7 | The rehydration-failure path pushes `{ step_id: '' }` into `history`, but the schema requires `^s-[0-9]+$`. Once A6 is fixed, this would fail the guard's schema check on the next step. | `host/session.ts:actOnPlan` | Would block the step after a refusal | R-5 |
| A8 | `op: "stop"` is reported as `stopped: CANCELLED`, the user-cancel reason. | `host/session.ts:actOnPlan` | Misleading UI | R-5 |
| A9 | `ModelAdapter.convert_point` is never called; `click_point` coordinates reach the page untouched. | `model_client/adapters.py` | Coordinate calibration has no hook | R-12 |
| A10 | `decideEscalation` always gets `serverRequestedRegion: null`, so `request_observation` has no effect. The middle coverage band returns the same result as the high band. | `host/perception-client/run-step.ts`, `host/privacy/context/escalation.ts` | No on-demand image | R-10 |
| A11 | `pageCategory` is hard-coded `'unknown'`, and the CLIP screen label is only logged. | `entrypoints/sidepanel/main.tsx`, `run-step.ts` | R-11 has no input | R-11 |
| A12 | The session-create payload still says `policy: 'phase2-none'` and `capabilities: { l1_image: false, l2_crop: false }`. | `host/egress/gateway-client.ts` | Server can't tell image support | R-2 |
| A13 | Per-session rate-limit timestamps (`_recent_request_times`) are never deleted. | `api/routes_steps.py` | Slow memory leak | R-3 |
| A14 | `PerceptionClient.init` adds a `message` listener and never removes it. | `host/perception-client/client.ts` | Small leak per task | R-0 |
| A15 | Text-run clearance compares only the box origin (`b[0] === run.box[0] && b[1] === run.box[1]`). | `host/privacy/context/attach-image.ts` | A finding that doesn't start at the run's origin doesn't block clearing | R-8 |
| A16 | The vault mint origin and the capture target origin are fixed at task start (`guardOrigin`, `CaptureTarget.origin`). After a cross-origin navigation, values seen on B are minted under A's origin. | `host/session.ts`, `main.tsx` | Wrong origin binding | R-5 |
| A17 | The host builds each step from the graph **delta**. Graphs auto-sent between steps never reach the gateway; full graphs never prune `allSeenNodes`; perception, NER and the builder run on the delta, so unchanged regions go grey from step 2 on. | `host/session.ts`, `content/port.ts` | Stale or partial page context; mostly-grey images | R-3 |
| A18 | Declining a risky-action confirmation ends the loop with no `stopped` event; the panel stays "running". | `host/session.ts:actOnPlan` | Task hangs silently | R-5 |
| A19 | `ReconciliationTracker.resetForNewStep()` is never called, so the re-observation budget covers the whole task, not one step. | `host/session.ts`, `controller/reconcile.ts` | Spurious `BUDGET_EXHAUSTED` in long tasks | R-5 |
| A20 | Record mode stores the model's raw first answer (even an invalid one) instead of the validated plan. | `gw/api/routes_steps.py:_get_plan` | Replay serves the wrong plan | R-6 |
| A21 | `raise_for_status()` sits outside the `try`, so an upstream 4xx (401/402/429) or an HTTP-200 error body becomes an unhandled 500. | `gw/model_client/vllm.py` | Opaque 500s from hosted endpoints | R-3 |
| A22 | Node ids are random per session and the replay key hashes them, so replay can never match a real extension run. | `gw/replay/store.py` | Offline fallback never works | R-6 |
| A23 | After a navigation the prompt never shows refs minted on earlier pages, so a cross-page fill task can't be done. | `gw/prompt/__init__.py`, `gw/sessions/store.py` | Demo task impossible | R-6 |

---

## P0 — Make the end-to-end task work

Each P0 step has its own implementation file in this folder, with exact code, tests and
acceptance checks. **Where a file and the summary below differ, the file wins.** The files
supersede these points:
- the replay key moved from R-2 to R-6 (v2, id-free);
- R-3 sends a full snapshot every step instead of reconstructing deltas;
- `AEGIS_MODEL_PROVIDER` became `AEGIS_MODEL_RESPONSE_FORMAT` + `AEGIS_MODEL_CHAT_TEMPLATE_KWARGS`;
- R-4's budget is 1500 ms, and ring OCR covers every non-visual entity;
- R-0 keeps the Devanagari model spec (the manifest parity test requires it).

| Step | File |
|---|---|
| R-0 | [R-0-cleanup-and-baseline.md](R-0-cleanup-and-baseline.md) |
| R-1 | [R-1-vlm-endpoint.md](R-1-vlm-endpoint.md) |
| R-2 | [R-2-gateway-sends-image.md](R-2-gateway-sends-image.md) |
| R-3 | [R-3-robust-model-output.md](R-3-robust-model-output.md) |
| R-4 | [R-4-image-rescan.md](R-4-image-rescan.md) |
| R-5 | [R-5-navigation.md](R-5-navigation.md) |
| R-6 | [R-6-demo-task-and-replay.md](R-6-demo-task-and-replay.md) |

### R-0 — Cleanup, commit, baseline

**Why.** Two days of work are uncommitted. The `pii-ner.ts` header says `privacy-filter/` is
bundled, but it isn't in `public/models/`. `DEPLOYMENT.md` documents `AEGIS_MODEL_API_KEY`, which
isn't implemented, and Llama-2-70B, which is text-only. The code also carries unused files and
links to retired docs.

**Tasks — housekeeping**
- [ ] Add `tools/models/*.fp32.onnx` to `.gitignore`.
- [ ] Team commits the current work in logical commits: capture/grant flow, perception tuning,
  tests.
- [ ] Fix the `pii-ner.ts` header comment to match what is actually bundled.
- [ ] Fix `DEPLOYMENT.md`: API key status and model.
- [ ] Remove the `init` message-listener leak in `PerceptionClient.init` (A14): remove the listener
  once `ready`/`error` arrives.

**Tasks — remove unused code.** Confirm each with the search first; if it finds a real user, keep
the code.

| Candidate | Confirm with | Action |
|---|---|---|
| `apps/extension/src/perception/spike-protocol.ts` (Phase-0 probe/bench types; `worker.ts` no longer imports it) | `grep -rn "spike-protocol" apps/extension` | Delete it. If `test/unit/percentile.test.ts` imports types only, inline the one it needs, or delete the test if it only covers the spike helper. |
| `chunkForNer`, `PROFILE_S_LABEL_MAP` in `perception/models/pii-ner.ts` (self-described unused; the S map is wrong, `ORG → BANK_ACCOUNT`) | `grep -rn "chunkForNer\|PROFILE_S_LABEL_MAP" apps` | Delete both. R-8 writes the real profile-S mapping. |
| `export { compose, encodeWebp, type RedactionBoxSet }` at the end of `perception/worker.ts` | `grep -rn "from '.*perception/worker'" apps/extension` | Delete if only tests use it; point those tests at `compose/compositor`. |
| `OCR_REC_DEVANAGARI_MODEL_SPEC` passed to `init` (the worker only picks `script === 'latin'`) | `grep -rn "devanagari" apps/extension/src` | Stop passing the spec until script routing is wired (R-17). Keep the model file. |
| `legend.py` docstring ("Phase 2 never populates `redactions[]`") | read | Rewrite in R-2. |
| `gateway-client.ts` header comment ("Phase 2 has none of it running") | read | Rewrite with A12 in R-2. |
| Source comments pointing at `docs/HISTORY.md`, `docs/DECISIONS.md`, `docs/CURRENT_BUILD.md`, `phase_N_*.md` | `grep -rln "docs/\(HISTORY\|DECISIONS\|CURRENT_BUILD\)\|phase_[0-9]_" apps packages server eval tools` | Replace each with the one-line fact it pointed to, or delete the pointer. No whole-block rewrites. |
| `AEGIS/CLAUDE.md` "Working documents" table and "Commands → see CURRENT_BUILD.md". Docs live in `sih_project/docs/`, not `AEGIS/docs/`, so the links are broken already. | read | Point it at the requirement docs and this file, and paste the verified command list below. |

Leave these for the steps that own them:
- `haloAround`: rewritten in R-4.
- `IdentityCoordinateAdapter.convert_point`: wired in R-12.
- The `escalation.ts` middle branch: collapsed in R-10.
- Long narrative comments ("Real bug, found 2026-09-25 …"): shorten to the *why* in 1–3 lines when
  a step touches that file.

Keep `extensionOwnedNodeIds` in `validator.ts`. It is always empty, but it is a tested hard-denial
path and costs nothing.

**Tasks — baseline**
- [ ] Run the full suite, browser project included: `pnpm -r test`, gateway `pytest`, `eval`
  `pytest`.
- [ ] Re-run `aegis-eval run --split dev` and keep the report as the **R-baseline**. Every later
  step compares against it.

Commands (verify once, then put in `CLAUDE.md`):

```bash
pnpm install
pnpm -r typecheck
pnpm -r test                                     # vitest: node + browser projects
pnpm lint                                        # boundaries + no-network scan
pnpm --filter @aegis/protocol generate           # schema → TS + Pydantic (never hand-edit output)
pnpm --filter @aegis/extension build             # chrome-mv3
pnpm --filter @aegis/extension build:firefox     # firefox-mv3
cd server/gateway && .venv/bin/python -m pytest -q
cd eval && .venv/bin/python -m pytest -q && .venv/bin/aegis-eval run --split dev
python3 tools/vlm/smoke.py --runs 5 --json-out tools/vlm/reports/<date>.json
```

**Acceptance.**
- `git status` is clean.
- All suites are green, with the same test counts before and after cleanup (minus deleted tests,
  listed), and any failure listed.
- The comments and the remaining docs match the code.
- A dated baseline report exists.

---

### R-1 — Choose and stand up a VLM

> **Superseded by [R-1-vlm-endpoint.md](R-1-vlm-endpoint.md) (2026-09-28).** Constraint: Groq's
> free tier only. Chosen: `qwen/qwen3.8-27b` on `https://api.groq.com/openai/v1`, the only image
> model Groq serves; offline fallback is replay. The model table and vLLM/Ollama tasks below are
> kept for history only.

**Why.** The problem statement asks for a centralized **LLM/VLM that interprets the sanitized
visual context**. The only local model is text-only, and on this CPU an 8B model takes ~130 s per
step.

**Today.**
- `config.py` has `AEGIS_MODEL_URL` (default `http://localhost:8000/v1`), `AEGIS_MODEL_NAME`
  (default `qwen3-vl-8b-instruct`) and `AEGIS_MODEL_TIMEOUT_S` (default **20 s**). There is no API
  key and no provider switch.
- `tools/vlm/smoke.py` already measures:
  - text, and vision (a code word visible only in the pixels);
  - grounding (the raw point convention);
  - `chat_template_kwargs` vs OpenRouter `reasoning`;
  - structured output: json_schema, json_object, and whether the schema is enforced;
  - streamed first-token and total latency for the real system prompt + one 1280×720 WebP.
- `smoke.py`'s default target (`qwen/qwen3.8-27b:free` on OpenRouter) differs from the gateway's
  default model.

**Model choice to record:**

| Use | Model (open weights) | Where |
|---|---|---|
| Demo / finale | Qwen2.5-VL-7B-Instruct (recommended: known image support + xgrammar structured output) or Qwen3-VL-8B-Instruct | Cloud GPU running vLLM (e.g. one 24 GB GPU), or a hosted OpenAI-compatible endpoint with the same weights. The PS allows cloud-hosted versions during SIH. |
| Development | `qwen2.5vl:3b` in Ollama (confirm the tag with `ollama pull`) | Team laptops. Slow on CPU, so use it for correctness only, not latency. |
| Offline fallback | Replay store (`AEGIS_MODE=replay`) recorded from the demo model | Demo laptop |

**Tasks**
- [ ] Start the demo endpoint. vLLM:
  `vllm serve Qwen/Qwen2.5-VL-7B-Instruct --max-model-len 16384 --limit-mm-per-prompt '{"image":1}' --served-model-name qwen2.5-vl-7b`
  (check the `--limit-mm-per-prompt` syntax against `vllm serve --help`; it changed between
  versions). Image input and structured output must be on.
- [ ] Start the dev endpoint: `ollama pull qwen2.5vl:3b`, base `http://localhost:11434/v1`.
- [ ] Change `smoke.py`'s `DEFAULT_BASE_URL`/`DEFAULT_MODEL` to the chosen demo endpoint, so that
  with no env set it measures the same model the gateway calls. It already reads
  `AEGIS_MODEL_URL`/`AEGIS_MODEL_NAME`/`AEGIS_MODEL_API_KEY` first.
- [ ] Add `server/deploy/model.env.example` with the three variables for each row (demo / dev /
  offline replay). No secrets.
- [ ] Run `python3 tools/vlm/smoke.py --runs 10 --json-out tools/vlm/reports/r1-<date>.json` against
  each endpoint. Keep the reports in the repo; they contain no key and no image bytes.
- [ ] Set the default `AEGIS_MODEL_TIMEOUT_S` to the measured p95 total × 1.5. At 20 s, every CPU
  call becomes `MODEL_TIMEOUT`.
- [ ] Record the choice in the Decision log (`R1-model`).

**Acceptance.** One documented endpoint: URL, model, and how it's started. The demo endpoint's
report shows:
- `text.pass` and `vision.pass`;
- the raw grounding values;
- whether `json_schema` is enforced;
- first-token and total latency p50/p95, with n, hardware, model and date.

---

### R-2 — Gateway: send the sanitized image to the VLM

**Why.** `prompt/__init__.py:build_messages` returns `list[dict[str, str]]`, text only.
`step_request["image"]` is used only for `click_point` bookkeeping, so the image the extension
redacted and guarded is thrown away and the model never sees the screen. Nothing new is sent by
this step: the gateway only ever receives the guarded image, because guard step 5 runs client-side
before egress. We just stop discarding it.

**Today.**
- `legend.py:render_legend` renders `ref | entity | class`, with no boxes.
- `vllm.py:VLLMClient.complete` sends no `Authorization` header and no `max_tokens`, and always uses
  strict `json_schema`.
- Replay key and payload logging bug: A5. Stale capabilities: A12.

**Tasks**
- [ ] **Config** (`config.py`): add to `Settings` / `load_settings()`:
  ```python
  model_api_key: str | None      # AEGIS_MODEL_API_KEY; field(repr=False); never logged
  model_provider: Literal["vllm", "ollama", "openai_compat"]   # AEGIS_MODEL_PROVIDER, default "vllm"
  model_vision: bool             # AEGIS_MODEL_VISION, default True (a text-only model degrades cleanly)
  model_max_tokens: int          # AEGIS_MODEL_MAX_TOKENS, default 512 (a plan can't be truncated)
  ```
  Validate `model_provider` the same way `mode` is validated.
- [ ] **Prompt** (`prompt/__init__.py`):
  ```python
  def build_messages(step_request: dict, *, vision: bool) -> list[dict[str, object]]:
      text = build_user_message(step_request, with_image=vision and bool(step_request.get("image")))
      image = step_request.get("image") if vision else None
      user_content: str | list[dict] = text
      if image:
          user_content = [
              {"type": "text", "text": text},
              {"type": "image_url", "image_url": {"url": f"data:{image['format']};base64,{image['data']}"}},
          ]
      return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_content}]
  ```
  When an image is attached, `build_user_message` appends:
  ```
  IMAGE: level=L1 region=[0,0,1280,720] scale=1 coverage cleared=0.62 redacted=0.04 unanalysed=0.34
  LEGEND: <image.legend>
  ```
  The coverage line tells the model that grey means "not analysed". Without an image, or with
  vision off, the text must stay **byte-identical to today**: prefix caching and existing replay
  entries depend on it. Keep the name `build_user_message`, because `smoke.py` imports it.
- [ ] **Legend** (`prompt/legend.py`): `render_legend(redactions, *, with_boxes=False)`. With boxes:
  `⟪AADHAAR#2⟫ | AADHAAR | CRITICAL | [220,418,340,40]` (first box, `:g` format). Boxes are only
  rendered when an image is attached, so the model can link a black box to its placeholder. Rewrite
  the stale docstring.
- [ ] **Client** (`model_client/vllm.py`): type messages as `list[dict[str, object]]`; send
  `Authorization: Bearer <key>` when a key is set; send `max_tokens`.
- [ ] **Replay key** (`replay/store.py:canonical_key`), fixes A5:
  - drop `client_timing`;
  - from `image`, keep only `level`, `region`, `scale` (drop `data`, `sha256`, `legend`);
  - drop `coverage`, whose floats vary run to run.

  Decision `R2-replay-key`: the sha256 changes on every capture, so using it would make replay miss
  exactly the steps the offline demo needs.
- [ ] **Logging**: `log_payload` replaces `image.data` with `f"<{len(data)} b64 chars>"`. The API
  key never appears in any `log_event` field.
- [ ] **Route** (`api/routes_steps.py`): `build_messages(step_dict, vision=settings.model_vision)`.
- [ ] **Client capabilities** (`apps/extension/src/host/egress/gateway-client.ts`), fixes A12:
  - send the real policy id (`defaultPolicy.id`) and `capabilities.l1_image: true`;
  - send the backend from the worker's `ready` message when known;
  - rewrite the stale header comment.

  This is metadata only, no page data.

**Tests** (`server/gateway/tests/`)
- [ ] `test_prompt_image.py`:
  - image + vision on → 2 content parts, a `data:image/webp;base64,` URL, and an `IMAGE:` line;
  - no image → `content` is a `str` equal to a golden pre-change string;
  - vision off with an image → `str` with no `IMAGE:` line.
- [ ] `test_legend.py`: boxes appear only with `with_boxes=True`.
- [ ] `test_replay_key.py`:
  - requests differing only in `image.data`/`sha256`/`coverage`/`client_timing` → same key;
  - a different node name → a different key.
- [ ] `test_model_client.py` (httpx `MockTransport`):
  - `Authorization` present only when a key is set;
  - `max_tokens` is sent;
  - logs contain no base64 image and no key (`caplog`).

**Acceptance.** A live step against the R-1 model returns a plan based on something visible only
in the image. Fixture: "click the green button under the red banner", where that button's
accessible name is empty (same image as `smoke.py`). The extension's payload is unchanged by this
step.

---

### R-3 — Gateway: robust model output

**Why** (verified live):
- Ollama crashes on the strict `json_schema` grammar, so every step gets a 503.
- Without a grammar, the model returns a bare action instead of `{step_id, actions}`.
- `prompt/system.py:11` tells the model to write `"ref":"AADHAAR#1"` **without** ⟪⟫, but
  `action-plan.schema.json` and the Pydantic model only accept `^⟪[A-Z_]+#[0-9]+⟫$`. Any model that
  follows the prompt is rejected.
- Any 5xx becomes `model_unavailable()` with a fixed message, so a runner crash and an unreachable
  server look identical.
- The model is asked for `step_id` and the server never overrides it; the client rejects a mismatch
  as `LEASE_EXPIRED`.
- Bugs A1 (the model sees deltas only) and A13 (rate-limit leak).

**Tasks**
- [ ] **Normalizer** — new file `model_client/normalize.py`. It runs in `routes_steps._get_plan` on
  every plan, both fresh from the model and loaded from replay (it is idempotent). It runs
  **before** Pydantic validation and before `record`:
  ```python
  BARE_REF = re.compile(r"^[A-Z_]+#[0-9]+$")
  TOP_LEVEL_KEYS = {"actions", "risk_hint", "stop_if", "note"}

  def normalize_plan(raw: object, step_id: str) -> dict:
      if isinstance(raw, list):
          raw = {"actions": raw}
      elif isinstance(raw, dict) and "op" in raw:
          raw = {"actions": [raw]}
      if not isinstance(raw, dict):
          raise PlanShapeError("model output is not an object or list")
      plan = {k: v for k, v in raw.items() if k in TOP_LEVEL_KEYS}
      plan["step_id"] = step_id                       # server-owned
      plan["plan_id"] = f"p-{step_id[2:]}"            # server-owned, deterministic (replay-stable)
      for action in plan.get("actions") or []:
          if isinstance(action, dict) and isinstance(action.get("ref"), str) and BARE_REF.match(action["ref"]):
              action["ref"] = f"⟪{action['ref']}⟫"
      return plan
  ```
  It never invents node ids or refs; post-validation still rejects unknown ones. `PlanShapeError`
  goes through the existing one-retry path, then `PLAN_INVALID`.
- [ ] **Model-facing schema** (`vllm.py`): `load_model_facing_schema()` = a deep copy of
  `load_action_plan_schema()` with:
  - every inlined `placeholderRef` pattern replaced by `^[A-Z_]+#[0-9]+$`;
  - `step_id` and `plan_id` removed from `properties` and `required`.

  The grammar then agrees with the prompt and costs fewer tokens. The wire schema keeps ⟪⟫.
- [ ] **Provider switch** (`vllm.py`; rename the class to `ModelClient` and keep a `VLLMClient`
  alias until callers move):
  - `vllm` → `{"type":"json_schema","json_schema":{"name":"action_plan","schema":<model-facing>,"strict":true}}`;
  - `ollama` / `openai_compat` → `{"type":"json_object"}`, then normalize → validate → one retry;
  - `chat_template_kwargs` only for `vllm`, since other servers may reject unknown keys.
- [ ] **Error mapping** (`errors.py`): `model_unavailable(reason)`, with the message
  `Model unavailable: <reason>`, reason ∈ `unreachable | upstream_5xx | upstream_4xx | bad_body`.
  - Log `log_event("model_error", status=…, error_class=…, provider=…)`, with no body text (it can
    echo the prompt).
  - A malformed envelope (missing `choices[0]…`) → `bad_body`, not a bare `KeyError` 500.
- [ ] **Retry message**: send the "Your previous output was invalid: …" note as a `user` message,
  not a trailing `system` message. Some chat templates reject a non-leading system message.
- [ ] **Delta reconstruction (A1)** — the biggest context-accuracy fix:
  - `Session` gains `nodes_by_id: dict[str, dict]` and `text_by_id: dict[str, dict]`.
  - `apply_step_context`: if `delta_of is None`, clear both maps and `sent_node_ids` (a full
    snapshot; R-5 sends this after a navigation). Then upsert `nodes`/`text` and delete `removed`.
  - `build_messages` renders `session.nodes_by_id.values()` (the current page), flagging nodes
    that are new or changed this step with `| new`.
  - The replay key stays on the request delta, which is deterministic on a deterministic page.
  - **[verify]** whether text runs are deltas too: `grep -n "textRuns" apps/extension/src/content`.
    If they are sent in full each step, only nodes need the map.
- [ ] **Prompt size**: `render_elements(nodes, viewport, limit)` puts interactive nodes (non-empty
  `affordances`) first, then orders by distance from the viewport centre, capped at
  `AEGIS_PROMPT_MAX_ELEMENTS` (default 150). Log the rendered count and a token estimate
  (`len(text) // 4`) in `step_processed`, and measure tokens before and after.
- [ ] **A13**: delete `_recent_request_times[session_id]` in the session DELETE route and in
  `sweep_expired`.

**Tests**
- [ ] `test_normalize.py`:
  - a bare ref is wrapped, and an already-wrapped ref is untouched;
  - a top-level action and a top-level list are both wrapped into `actions`;
  - unknown keys are dropped;
  - the model's `step_id: "step_1"` is overwritten;
  - normalizing twice gives the same result.
- [ ] `test_model_facing_schema.py`: no `⟪` in the model schema; `step_id` is not required; the
  protocol schema is unchanged.
- [ ] `test_provider_switch.py`: the right `response_format` per provider; `chat_template_kwargs`
  only for vllm.
- [ ] `test_delta_prompt.py`: step 1 sends 3 nodes; step 2's delta adds 1 and removes 1 → the prompt
  lists the 3 current nodes with the new one flagged. `delta_of: null` resets the map.
- [ ] `test_errors.py`: a 500 with a body → 503 `MODEL_UNAVAILABLE` with `upstream_5xx`; a connect
  error → `unreachable`.

**Acceptance.** 10/10 live steps on the login fixture return a valid plan, with no 503 and no
`PLAN_INVALID`. Record p50/p95 model time from `Server-Timing`.

---

### R-4 — Fix the guard's image rescan (halo check)

**Why.** The OCR check flags **any** readable text, including the labels our own compositor draws
inside redaction boxes (`⟪AADHAAR#2⟫`, `FACE`) and neighbouring field labels such as "Aadhaar
number". Each one counts as a hit: the image is recomposed with boxes 50 % larger, hits again, and
is **dropped**. OCR detection also runs separately per halo, twice, which accounts for most of the
**17.9 s guard p50**. Bugs A2, A3, A4.

**Today.**
- `host/session.ts`: `imageRescanDeps.rescan = (bytes, boxes) => client.rescan(bytes, boxes, [])`.
- `worker.ts:handleRescan`: runs the full-frame face re-check, then
  `checkHalosForText(ort, models, image, msg.halos.length ? msg.halos : msg.redactionBoxes)`.
- `halo.ts:checkHalosForText`: per box, crop → `detectText` → `recognizeLine` per line; any
  non-blank text is a hit.
- `image-rescan.ts:runImageRescan`: one recompose at +50 %, then drop. There is no deadline.

**Tasks**
- [ ] **Device pixel ratio first (A4) [verify].**
  - Log `bitmap.width / viewport.w` in `runPerceptionStep` on a HiDPI screen, or with Chrome
    `--force-device-scale-factor=2`.
  - If it is ≠ 1, normalise once at decode in `captureTabAsBitmap` (pass the viewport in):
    `createImageBitmap(blob, { resizeWidth: viewport.w, resizeHeight: viewport.h, resizeQuality: 'high' })`.
    Every downstream box then stays in CSS pixels.
  - Add a browser test at scale factor 2: a redaction box lands on its field (pixel probe), and a
    cleared region's pixels match the page.
- [ ] **Protocol** (`shared/worker-protocol.ts`): the rescan message becomes
  ```ts
  | { t: 'rescan'; jobId: string; image: ArrayBuffer; scale: number;
      textBoxes: Box[];      // placeholder-bearing redactions (CSS px) — get halo OCR
      allBoxes: Box[];       // every redaction box — masked before OCR
      deadlineMs: number }
  ```
  `rescanned` returns `{ faces: Box[]; ringText: { box: Box; text: string }[]; timedOut: boolean }`.
  Recognised text goes to the host guard but stays on the device: the worker has no vault access,
  and the text is never put in a payload or a log.
- [ ] **Worker ring OCR** (rewrite `perception/rescan/halo.ts` as `ringOcr`):
  1. Decode the WebP and scale every box by `scale` (A3).
  2. Fill every redaction box (`allBoxes`, +1 px) with solid black on a working copy, so drawn
     labels can't be read.
  3. Build 24 px halo rings (`haloAround`, scaled) around `textBoxes` only.
  4. Run `detectText` **once** on the whole working image.
  5. Recognise only the lines that intersect a ring.
  6. Check `performance.now()` between lines; at `deadlineMs`, return `timedOut: true`.
- [ ] **What counts as a hit** (`host/privacy/guard/image-rescan.ts`). A text hit counts only if:
  - `findAll(text)` returns a `valid` match whose entity class is ≥ HIGH, **or**
  - the text shares ≥ 4 consecutive normalised characters with a `vault.normalizedValues()` entry.

  Confirm that `apps/extension/scripts/vault-boundary-check.ts` allows the whole `guard/` folder,
  not only `guard.ts`. Face boxes from the full-frame re-check are always hits, as today.
- [ ] **Scope**: only redactions with a `ref` (text entities) get ring OCR. FACE, ID_DOCUMENT,
  QR_CODE and SIGNATURE fills rely on the face re-check.
- [ ] **Deadline**: `GuardDeps.rescanDeadlineMs` (default 800). On timeout, drop the image (fail
  closed).
- [ ] **Outcome reporting**:
  - add `GuardDeps.onImageOutcome('clean' | 'recomposed' | 'dropped' | 'timeout' | 'no-rescan')`;
  - the session records it in the ledger (`perception.imageOutcome`, e.g. `rescan-timeout`) and
    emits it with the `perception` event.
- [ ] **UI (T-7.25)**: `ui/PerceptionStatus.tsx` shows "image withheld by guard: <reason>" for
  `dropped`/`timeout`.

**Tests**
- [ ] Unit (`image-rescan.spec.ts`):
  - text that is only our label → clean;
  - text matching a vault value → hit;
  - a valid Aadhaar → hit;
  - the words "Aadhaar number" → clean;
  - timeout → dropped, with outcome `timeout`.
- [ ] Browser (rework `halo-rescan.spec.ts`):
  - label inside a box → `clean`;
  - a digit tail 3 px outside a box → `recomposed` or `dropped`;
  - an adjacent field label → `clean`;
  - a `scale = 0.5` image → hits land on the right pixels.
- [ ] AC-7 (killed worker) still yields no image.

**Acceptance** (dev split vs the R-baseline):
- guard p50 < 500 ms (target, then measured);
- image-dropped rate on form fixtures < 10 %;
- leak count unchanged or lower;
- the adversarial digit-tail fixture never ships the tail.

---

### R-5 — Keep the task alive across page navigation

**Why.** A form submit or redirect loads a new document. The content port disconnects and
`session.ts` stops with `PAGE_DISCONNECTED` (T-7.23), yet most real tasks cross at least one page.
A cross-origin navigation also withdraws Chrome's `activeTab` grant. Bugs A6, A7, A8 and A16.

**Today.**
- `main.tsx` wires `onDisconnect → session.onContentDisconnected()`. That rejects pending waits with
  `PageDisconnectedError`, and `start()` then stops with `PAGE_DISCONNECTED`.
- `host/content-connection.ts:connectToLiveContent` already handles connect → wait for `ready` →
  inject → retry.
- `guardOrigin`, `pageTitle` and `CaptureTarget.origin` are fixed at task start.

**Tasks**
- [ ] **Reconnect dependency**: add
  `SessionDeps.reconnect?: () => Promise<{ port: ContentPortClient; origin: string; title: string } | null>`.
  `main.tsx` implements it:
  1. Wait for `tabs.onUpdated` with `tabId === target.tabId && status === 'complete'` (timeout
     15 s). Resolve at once if `tabs.get` already says `complete`.
  2. Call `ensureHostPermission` for the new origin. Permission prompts need a user gesture, so if
     it can't be granted, return `null` with a reason the panel shows.
  3. Call `connectToLiveContent(tabId, …)`.
  4. Build a new `ContentPortClient` wired to the same session handlers.
  5. Update `target.origin`; make `target` a mutable object that the gated capture reads.
- [ ] **Session state**: use a replaceable `this.contentPort` instead of `this.deps.contentPort`.
  - A disconnect **after an executed action** in this step (`actedThisStep`) sets
    `navigationPending = true` instead of stopping.
  - That action's pending promise resolves as `{ ok: true, navigated: true }`, because a click that
    navigates never gets its action-result back.
- [ ] **Loop**: if `navigationPending` at the top of an iteration, call `reconnect()`. `null` →
  `stop('PAGE_DISCONNECTED')`. Otherwise reset:
  - clear `allSeenNodes`, set `lastGraphMessage = null`, call `digestGuard.reset()`;
  - set `deltaOf = null`, which resets the gateway's node map (R-3);
  - add history `{ step_id, actions, outcome: 'navigated' }`;
  - send the next request with `reason: 'navigation'`.

  Old node ids are invalid after this reset.
- [ ] **Schema**: add `"navigation"` to `sanitized-context.schema.json#/properties/reason/enum`,
  regenerate (`pnpm --filter @aegis/protocol generate`), and update the gateway's HISTORY rendering
  if needed.
- [ ] **Origin (A16)**:
  - `Session.originKey` becomes mutable and is set from `next.origin`, so new values are minted
    under the new origin. The vault's strict rule still refuses to type a value seen on A into B.
  - Update `pageTitle` from `next.title`.
  - The grant gate's message names the new origin: "the page moved to X, click AEGIS to continue
    with screenshots".
- [ ] **When to stop**: only when the tab closes (`tabs.onRemoved`), reconnect times out, or the
  user cancels.
- [ ] **A6**: after a failed dispatch or refused rehydration, `ReconciliationTracker.decide(false)`
  either stops via `this.stop(reason)` or **continues the loop** with `reason: 'reconcile'` (a fresh
  observation). Remove the second, unconditional `return 'stopped'`.
- [ ] **A7**: the history entry for a refused rehydration uses the current `stepId`, not `''`.
- [ ] **A8**: `op: 'stop'` emits `{ type: 'stopped', reason: 'MODEL_STOPPED' }` (add the reason to
  `SessionEvent`) and moves the controller to `STOPPED`.

**Tests** (`test/unit/session.spec.ts`, with fakes)
- [ ] Disconnect after a click → reconnect is called → the next payload has `reason: 'navigation'`,
  `delta_of: null`, and history `navigated`.
- [ ] Reconnect returns `null` → `stopped: PAGE_DISCONNECTED`.
- [ ] Disconnect with no action in flight → stops (unchanged).
- [ ] After an origin change, new values are minted under the new origin; rehydrating an old ref on
  the new origin → `ORIGIN_MISMATCH`.
- [ ] Failed dispatch → next step has `reason: 'reconcile'`; a budget breach → a `stopped` event.
- [ ] `op: stop` → `stopped: MODEL_STOPPED`.
- [ ] E2E: login → submit → dashboard on the same origin completes.
- [ ] E2E: the same flow cross-origin pauses for a grant, then completes.

**Acceptance.** Both e2e flows pass and the unit tests cover the new state transitions.

---

### R-6 — Demo task: live runs + recorded replay

**Why.** The PS requires "an end-to-end task assisting the user", and AC-1 / T-7.8 have not started.
Today `apps/extension/test/fixtures/demo-login.html` and `test/e2e/demo-fixture.spec.ts` cover a
single-page login only. `Server-Timing` is set by the gateway but not read by the client.

**Tasks**
- [ ] Primary demo task on a synthetic "citizen services" fixture: *"Fill the application form
  using my details shown on the profile page and submit it."* It must exercise:
  - the image: the profile photo is a face that gets redacted;
  - placeholders: Aadhaar, phone, name;
  - a password field that is never read;
  - a navigation (R-5);
  - a confirmation for a risky action.
- [ ] Build the fixture set `apps/extension/test/fixtures/citizen/`, served by the eval fixture
  server. All values are synthetic, from the corpus generator.
  - `profile.html`: name, Verhoeff-valid Aadhaar, phone, face photo as `<img>`, password field.
  - `apply.html`: name, Aadhaar, phone, consent checkbox, submit.
  - `submitted.html`: same origin.
- [ ] Two backup tasks:
  - a real public page, e.g. a government portal's search or login page, stopping before any real
    submission;
  - a read-only task: "find the helpline number on this page".
- [ ] **Server-Timing**: `egress/client.ts` returns `{ body, serverTiming }` from `sendStep`. Store it
  on the ledger entry and show `server.model` in the step timeline.
- [ ] **Replay fallback**: if the exact key misses, `ReplayStore.lookup` tries a structural key,
  `sha256(task, step index, sorted [(role, name) of nodes], sorted refs)`, recorded alongside. Log
  which tier hit: `replay_hit=exact|structural|miss`.
- [ ] Record with `AEGIS_MODE=record` against the R-1 demo endpoint until there are **3 consecutive
  clean runs**. Keep the replay store under `server/deploy/replay-store/demo/`.
- [ ] Offline check: run with `podman run --network=none` and `AEGIS_MODE=replay`
  (`docker-compose.replay.yml`).
- [ ] Capture per-stage latency (observe/perceive/sanitize/guard/server/act p50/p95) for each run.

**Tests**
- [ ] Structural replay fallback unit test.
- [ ] E2E: the citizen flow against `eval/runner/gateway_mock.py`, extended with a scripted
  3-step plan.

**Acceptance.**
- 3/3 clean live runs.
- Replay works with the network off (AC-1, AC-4).
- A latency table with n, hardware, model and date is saved as
  `eval/reports/<date>-demo-latency.json`.

---

## P1 — Output quality on real websites

### R-7 — Guard PATTERN hits: redact and continue

**Why.** `guard/sweeps.ts:patternResweep` returns the first valid match, and `guard()` throws
`GuardBlockedError('PATTERN')`. The whole step stops, even though the guard already knows exactly
which string is sensitive. The builder misses what the guard catches because the builder applies
policy **score thresholds**, while the guard blocks on `valid` alone. A checksum-valid Aadhaar with
no surrounding context can score below the threshold.

**Tasks**
- [ ] `patternResweep(...) → PatternHit[]`, with `PatternHit = { entity; value }` (the normalised
  matched text). `guard()` throws `GuardBlockedError('PATTERN', entity, hits)`. The `hits` stay on
  the error object in host memory, never in a log or event.
- [ ] Add `BuildContextInput.forcedValues?: { entity; value }[]`. For each forced value, the builder
  scans every free-text source and every read field value with `normalizedContains`, and emits a
  candidate `{ source: 'guard:<entity>', score: 1, span | nodeId }`. Add `'guard'` to the host
  `Channel` union only if fusion needs to tell it apart.
- [ ] `session.ts` catches `PATTERN` **once per step**, then:
  1. rebuilds the context with `forcedValues`, which mints placeholders and seals them in the vault;
  2. re-attaches the image and runs the guard again;
  3. if that second pass blocks for any reason, stops exactly as today.
- [ ] The ledger records `guardRemediated: { entity, count }`, and `RedactionSummary` shows it.
- [ ] AC-6 test (`test/e2e/privacy.spec.ts`, `guard.spec.ts`): assert the raw value is absent from
  the sent bytes **and** that remediation was logged. Record decision `R7-AC6`.

**Acceptance.**
- A fixture with an Aadhaar in a tooltip or `title` attribute proceeds with `⟪AADHAAR#n⟫` instead
  of stopping.
- The leak count doesn't rise.
- A unit test proves remediation is capped at one pass per step.

---

### R-8 — Free-text PII: NER + heuristics

**Why.** NER profile S is a no-op (`classifyProfileS` returns `[]`). Profile L
(`openai/privacy-filter` q4, ~900 MB, WebGPU-only) isn't bundled. Measured recall is 0 for names,
addresses and usernames. Worse, text containing a name counts as "fully analysed, no finding", so
it is **cleared into the outbound image** as well as sent in the JSON (see also A15). On real sites
("Welcome, Rahul Sharma") this is the most visible leak.

**Tasks**
- [ ] **Heuristic recognizers** (`packages/recognizers/src/heuristics/`, pure TS, one `Recognizer`
  per file):
  - `label-value.ts`: `^(Full name|Name|Father's name|Mother's name|Husband's name|Account holder|Nominee)\s*[:\-]\s*(.+)$` → PERSON_NAME on group 2; `Address|Residential address` → ADDRESS.
  - `greeting.ts`: `\b(Welcome|Hi|Hello|Logged in as|Signed in as)[,\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})`.
  - `honorific.ts`: `\b(Shri|Smt|Kumari|Mr|Mrs|Ms|Dr)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})`.
  - `address.ts`: a 6-digit PIN (reuse `pinRecognizer`) within 80 chars after an address keyword
    (flat, house no, road, marg, nagar, sector, colony, district, taluk) → the span from the
    keyword's line start to the PIN. Also multi-line blocks ending in a PIN.
  - `username.ts`: `@[A-Za-z0-9_.]{3,}` (not inside an email), and
    `(User ID|Username)\s*[:\-]\s*(\S+)`.

  Base score 0.75 and `valid: true`; entity classes come from the policy.
- [ ] Register the heuristics in a new `HEURISTIC_RECOGNIZERS` list, **not** in `ALL_RECOGNIZERS`,
  so the guard doesn't start blocking on names. In `builder.ts:candidatesFromTextRun`, call
  `findAll(text, undefined, [...ALL_RECOGNIZERS, ...HEURISTIC_RECOGNIZERS])`.
- [ ] **Profile S model** (pretrained only, no fine-tuning, constraint C-5): run it through the same
  transformers.js pipeline profile L uses, on WASM:
  `pipeline('token-classification', '<dir>', { dtype: 'q8', device: 'wasm' })`.
  - Candidates: `Xenova/bert-base-NER` and `Xenova/distilbert-base-multilingual-cased-ner-hrl`, both
    int8/q8. Confirm size and licence before bundling.
  - Tag mapping: `PER → PERSON_NAME`. `LOC → ADDRESS` only when the span also passes the address
    keyword test, because a bare city is not an address. Drop `ORG` and `MISC`.
  - Generalise `worker.ts:getNerPipeline` to take the profile's `{ dir, dtype, device }`.
  - Add the model to `models.manifest.json` with its sha256, and its licence to `NOTICE`.
  - Evaluate both candidates on the dev split and keep the better precision/recall per MB.
- [ ] **Clearance (A15)**: in `attach-image.ts:toClearanceCandidates`, a run has a finding if any
  redaction box *intersects* it (use the existing `intersects`), not just when origins match. A
  node whose name carries a placeholder (`/⟪[A-Z_]+(#\d+)?⟫/`) is not cleared either.
- [ ] **Budget**: send NER only the sources whose text changed since the last step (keep a
  `Map<key, text>` in `Session`). Batch them into one `ner` message, cap at 4 000 chars per step,
  and lazy-load profile S on the first call.

**Tests**
- [ ] One unit test per heuristic, including hard negatives. Decide and document the expected
  result for "Name your price", "Hello World" and "Dr. Pepper".
- [ ] A builder test: "Welcome, Rahul Sharma" → `Welcome, ⟪PERSON_NAME#1⟫`.
- [ ] A pixel test: the name's run is black in the composed image, not cleared.
- [ ] Record NER latency p95.

**Acceptance** (targets until measured):
- PERSON_NAME and ADDRESS recall ≥ 0.80 and precision ≥ 0.90 on dev;
- no new false positives on the 28 hard negatives;
- NER p95 < 300 ms per step on WASM.

---

### R-9 — Vision coverage: full-frame faces, backgrounds, SVG

**Why.** Vision only looks at `IMG`/`CANVAS`/`VIDEO` (`selection.ts:MEDIA_TAGS`; `roles.ts` maps them
to `'img'`). Avatars drawn with CSS `background-image`, inline SVG, `role="img"`, and cross-origin
iframes are never analysed. They stay grey, which is safe, but faces in them are never recognised,
so no real "blurred face" appears and the context is lost. Faces are detected per crop only.

**Tasks**
- [ ] **Full-frame face pass** (`worker.ts:handlePerceive`): on every capture, after the crop loop,
  run YuNet once on the downscaled full frame. Merge with the crop faces at IoU ≥ 0.3, keeping the
  higher score. This catches faces anywhere, including cross-origin iframes the content script
  can't see. Full-frame faces have no `regionId`; they become node-less vision candidates and still
  get FACE fills.
- [ ] **More candidates** (`selection.ts`), each at least 32×32:
  - inline `SVG`, `[role=img]`, `OBJECT`, `EMBED`;
  - any element whose computed `background-image` contains `url(`.

  Reuse the single `getComputedStyle` call. `roles.ts` routes them to `'img'` and carries `tagName`
  (`'BG'` for background images), and `builder.ts:unexplainedReason` maps `SVG → 'svg-text'`,
  `OBJECT/EMBED → 'embed'`, `BG → 'img'`.
- [ ] **Face rendering** (`compositor.ts`): the irreversible solid fill + `FACE` label stays the
  default. Add a mosaic step first (blocks ≥ 1/8 of face width), so the demo shows the "blurred
  face" the PS names. Recommendation: send the fill only and show the mosaic in the panel preview.
  Record decision `R9-face-render`.
- [ ] **Fusion (T-7.21)**: when an OCR `AADHAAR` hit lies inside a CLIP `ID_DOCUMENT` region, keep
  **both**: the typed placeholder for the number and the ID_DOCUMENT fill for the card. Find the
  merge rule with `grep -n "ID_DOCUMENT" apps/extension/src/host/privacy/fusion`.

**Tests**
- [ ] Selection unit tests (jsdom), one per new candidate type.
- [ ] Browser test: a CSS-background avatar → FACE fill.
- [ ] Compositor pixel test for the mosaic and the fill.

**Acceptance.** On the R-14 corpus, FACE recall ≥ 0.90 and ID_DOCUMENT recall ≥ 0.80 (targets). On
a real page with a CSS-background avatar, the face is filled and labelled.

---

### R-10 — Better image for the VLM

**Why.** The image is grey by default and only sent when DOM coverage < 0.7. When it is sent, large
areas are grey, and the model has to guess which pixels belong to which node id. `request_observation`
does nothing today (A10). Clearance has rules 1–3 only (`clearance.ts`).

**Tasks**
- [ ] **When to attach an image.** `escalation.ts` inputs become `{ explainedFraction,
  firstStepOnPage, serverRequest, screenMode }`. Attach L1:
  - on the first step of every page (including after an R-5 navigation);
  - when the previous plan contained `request_observation`;
  - when `screenMode === 'visual'` (R-11).

  Otherwise L0, to save latency. Remove the duplicate middle branch.
- [ ] **Server requests.** When a plan contains `request_observation`, `session.ts` remembers
  `{ level, region }` and passes it to the next `runPerceptionStep` (L2 = crop to `region`).
  `attach-image.ts` then sets `image.level`/`image.region`; today both are hard-coded to L1 and the
  full viewport.
- [ ] **Clearance rule 4, "uniform tile".** The worker computes the pixel variance of each 32×32
  tile and returns tiles below a threshold (e.g. σ < 2 on 0–255) as `uniformTiles: Box[]` in
  `perceived`. `computeClearedBoxes` adds them. A uniform tile carries no information, so this
  stays fail-closed.
- [ ] **Set-of-Marks.** In `compositor.ts`, after the redaction boxes, draw each interactive node's
  opaque id (`n-81`) as a small tag at its box's top-left. The nodes are passed to `compose` as
  `marks: {id, box}[]`. A tag must never cover a cleared region outside its node box. The ids are
  already in the JSON and contain no PII; tags let the VLM ground "click n-81" visually.
- [ ] Add one line to `prompt/system.py`: "Small `n-xx` tags in the image mark element ids." This
  changes the system prompt bytes once.
- [ ] Measure the grey fraction on 10 real pages before and after (target < 25 %).

**Tests**
- [ ] Escalation table test.
- [ ] Rule-4 unit test.
- [ ] Compositor tag pixel test.
- [ ] Update the gateway prompt golden string.

**Acceptance.** The grey fraction before and after is recorded, and R-13 task success improves over
the R-6 baseline, reported with n.

---

### R-11 — Let the local ViT drive decisions

**Why.** The PS says the local vision model "reads the user's screen and takes decision based on
that". Today `screenLabel()` returns the top-1 of the 20 *region* labels over the full frame, and
it ends up only in the ledger. Every decision comes from DOM coverage, and `pageCategory` is
`'unknown'` (A11).

**Tasks**
- [ ] **Screen vocabulary.** Add `SCREEN_VOCABULARY = ['login page', 'payment or checkout page',
  'form', 'email inbox', 'document or PDF viewer', 'ID document or scan', 'profile or account page',
  'search results', 'dashboard or table', 'error page', 'CAPTCHA']`.
  - Extend `tools/models/export_vit_prompts.py` to write a second label block, and bump the magic to
    `AEGISVPB2`.
  - Regenerate `vit-prompts.bin`, and update its sha256 in `models.manifest.json` and in the
    `main.tsx` spec.
- [ ] **Policy as data.** Add to the policy schema and `default.policy.json`:
  ```json
  "screenPolicies": {
    "payment or checkout page": "strict", "ID document or scan": "strict",
    "document or PDF viewer": "visual", "dashboard or table": "visual",
    "login page": "normal", "*": "normal"
  },
  "screenLabelMinScore": 0.5
  ```
  Add an accessor `screenMode(policy, label, score)`.
- [ ] **Modes**, read in `run-step.ts` before `decideEscalation`:
  - `strict`: no image unless the server asks; policy thresholds × 0.8; confirmation on every action.
  - `visual`: always L1.
  - `login` → L0 plus protected fields; `normal` → the R-10 rules.

  The label comes from the **previous** capture on the same page; the first step on a page uses
  `normal`.
- [ ] **Non-sensitive hint to the server** via `page.category`: payment → `banking`, email inbox →
  `email`, document viewer → `docs`, else `unknown`.
- [ ] Ledger and panel line: "screen: payment page (0.82) → strict".

**Tests**
- [ ] Accessor unit tests.
- [ ] Session tests showing each mode changes behaviour: no image, always an image, confirmation.

**Acceptance.** Screen-label accuracy on the R-13 labelled set is reported with n, and each mode is
verified in one real-page run.

---

### R-12 — `click_point` coordinate calibration

**Why.** `IdentityCoordinateAdapter` assumes the model outputs CSS pixels, and `convert_point` is
never called (A9). VL models differ: Qwen2.5-VL is thought to report absolute pixels on its resized
input, and Qwen3-VL a 0–1000 relative grid. Confirm both by measurement. **R-1 measurement
(2026-09-28, Groq `qwen/qwen3.8-27b`, `smoke.py --grounding-grid` + trials):** landscape
1280×720: 24/24 points on 5 targets were 0–1000 of the **longer image side** on both axes (per-axis
rel1000 0/24, pixels 0/24; linear fit scale 1277/1275, residual ≤ 4 px). Portrait 720×1280: **0/4
under every convention** (x ≈ per-axis, y inconsistent, residual 484 px). Add `rel1000_long`
(`x_css = region.x + x/1000 · max(region.w, region.h)`, same for y) for landscape. Decide portrait:
pad captures to landscape/square and re-measure, or refuse `click_point` on portrait regions. The client dispatches
`click_point` at the raw x/y (`dispatch.ts:dispatchClickPoint`); server post-validation only checks
that the point lies in a recent image region.

**Tasks**
- [ ] **Calibration**: add `--grounding-grid` to `tools/vlm/smoke.py`.
  1. Draw a 1280×720 image with a 4×3 grid of coloured targets that have no accessible names.
  2. Ask for each target in turn.
  3. Fit `x_css = a·x_model + b` per axis by least squares, for three hypotheses: image pixels at
     the sent scale, 0–1000 relative, and model-resized pixels (Qwen2.5-VL rounds to multiples
     of 28).
  4. Keep the hypothesis with the lowest error.
- [ ] Implement the winner as a `ModelAdapter`, selected by
  `AEGIS_MODEL_COORDS = css | image_px | rel1000 | resized_px`.
  `convert_point(x, y, image_region, image_scale)` returns viewport CSS pixels:
  - `image_px`: `x_css = region.x + x_img / scale`;
  - `rel1000`: `x_css = region.x + x/1000 · region.w`.
- [ ] Call it in `routes_steps.py` after normalization, for each `click_point`. Use the session's
  last image region, and store `scale` alongside it in `recent_image_regions`.

**Tests**
- [ ] Adapter unit tests, one per convention.
- [ ] Post-validation still rejects points outside the image.

**Acceptance.** ≥ 90 % of calibration clicks land inside their target, with the median error
reported in px.

---

## P2 — Scoring evidence, compliance, submission

### R-13 — Metric 1: ground truth and measurement (25 % of the score)

**Today.** `eval/src/aegis_eval/scorers/metric1.py` has `score_primary`,
`score_element_agreement` and `score_screen_label_accuracy` as pure functions, but nothing feeds
them.

**Tasks**
- [ ] Create `eval/labels/screen.schema.json`: `{ screen_label, elements: [{role, name, box}], task:
  { text, expected_actions: [{op, target_role, target_name}] } }`.
- [ ] Label 30–50 dev screens with this schema.
- [ ] **Primary reading**: task success with sanitized context ÷ task success with raw context, same
  tasks, same model.
  - The raw arm uses synthetic fixtures only, never real PII, through a **harness-only** gateway
    endpoint fed from the fixture's ground truth. The extension is never changed to send raw data.
  - Success = the executed actions match `expected_actions` (op + target role/name), plus a final
    `done`.
- [ ] **Secondary reading**:
  - element agreement (IoU ≥ 0.5 plus a role/name match) between the ledger's sent nodes and
    `elements`;
  - screen-label accuracy against `screen_label`.
- [ ] Add metric 1 to the scoreboard writer.

**Acceptance.** Metric 1 is reported with n, model, hardware and date, with failure cases listed.

### R-14 — Visual corpus with real images + image leak audit

**Tasks**
- [ ] In `eval/src/aegis_eval/corpus/generate_fixtures.py`, replace the inline-SVG placeholders in
  the face, ID, QR and signature fixtures with real `<img>` assets under `eval/corpus/assets/`:
  - public-domain portraits (e.g. Wikimedia Commons), with each licence recorded in
    `eval/corpus/assets/LICENSES.md`;
  - synthetic ID cards rendered by the generator;
  - QR codes from a generator (`qrcode` lib);
  - signatures rendered from handwriting-style fonts.
- [ ] Add CSS-background and SVG variants for R-9.
- [ ] Implement `eval/src/aegis_eval/auditor/ocr.py`:
  - run PP-OCR via `rapidocr-onnxruntime` over the sent image, and feed the text to the auditor's
    recognizers and canary check;
  - run YuNet on the sent image; a face outside a FACE fill is a leak.

**Acceptance.** Visual recall and precision are non-zero and reported, and the leak count covers both
JSON and pixels.

### R-15 — Unseen real-page evaluation (T-7.5)

This is the closest thing to the finale's unseen use cases.

**Tasks**
- [ ] Pick 15–20 public pages never used for tuning:
  - government portals and bank login pages;
  - an email demo;
  - Wikipedia biographies with photos;
  - e-commerce checkouts, up to but not including any payment.
- [ ] Write `eval/src/aegis_eval/realpages.py`. For each page it runs a read-only task ("describe
  what this page is for") and saves the ledger export, the sent image, the perception status and
  per-stage timings. It stops before any submission or payment.
- [ ] Review each page by hand in a CSV: detections, false positives, misses.
- [ ] Report whether the image was sent or dropped, the grey fraction, and per-step latency.

### R-16 — Firefox parity

**Tasks**
- [ ] Run `pnpm --filter @aegis/extension build:firefox` and load it in `/usr/bin/firefox` via
  `about:debugging`.
- [ ] Verify the sidebar opens (`background.ts` Firefox branch: `action.onClicked →
  sidebarAction.toggle()`).
- [ ] Verify the content script injects. MV3 host permissions are opt-in on Firefox, so
  `ensureHostPermission` must run from a user gesture.
- [ ] Verify `captureVisibleTab` works after host access is granted. Firefox needs `<all_urls>` or
  host permission, not `activeTab` alone, so adjust `grant-gate.ts`'s explanation text per browser.
- [ ] Verify the WASM models load single-threaded (no cross-origin isolation in extension pages).
- [ ] Run the R-6 demo task and fix each difference, adding a test per fix.

**Acceptance.** The demo task completes on Firefox (AC-12), with latency and RSS recorded.

### R-17 — Resource and latency pass

Justify every change with a before/after number (T-5.14).

**Tasks**
- [ ] Metric 4: filter the `eval/runner` process sampling to the extension's own processes (by the
  `--extension-process` cmdline flag / task-manager ids), not the whole browser tree.
- [ ] Lazy-load CLIP and OCR, and release idle sessions (OCR, NER) after 60 s via
  `ModelRegistry.evict`.
- [ ] T-7.20: fixed-shape OCR buckets, so WebGPU can be tried for OCR detection.
- [ ] Script routing: pass `document.documentElement.lang` into `perceive`/`rescan`, and pick the
  Devanagari recognizer for `hi`/`mr`/….
- [ ] Evaluate MobileCLIP-S0 as a lighter screen/region encoder. Adopt it only if R-13/R-14 accuracy
  holds.

**Acceptance.** A before/after table of RSS, CPU and per-stage latency on the reference laptop.

### R-18 — Demo video, slides, rehearsal (T-7.8 … T-7.13)

**Tasks**
- [ ] Record a team-narrated video. The requirements (DR-6) rule out AI narration.
- [ ] Make six slides with the measured metrics, each with n, hardware, model and date.
- [ ] Rehearse in airplane mode using the R-6 replay store.
- [ ] Configure a second laptop identically.
- [ ] Do a full AC-1 … AC-12 pass.
- [ ] Update `docs/demo/demo-script.md` and `judge-qa.md` with the final numbers.

---

## Follow-ups from the 2026-10-25 cleanup

- [ ] **CLEAN-1** `tools/e2e/release_smoke.py` still assumes Groq (the "add your Groq API key" card,
  `ALLOWED_HOSTS = {"127.0.0.1", "api.groq.com"}`), but Gemini is now the default provider. Make it
  pick the provider explicitly, or drive the Gemini path, and show it in a visible run.
- [ ] **CLEAN-2** `node_modules` was found partly wiped (32 packages in `.pnpm`); `pnpm install`, then
  `pnpm lint && pnpm -r typecheck && pnpm -r test` to confirm the cleanup on a full toolchain.
- [ ] **CLEAN-3** The Python workspace packages are not installed in any venv (`aegis_eval`,
  `aegis_gateway` import only with `PYTHONPATH`); `uv sync` at the repo root.
- [ ] **CLEAN-4** `ruff check` reports 536 findings (502 `E501` long lines) and CI does not run ruff.
  Either add it to CI with the current baseline fixed, or drop `E501` from the selected rules.

## Definition of done

- [ ] The demo task completes live 3/3 times on Chrome and on Firefox. The sanitized image reaches
  a VLM, and the replay fallback is verified offline.
- [ ] All five metrics plus the leak count are reported with n, hardware, model and date. None is
  "not measured".
- [ ] On the unseen real-page set:
  - zero raw PII in JSON or pixels, per the auditor;
  - images dropped on < 10 % of steps;
  - p50 step latency recorded against the model's own latency.
- [ ] Every audit bug A1–A23 is fixed, each with a test.
- [ ] The Decision log below is up to date.

---

## Follow-ups from 2026-11-03 (task survives closing the panel)

- [x] **PERSIST-1** Closing the side panel lost the running task and its log. The panel now saves the
  task, run log, state and sanitized HISTORY to `storage.session` per window
  (`src/host/saved-task.ts`); reopened, it shows them again, and a task cut off mid-run gets an
  "Interrupted" card with Resume (continues on its tab, next step id, earlier HISTORY given to the
  model with sealed refs reduced to their type) and Dismiss. Unit tests: `saved-task.spec.ts`,
  `session.spec.ts` ("resuming a task…"). Visible run 2026-11-03: `probe_site.py
  https://en.wikipedia.org/wiki/Main_Page "Search Wikipedia for Alan Turing, open his article and tell
  me the year he was born" --watch --byok --provider gemini --close-panel-at-step 2`: panel closed
  during step 2, reopened showing step 1 and "Interrupted", Resume sent s-2 with s-1 in HISTORY,
  Done ("born in 1912"). n=1, Chromium (Playwright), Gemini Flash-Lite fallback chain, WASM.
- [x] **PERSIST-5** A prompt typed in the task box (not yet run) was lost when the panel closed. The
  draft is now saved to `storage.session` per window on every change and restored on reopen
  (`saveDraft` / `loadDraft` in `src/host/saved-task.ts`; `TaskInput` takes `value` /
  `onValueChange`). Tests: `saved-task.spec.ts`, `ui.spec.tsx`. Visible check 2026-11-03 (Chromium
  via Playwright, dev build, scratch script, no model call): typed "Find the population of India
  and the year of the last census" into the panel beside en.wikipedia.org, closed the panel tab,
  reopened it in the same window: the box showed the same text.
- [x] **UI-1** The panel showed "AEGIS" twice: Chrome's side-panel bar (not removable by an extension)
  and the panel's own logo/name header. The panel header now has only the state pill and Settings.
  Settings had `maxWidth: 480` and stayed narrow in a wide panel; it now fills the panel, and the
  per-type redaction list is a grid that adds columns as the panel widens. Visible check 2026-11-03
  (Chromium via Playwright, panel page in a window at 500 and 800 px): Settings 500/756 px wide,
  redaction list 2/3 columns.
- [ ] **PERSIST-2** The task still stops when the panel closes. Keeping it running needs the agent
  out of the panel (Chrome offscreen document with tabs/capture/scripting proxied through the
  service worker; Firefox background page) — see decision `PERSIST-RESUME`.
- [ ] **PERSIST-3** Saves are throttled to one per 400 ms and the last one on `pagehide` may not land,
  so the restored log can be one step behind (seen in the run above: closed in step 2, restored at
  step 1). Resume is still correct (it re-observes); a resumed run's setup notes land under the last
  restored step.
- [ ] **PERSIST-4** Same visible run, original panel, before the close: step s-2 on the Alan Turing
  article was held back by the guard with `SCHEMA` (nothing sent; the next step went fine). Not caused
  by this change (non-resumed path); find which field fails the schema on that page.

## Follow-ups from 2026-11-03 (situational prompt)

- [x] **PROMPT-SIT-1** On Codeforces the agent submitted a wrong answer, then asked the user for
  "the corrected C++ code" (`NEEDS_USER`). The prompt now adds per-step situation rules
  (`src/host/agent/situations.ts`): `failed_result`, `stuck`, `produce`, `code`, `lasting`,
  `compare`, `answer`; the last three moved out of the system prompt. `ask_user` is narrowed to
  what only the user can supply. A failed result goes to the smart model. Tests:
  `agent-situations.spec.ts`. Visible runs 2026-11-03 on codeforces.com/problemset/problem/2278/A,
  "Write a C++ solution … give me the code in a report. Do not submit it." (`--watch --byok
  --provider gemini`, Gemini fell back to 3.5 Flash-Lite after 429s on the stronger models, WASM):
  both runs Done in ~20 s with the model writing the code itself (n=2). Run 1's code was wrong (it
  sorted the letters and compared to "six"); after adding "trace every sample in notes", run 2's
  logic was right but its includes read `#iostream` (as the model wrote them, not mangled by AEGIS).
- [ ] **PROMPT-SIT-2** Not yet shown on a live submission: `failed_result` (read the verdict, fix,
  resubmit) and the `code` editor rules. Needs the product owner's go-ahead to submit from their
  Codeforces account (CLAUDE.md rule 8 allows read/search/navigate only).
- [ ] **PROMPT-SIT-3** Correctness of written code is bounded by the model: on Gemini's free tier
  the stronger models' daily quota runs out and Flash-Lite answers. Consider routing `produce` /
  `code` steps to the smart tier, or telling the user when a weaker model is answering such a task.
- [ ] **PROMPT-SIT-4** The Python gateway (dev only) still builds the old prompt without situations.

## Decision log

Add one row per decision.

| Date | Id | Decision | Why |
|---|---|---|---|
| 2026-09-28 | R2-replay-key | ~~The replay key ignores image bytes, coverage and timing.~~ Superseded by R6-replay-key-v2. | Excluding image bytes alone isn't enough: node ids are random per session (A22). |
| 2026-09-28 | R3-full-snapshot | The extension sends the full current node set every step (`delta_of: null`); the gateway replaces its page view and flags new/changed nodes itself. | The host-side delta was wrong three ways (A17); the model needs the whole page anyway. |
| 2026-09-28 | R3-response-format | Output format is `AEGIS_MODEL_RESPONSE_FORMAT = json_schema \| json_object \| none`; `chat_template_kwargs` only when `AEGIS_MODEL_CHAT_TEMPLATE_KWARGS=true`. | These two behaviours are what differ between endpoints, not the vendor. |
| 2026-09-28 | R3-reason | The host decides `reason` (initial / after_action / reconcile / navigation). | The content script's reason only says which trigger sent a graph. |
| 2026-09-28 | R4-pixel-space | Captures are resized to CSS-pixel viewport size once, right after capture. | Every box downstream is CSS pixels (A4). |
| 2026-09-28 | R4-rescan-rules | Ring OCR covers every non-visual redaction; a text hit is a valid HIGH+ pattern or ≥ 4 characters shared with a sealed value; step 5 has a 1500 ms budget, and an unfinished check drops the image. | Our own labels and field labels must not count as leaks; fail closed. |
| 2026-09-28 | R5-navigation | A disconnect after an action dispatched since the last requested graph is a navigation: wait up to 15 s for load, reconnect, `reason: navigation`. | Real tasks cross pages. |
| 2026-09-28 | R5-origin | After navigation the origin key, title and capture target become the new page's; the vault is kept and old-origin refs are refused. | The strict origin rule stays; no value crosses origins. |
| 2026-09-28 | R5-stop-reasons | The model's `stop` → `MODEL_STOPPED`; a declined confirmation = user cancel; a failed action re-observes (per-step budget). | Every step ends in a visible state (A6, A8, A18, A19). |
| 2026-09-28 | R6-replay-key-v2 | The replay key and stored plans use node descriptors `role\|name\|occurrence`, never ids; replay needs the same window size. | Ids are random per session (A22). |
| 2026-09-28 | R6-record-validated | Record mode stores the validated plan under the first-attempt key. | Replay must serve what the live run executed (A20). |
| 2026-09-28 | R6-demo-task | Citizen-services task on three same-origin pages (Aadhaar, phone, email, face photo, prefilled password); no person name until R-8. | Exercises image, placeholders, rehydration, navigation and confirmation with current detectors. |
| 2026-09-28 | R3-ref-form | The model writes bare refs (`AADHAAR#1`); the gateway wraps them before validation. The wire schema keeps ⟪⟫. | Fewer tokens and no unusual Unicode for the model; one contract on the wire. |
| 2026-09-28 | R3-server-ids | `step_id`/`plan_id` are set by the server and removed from the model-facing schema. | The model can't get them wrong. |
| 2026-09-28 | R1-model | Server model: `qwen/qwen3.8-27b` on Groq's free tier (`https://api.groq.com/openai/v1`), thinking off via `reasoning_effort: "none"`; offline fallback replay; no paid API, no GPU. Measured 2026-09-28 from the team laptop on Wi-Fi: latency n=10/10, TTFT p50 1.40 s / p95 17.23 s, total p50 1.60 s / p95 17.47 s; vision WebP 11/14 exact, PNG 6/6; grounding landscape 24/24 in 0–1000 of the longer side, portrait 0/4; `json_object` works, strict json_schema rejected (400); `chat_template_kwargs` rejected (400); 429s routine at 8K TPM; 200K TPD **per organization** (~80 image steps/day), exhausted on 2026-09-28 by the probe runs. Gateway → Groq live: image-only pick 2/3, R-3 text check 1/10 (TPD). Reports: tools/vlm/reports/r1-2026-09-28-groq*.json | Team constraint: free tier only. It is the only image-input model Groq serves (docs + live `/models`). Preview status, throttling, no enforced schema and portrait grounding are open risks for the team to accept; replay covers outages. |
| 2026-09-28 | R1-groq-inputs | For Groq: R-3 default `AEGIS_MODEL_RESPONSE_FORMAT=json_object` and `AEGIS_MODEL_CHAT_TEMPLATE_KWARGS=false`; R-12 adds the longer-side 0–1000 convention for landscape and must decide portrait; gateway timeout stays 30 s (1.5 × p95 = 26.2 s). | Measured HTTP 400s on strict json_schema and `chat_template_kwargs`; measured grounding on both orientations. |
| 2026-09-28 | R1-retry | The gateway retries a model call at most once (`AEGIS_MODEL_MAX_RETRIES=1`), only for a 429 with `retry-after` ≤ 10 s (`AEGIS_MODEL_RETRY_MAX_WAIT_S`) or a dropped connection; never after a timeout. Otherwise `503 MODEL_UNAVAILABLE <reason>` with `Retry-After` passed through, shown in the panel. | Free-tier 429s are routine; waiting what Groq asks is free, retrying sooner earns more 429s, and a long wait must not hang the panel. |
| 2026-09-29 | E2E-1 | First verified real end-to-end run on `AEGIS/demo/signin.html` ("Enter the username and click Sign in."): real Chromium + `chrome-mv3-dev` + gateway `AEGIS_MODE=live` + Groq `qwen/qwen3.8-27b`; plan `type ⟪USERNAME#2⟫ → click → done`, 4,660 prompt tokens, model 1.3 s; page reached "Signed in as …"; network audit of every gateway request: 0 raw values. Driver: `tools/e2e/run_demo.py`. | Acceptance of the P0 flow. |
| 2026-09-29 | E2E-fixes | Fixed on the way: label-bound text semantics (`<dt>/<dd>`, `<th>/<td>`, `Label:`) seal values by type and propagate to every string; grouped Indian mobiles (`98765 43210`); container boxes no longer black out whole regions (tightest box per ref); compositor filled every box after the first label white; ring-OCR rescan masks all boxes and asks the guard whether ring text is sensitive (A2, A3); full snapshot every step (A1/A17); failed action re-observes, `MODEL_STOPPED`, `USER_DECLINED`, history step ids (A6-A8, A18); client step timeout + one retry for retryable errors; gateway: `UNSANITIZED_CONTEXT` tripwire before the model, lease released on a failed model call, full-snapshot node reset, non-JSON answers get the corrective retry, `reasoning_effort` setting, click_point grounded with the measured long-side 0–1000 convention (`AEGIS_MODEL_POINT_FORMAT`), `readyz` checks the key, A12, A13. | Blockers found by running the real flow. |
| 2026-09-29 | REAL-SITES-1 | Arbitrary-site readiness, found by probing real pages through the real extension + gateway (`tools/e2e/probe_site.py`, scripted upstream `tools/e2e/fake_vlm.py`): guard re-sweep now honours class thresholds like the builder (a bare date blocked every Wikipedia page as DOB); captures resized to CSS px (A4, HiDPI/zoom); iframes/embeds/objects routed to vision (cross-origin content was copied into cleared regions unscreened); same-tab navigation re-attaches and continues (R-5 core: settle-or-disconnect wait, reconnect without prompting, origin/title follow the page); `ask_user` → `NEEDS_USER`; prompt caps 100 elements / 30 visible runs; image long side 1280; Groq TPM-aware retry windows (gateway 30 s, client 45 s, step deadline 150 s); "Send a redacted screenshot every step" setting (default on); panel Activity list and zoomable sent image; specific gateway-session errors. Verified: Wikipedia, GitHub login, httpbin form, DuckDuckGo (type → click → navigate → done). Runbook: `AEGIS/demo/MANUAL_TEST.md`. | User manual testing on random sites. |
| 2026-09-29 | PSP-1 | Passport Seva manual run (`MODEL_STOPPED: cannot_proceed`, only PASSWORD redacted, "vision ran, found nothing") traced through the live gateway log: Groq itself returned `stop` — it saw five UNNAMED textboxes (React Native Web: no label/aria on any input) and no username value. Fixes: (1) an input with no accessible name is named by its visual caption (`visualCaption`, the same association `field-semantics.ts` already used for classification); (2) CSS `background-image` leaves are `img` nodes, so RNW pictures (real `<img>` at opacity 0) reach YuNet/CLIP/OCR — crops 0/0 → 6/6, unanalysed 71% → 24%; (3) panel lists label-protected fields incl. empty ones (`protectedFieldsOf`); synthetic non-pattern values in Full Name/Email ID/Login ID are sealed as PERSON_NAME/EMAIL/USERNAME placeholders (probe audit: 0 leaks); (4) `stop.detail` in the protocol so the model says why; gateway normalises a free-text stop reason instead of rejecting; (5) corrective retry no longer resends the image (it drew HTTP 413 on the 8K/min tier); `plan_retry` logs failing field paths; (6) Activity shows each operation validated → executed/failed/declined/not run, with sanitized names; (7) exact-pixel per-crop vision cache (unchanged image: perception 658 → 74 ms); (8) extension waits out Groq's per-minute 429 (≤ 65 s) and says so. Live-verified: Passport Seva `type "test-user" → Login ID` + `done` executed on the real site; demo `type ⟪USERNAME#2⟫ → click → done`, 0 leaks, ≈2.5 s/step (perceive 673, sanitize 127, guard 457, server 1,210 ms). Grounding (`rel1000_long_side`) hit both targets at 1280×800, 1920×1080 (scale 0.667), 600×1000, 390×844@2x, zoom 1.5. | `apps/extension/src/content/{detect/field-semantics,screen-graph/{extractor,roles,selection}}.ts`, `src/host/session.ts`, `src/perception/{worker,region-cache}.ts`, `src/ui/{ActivityLog,RedactionSummary,PerceptionStatus,ResourceBar}.tsx`, `packages/protocol/schema/action-plan.schema.json`, `server/gateway/src/aegis_gateway/{api/routes_steps,model_client/normalize,prompt/system}.py`, `tools/e2e/{probe_site,fake_vlm}.py`, `demo/{signin.html,MANUAL_TEST.md}` |
| 2026-09-29 | PSP-2 | Empty label-sensitive fields (Passport Seva Full Name / Email ID / Login ID) were classified by label but their field box was CLEARED in the image: `builder.ts` `candidatesFromDomSignal` returns no candidate for an empty value-readable field (nothing to seal — kept), so no redaction, so `attach-image.ts` clearance treated the box as analysed-and-clean and copied its pixels. JSON was always safe; the pixels relied on `.value === ''` at DOM-read time matching a later capture (autofill preview, a fill between read and capture). Fix: `maskedFields` — every label-sensitive field without a redaction is drawn black `"<TYPE> field"`, not added to `redactions[]` (model still types into it; live-verified). Measured on the real page (stand-in model): empty → masked; pattern values → sources `dom:*` (+`pattern:email`); non-pattern values → `dom:*` only; 0 leaks. Also found live: a task-supplied value typed into such a field was sealed in the field but not in the task → guard `VAULT_LEAK` blocked step 2; field values of label-sensitive fields now join the seal-everywhere list (case-insensitive, like the guard). | `apps/extension/src/host/privacy/context/{attach-image,builder}.ts`, `src/host/session.ts`, `src/ui/RedactionSummary.tsx`, tests `attach-image`, `protected-fields`, `label-semantics` |
| 2026-09-29 | GMAIL-1 | Manual Gmail run failed with `MODEL_UNAVAILABLE upstream_4xx` (gateway log: upstream HTTP 413, twice). Groq's 413 body for this key (probe, no page data): `type=tokens code=rate_limit_exceeded`, "input tokens per minute (ITPM): Limit 7000" — one request over 7K input tokens is refused outright (earlier Gmail step: 92 nodes = 5,754 tokens; Passport Seva step 2: 6,681). The gateway called every 4xx retryable, so the extension re-sent the same oversized step. Fixed: `vllm.py` classifies upstream errors (429 → retryable with Retry-After; 5xx/unreachable → retryable; 401/403 → `upstream_auth`, 413 → `ModelRequestTooLarge`, other 4xx → `upstream_4xx (<status> <code>)`, all non-retryable, HTTP 502) logging only `[a-z_]` type/code and the limit/requested integers; the route rebuilds a 413'd prompt with `fit` = 0.85·limit/requested of the element/text caps (max 2 rebuilds; a 413 costs no quota); `model_request` log = sizes only; extension `gateway-client.ts` shows the detail. Live check: Gmail sign-in page (headless, logged out) typed and executed; the inbox 413 path is covered by tests only (needs a login). Found: `type` appends by default (`clear_first` unset), so a redundant re-type doubled the value and the guard blocked step 3 with VAULT_LEAK (fail-closed, nothing sent) — open. | |
| 2026-09-29 | JSON-1 | Passport Seva registration, task "explain me what is this form about…": `MODEL_UNAVAILABLE upstream_4xx (400 json_validate_failed)`. Isolated with direct Groq calls (same model, image, response format; request rebuilt via `probe_site.py` on the stub gateway, 10,211 vs 10,308 prompt chars): model+image+json_object 200; +reasoning_effort none +max_tokens 300 200; +system prompt 200; +the AEGIS user text (exact request) 400 json_validate_failed, failed_generation 64 chars not starting with `{`; same request with max_tokens 2000 200 (report 865 chars + done, 267 completion tokens < 300). No request field is rejected: the model's own output was not JSON (prose start), not truncation. Groq default temperature (gateway sends none) makes it vary run to run — inferred, not measured (daily token limit hit). Fixed labels/logging: `json_validate_failed` → PlanShapeError (existing one corrective retry, then PLAN_INVALID), log `reason=output_not_json` + failed_generation length; full error body as `model_error_detail` only with AEGIS_LOG_PAYLOADS. Then (user-approved): system prompt routes questions/explanations to `report` (≤120 words) + `done` in the same step and says the reply starts with `{`; `AEGIS_MODEL_TEMPERATURE` (new setting, launcher default 0); launcher `AEGIS_MODEL_RETRY_MAX_WAIT_S` 30 → 60 (a corrective retry right after a ~6.7K-token call always drew a 38-57 s 429). Live check, same task and page, n=1: one call, 6,709 prompt / 208 completion tokens, report + done executed, 5.9 s, 0 leaks. Before: 4 of 5 full attempts json_validate_failed. | |
| 2026-09-29 | GMAIL-2 | Gmail "create a draft reply … 'i will surely join'": step 4 `type "i will surely join" → "Message Body"` ✗ FAILED_DISABLED. Gmail's body is a `contenteditable` div (role textbox): `selection.ts` gives it the `type` affordance and preflight lets it through, but `dispatch.ts` `dispatchType` handled only `<input>`/`<textarea>` and returned `DISABLED` for anything else. Fixed: contenteditable path (caret at end, or whole content for clear_first; `document.execCommand('insertText')` / `insertLineBreak` so the editor gets native beforeinput/input; manual insert + synthetic input as fallback); aria-disabled/aria-readonly editors still refused. Browser tests (real Chromium) added; live Gmail repeat by the user (inbox needs a login). | |
| 2026-09-29 | GMAIL-3 | Gmail reply, second run: `type … → "⟪LIVE⟫"` ✗ FAILED_DISABLED. Reproduced offline with `AEGIS/demo/gmail-reply.html` (Gmail's inline-reply markup; the editor's attributes change every 120 ms like Gmail's open compose) through the real extension: the editor is volatile, so (1) its label "Message Body" was sent as `⟪LIVE⟫`, (2) preflight refused it with NODE_VOLATILE, (3) logging NODE_VOLATILE threw (missing from the logger's closed vocabulary), the handler's catch logged `port_message_malformed` and sent no action-result, (4) the host waited forever. Fixed: logger vocabulary typed from `PreflightFailureReason` (+ INTERNAL_ERROR); a throwing handler answers `INTERNAL_ERROR` and logs `port_handler_failed`; host fails an unanswered action after 15 s (`FAILED_NO_RESULT`); `type` into a text field/editor is exempt from NODE_VOLATILE (clicks still refused); a volatile text field keeps its label (still scanned as page text), its value stays ⟪LIVE⟫; Setup shows the extension build time. The user's FAILED_DISABLED itself matches the pre-GMAIL-2 executor (likely the old build still loaded). Verified: stub run and one live Groq run on the replica — `type … → "Message Body"` + done executed, 3.2 s. | |
| 2026-09-29 | GMAIL-4 | Gmail "compose a fresh email to this guy whose email is shown … 'hello there'": `type ⟪EMAIL#2⟫ → "To recipients"` ✗ REHYDRATE_TYPE_MISMATCH. `rehydrate.ts` condition 3 accepted EMAIL only for type=email / autocomplete=email / a name containing "email" / a field already classified EMAIL; Gmail's To box is a text combobox named "To recipients". Fixed: the field-label lexicon (recognizers `field-labels.ts`) names `To/Cc/Bcc/Add recipients` and `Recipients` as EMAIL (so the field is also protected by label); a bare "To"/"Cc"/"Bcc" is accepted for EMAIL only when the page has a typeable "Subject" field (mail compose), never on travel "From/To" forms; search boxes etc. still refused. Found with it: the session passed empty RiskSignals, so design §9.2's send/delete/pay/transfer confirmation never fired — the model clicked Gmail's Send unasked. Wired (`hasHighRiskVerb` on the clicked node's own name); the card now names the control. Verified live on `AEGIS/demo/gmail-compose.html` with the user's prompt: ⟪EMAIL#1⟫ filled into To locally, body typed, Send held for confirmation, raw address 0× in payloads. | |
| 2026-09-29 | VISION-1 | Requested: the vision model is used on every step of every task, no matter what. Before, a step went text-only when the DOM explained ≥70% of the viewport and no `<img>` needed analysis (L0 escalation), when the "Send a redacted screenshot every step" setting was off, on a failed or moved capture, a failed vision worker, a hostile-dynamic page, when guard step 5 dropped the image, when the local models failed to start, or with `AEGIS_MODEL_VISION=false` on the gateway. Now: `runPerceptionStep` always captures the full frame (L1); the session retries a transient failure (moved page, throttled/invisible capture, worker error, mutation storm) up to 3× in the step, 700 ms apart, then stops (`VISION_UNAVAILABLE` / `HOSTILE_DYNAMIC`) instead of sending text-only; a screenshot the guard drops stops the step (never sent); the task does not start if the vision worker cannot; the setting is removed; the gateway always forwards the image and refuses to start with `AEGIS_MODEL_VISION=false`. Unchanged on purpose: the gateway's one corrective retry after an invalid plan stays text-only (the first call has already used most of the 7K-token/min budget; resending the image hit 413/429); the `dom_only` ablation arm (debug builds/eval harness only) still sends no image. | |
| 2026-09-29 | VISION-2 | Shop task (search result → product page): step 5 stopped `VISION_UNAVAILABLE: capture not-visible`. The click opened the product page in a NEW tab; the task stayed attached to the search tab, now behind it, and `capture-tab.ts` refuses a background tab (it would otherwise grab the front tab's pixels). Fixed both halves: (1) the panel records tabs opened from the task tab (`tabs.onCreated` openerTabId) and `Session.observe` follows one after an AEGIS action — attaches (same wait/permission/inject path as same-tab navigation), makes it the task target, history says `opened a new tab`; (2) a task tab in the background (on the task origin) is brought to the front for the capture, still checked active before and after, and the user's previous tab is put back. Verified in Chromium with the real extension: `demo/new-tab-results.html` → target=_blank cross-origin link → step 2 on `new-tab-product.html` with a redacted screenshot, done. | |
| 2026-09-29 | VISION-3 | After VISION-2, the shop task followed the new Amazon tab but step 9 stopped: `capture permission` — "Either the '<all_urls>' or 'activeTab' permission is required". The user's Chrome loads the RELEASE build (`.output/chrome-mv3`, `<all_urls>` optional) with per-site grants only (amazon.in, google.com, …, read from the profile's Preferences). `captureVisibleTab` accepts only `<all_urls>` or an activeTab click on that tab; a per-site host grant is not enough (reproduced in Chromium with a two-line extension: per-site → refused with the same message, `<all_urls>` → captured). A tab the task's own click opened was never clicked on, so it could be read (per-site grant) but never captured. Fixed: `ensureTaskPermissions` asks once at Run (a user gesture) for the manifest's optional `<all_urls>`; declined → falls back to this site only, and the panel's Setup says the icon must be clicked on other sites' tabs. Host access only lets AEGIS inject into and capture the task's tab; sanitize/guard before egress is unchanged. | |
| 2026-09-29 | AGENT-1 | Three requests. (1) Screenshot taken before a new page loaded: after a step's actions the session only waited for the old page's settle (≤1.5 s), so a click whose navigation started later was observed/captured on the old page. Now `BrowserControl.waitForPageReady` runs after every acting step: 700 ms for a navigation to start, then the tab's load to complete (≤20 s), then 500 ms paint; attaching a new or navigated tab also waits 500 ms paint after load. (2) Standard browser tools for the remote model: protocol ops `press_key` (Enter/Tab/Escape/Backspace/Delete/Space/arrows/PageUp/PageDown/Home/End; the default action is performed, since synthetic key events have none), `hover`, `double_click`, `navigate`, `open_tab`, `go_back`, `go_forward`, `reload` (schema → regenerated TS + Pydantic; gateway prompt; gateway logs only the URL's host; extension validator; content executors `content/execute/keys.ts`; host navigation via the tabs API, never the content script). `wait` now actually waits (it was marked executed without waiting). URLs: http(s) only, no credentials, no ⟪…⟫ (schema pattern + `parseWebUrl`). Going to another origin (navigate/open_tab) asks for confirmation (design §9.2); a navigation op ends the step. (3) Wrong site (e.g. shopping from ChatGPT): the system prompt tells the model to `open_tab` the right site; the new tab is followed (tab id recorded from `tabs.create` — `onCreated.openerTabId` did not arrive for the extension's own tab); the all-sites permission from VISION-3 covers inject + capture. Verified in Chromium with the real extension + scripted upstream: chat page → open_tab (confirmed) → new tab → hover + Enter on "Add to cart" (took effect) → done, image every step; a same-tab link with a 2.5 s server delay → step 2 observed the loaded product page. | |
| 2026-09-29 | AGENT-2 | Visible real-site runs of AGENT-1 (`probe_site.py --watch`, live Groq; rule now in `AEGIS/CLAUDE.md` §8). Found and fixed: (a) the probe never saw the extension load in a headed browser — it polled `service_workers` with `time.sleep`, which blocks the sync API's event delivery; now waits for the `serviceworker` event. (b) Wikipedia search: the model typed into "Search Wikipedia" and then clicked that same box, 4 steps in a row, never using `press_key` although the task said "press Enter" — the system prompt now says to submit a typed field with `press_key` Enter on it (with an example) and not to repeat an action that changed nothing; rerun: type + Enter in one step, 4 steps instead of 8. (c) `open_tab` from gemini.google.com failed `FAILED_NAVIGATION`: `tabs.create` put the tab in the panel's current window while its opener was in the page's window (Chrome refuses); now created in the task tab's window. Results: Wikipedia USB-C → click "USB Power Delivery" → step 3 observed "USB hardware - Wikipedia" after load, answered; Wikipedia Main Page → type + Enter → scroll ×2 → "2012"; gemini.google.com → model chose `open_tab www.amazon.in` (confirm card shown) → task moved to the new Amazon tab → step 2 on "Amazon.in : 65W USB-C charger" (378 elements, redacted screenshot) → reported the first result and its price, nothing added to the cart (rerun after the `windowId` fix, with a new key; the first attempt also hit Groq's daily token limit). chatgpt.com refuses automated browsers (curl 403, Chromium timeout), so the wrong-site run starts from gemini.google.com. | |
| 2026-09-29 | AGENT-3 | User run, amazon.in: step 2 typed the search and pressed Enter, then the task stopped `PAGE_DISCONNECTED: NEW_PAGE_UNREACHABLE`. Two causes. (a) `attachTab` (sidepanel/main.tsx) returned null as soon as the new page took over 20 s to fire its load event — Amazon's results page on a slow connection does (the fixed rerun's re-attach took 23 s); now it waits up to 20 s for `complete`, then connects anyway (the content script's `ready` is the real signal) and keeps trying until a 60 s deadline, logging a closed-vocabulary reason for each refusal (`tab-closed`, `not-a-web-page`, `no-host-permission`, `no-ready`/`inject-failed`, `deadline`). (b) `Session` treated a disconnect as a navigation only while `actedSinceObserve` was set, which is cleared right after observe — a page replacing its document during perception (or before any action: a redirect, a still-loading page) stopped the task with a bare `PAGE_DISCONNECTED` (reproduced on amazon.in → amazon.com); now every disconnect of the task's tab re-attaches, and observe + perception run again on the new document, up to twice per step (`REATTACH_LIMIT`). Also: Run on a still-loading tab waits for it to finish first (step 1 had seen 0 elements). Tests: session.spec (re-attach mid-capture), session-failures.spec (document replaced before any action), both failing on the old code. Visible rerun on real amazon.in: type + Enter → results page re-attached → first result reported, `Done`. | |
| 2026-09-29 | QUALITY-1 (R-9, R-11) | Whole-frame perception replaces per-crop vision. YuNet runs over the whole screenshot (full frame + native-resolution 640 px tiles, merged), and every face must pass a landmark-geometry check (eyes above nose above mouth, eyes apart, landmarks inside the box, aspect 0.5–1.6, score ≥ 0.6, ≥ 0.75 under 24 px): upscaled icons/logos no longer come out as FACE. PP-OCR text detection runs over the whole frame (long side 1280); a line lying on DOM text boxes the recognizers already scan is not re-read; lines in pictures, canvas, SVG, cross-origin frames are read (CTC timestep positions give each match its own sub-line box). CLIP classifies each picture first, but a sensitive label is redacted only when the pixels agree (`perception/detect/verify.ts`): QR finder patterns / barcode bars (conclusive alone), signature ink strokes, ID-document text or a face + text on a card-shaped region. The compositor shows the capture by default ONLY when faces and text were both screened over every pixel (`FrameAnalysis`); grey marks only what a model could not check in time (a picture CLIP had no time for, a text line not read); any failed pass falls back to grey-by-default. Guard re-scan hits are added as black boxes on top (was: recompose with everything grey). DOM text redactions use the matched characters' own rectangles (`measure-spans`, DOM Range) instead of the whole run box; inline mixed paragraphs (`text <a>link</a> text`) are one text run (their words were read by nobody). Generic high-entropy SECRET needs ≥ 2 digits (OCR'd captions without spaces were flagged). Measured on real pages (live runs, `--watch`): amazon.in results page 63% → 100% shown, charger photo no longer QR_CODE, hero banner no longer ID_DOCUMENT; Wikipedia Main Page unanalysed 37% → 0%, 99% shown, faces still redacted. | User report: faces on non-faces, wrong classes, too much grey. |
| 2026-09-29 | RESILIENCE-1 | No failure inside a step ends the task. `Session.start` runs each step in a try; a failed step goes back to OBSERVING (new controller event `recover`) and the next step starts from a fresh observation; 5 failed steps in a row stop with `RECOVERY_EXHAUSTED`. Specifically: no screenshot (capture/worker failure, mutation storm) → the step is sent WITHOUT an image (never an unredacted one) instead of `VISION_UNAVAILABLE`/`HOSTILE_DYNAMIC`; guard PATTERN/VAULT_LEAK → the flagged text is sealed (`scrubPayloadText`) and guarded again; gateway `UNSANITIZED_CONTEXT` → sealed strictly and re-sent once; gateway unreachable/5xx/429/timeout → up to 6 sends with back-off; 404/409 (gateway restarted, lease lost) → a new gateway session is opened and the step re-sent; CAPTCHA → the task waits (≤ 5 min) for the user to solve it and continues; `ask_user` → the panel asks, the answer joins the task; perception worker crash or hang (per-request timeouts) → replaced and re-initialised on the next step; a model that failed to load is retried every 15 s; local models failing at Run no longer stop the task; gateway session open is retried for ~30 s. Also fixed: `ReconciliationTracker.resetForNewStep` was never called (3 failed actions anywhere in a task stopped it); un-redacted refs were blocked by the guard (it now exempts them). Verified live: gateway killed mid-task and restarted 6 s later → `SESSION_NOT_FOUND` → session re-opened → task done. **Supersedes VISION-1's "stop rather than send text-only"** — see the open question below. | User: the extension must never stop on model/page/gateway errors. |
| 2026-09-29 | READY-1 | Screenshots of half-loaded pages: before every observation the content script waits until the page is visually complete (`content/observe/ready.ts`: parsed, fonts loaded, every `<img>` in the viewport complete, no new network response for 400 ms, no DOM insertions for 350 ms; ≤ 8 s on a new page, ≤ 3 s otherwise); Chrome's tab `complete` is waited for at most 2.5 s. Verified: amazon.in results page waited 4.3 s for its pictures, sent 100% shown. | User report: slow connection, screenshot before images load. |
| 2026-09-29 | LATENCY-1 | Groq budgets are 8K tokens/min PER MODEL (headers, 2026-09-29) and a step cost ~6.5K, so every second step waited 30–60 s on a 429. (1) Gateway route pool: per-model token buckets from `x-ratelimit-*` headers; a step goes to the vision model if it can answer within 4 s, else to the first text-only fallback with budget (`AEGIS_MODEL_FALLBACKS=openai/gpt-oss-120b,openai/gpt-oss-20b`, reasoning low), same sanitized page structure without the screenshot; a 429 moves the step instead of sleeping; the corrective retry is routed too. `AEGIS_MODEL_FALLBACKS=` (empty) restores vision-only. (2) Prompt: system prompt 4,924 → 2,340 chars; noise elements dropped (1-px helpers, unnamed pictures, wrappers repeating an element's name, containers repeating children), integer boxes, caps 80 elements / 25 runs. (3) Tab-complete waits 20 s → 2.5 s (READY-1 does the real wait). Measured live: amazon.in 2-step task 88.5 s → 29.1 s; Wikipedia search+answer 8 steps/~minutes → 2 steps 15.1 s. gpt-oss-120b answered the Amazon step correctly in 1.1 s; gpt-oss-20b was weaker (last resort only). | User report: > 1 min server response. |
| 2026-09-29 | EVAL-QUALITY-1 | Harness after QUALITY-1/RESILIENCE-1 (`eval/reports/2026-09-29T180228Z-dev`, n=182 screens — the corpus grew from 166, so not directly comparable with 2026-09-28): leak count 1 (same PIN_CODE, LOW by policy) vs 1; over-redaction on 28 hard negatives 0 vs 0; pixel precision 0.910 vs 0.978; ID_DOCUMENT FP 0 (an intermediate run found 2: a PAN number alone on a dashboard canvas made the whole canvas an "ID document" — fixed, a number now counts only with the document's own wording); step round trip p50/p95 1475/1896 ms (mock model). PHONE 10 TP / 21 FP / 21 FN (was 31/0/0) and EMAIL 23/6/5 are a LABEL-GRANULARITY effect, not a detection loss: the labels mark the whole element or sentence (e.g. `[16,90,340,20]` for a sentence), the client now blacks out only the value's own characters (`[93,89,127,24]`), IoU 0.29–0.49 < 0.5. Open for the team: re-label text items at value level (the fixture generator can measure a DOM Range), or keep element-level labels and accept the score. | Measure, do not assert. |
| 2026-09-30 | VISION-2 | **Resolves OQ-VISION-TEXT (user: "every step should have screenshot"; the local models are on the client and must always be available).** No step is ever sent without its redacted screenshot, on any path. Client (`session.ts` `runStep`): a capture that fails is retried up to 4 times in the step (a crashed/hung worker is replaced by the client first); a page whose geometry moves during capture, or that is in a mutation storm, is captured anyway in **pixel-verified** mode (`run-step.ts`: no geometry digest; no DOM text box exempts a line from whole-frame OCR; pictures screened at both pre- and post-capture positions; sent only if the whole-frame face and text passes both completed); if still no screenshot, NOTHING is sent and the step is retried from a fresh observation (5 in a row → `RECOVERY_EXHAUSTED`). Compose failure → step retried, not sent image-less. Guard (`image-rescan.ts`): each re-scan hit is blacked out and re-checked, up to 3 rounds; still not clean → `GuardBlockedError('IMAGE_RESCAN')` and the step is retried (was: image dropped, step sent text-only). Grant card: "Continue without screenshots" replaced by "Allow AEGIS on all sites" (host permission requested from the click). Worker: a model that fails at inference on WebGPU is re-created on WASM and re-run (`ModelRegistry.reloadOnWasm`); a failed load is retried after 2 s (was 15 s). Gateway: text-only fallback routes removed (`build_messages(text_only)` gone); `AEGIS_MODEL_FALLBACKS` may list vision models only, default empty (Groq serves one: `qwen/qwen3.8-27b`, checked via /models 2026-09-30). | User decision 2026-09-30. |
| 2026-09-30 | LATENCY-2 | Latency with a screenshot on every step. Measured on Groq (qwen3.8-27b, 2026-09-30): a screenshot bills 1,807 prompt tokens at every size 512–1236 px and with `detail: low`, and the same 1,807 is deducted from the 8K tokens/min budget a second time just after the response; Groq admits a request only when prompt + that second charge + the whole `max_tokens` fit. So a vision step at ~6.1K prompt tokens took the whole minute. (1) Prompt: element ids sent as aliases `e1…` (`prompt/aliases.py`, mapped back before validation; model-facing schema pattern `^e[0-9]+$`), text runs without ids, caps 45 elements / 10 runs × 120 chars, occluded elements ranked below visible ones, per-step image legend shortened → Amazon step 6,070 → 4,140 prompt tokens. (2) Gateway waits for the budget itself (`model_budget_max_wait_s` 60) instead of sending into a 429: per-model bucket = min(headers, its own ledger of what it sent in the last minute), cost = text/2.3 chars-per-token + `AEGIS_MODEL_IMAGE_BUDGET_TOKENS` 3,600 + max_tokens; a 429's Retry-After is trusted, its budget headers ignored (they turned a 5 s Retry-After into a 42–50 s wait). Measured live (visible runs, amazon.in 2-step search task): 88.5 s (2026-09-29, before) → 46.2 s and 52.0 s with a screenshot on both steps; step 2 waits 9–12 s for the budget, no 429. The rest of that wait is Groq's free-tier 8K tokens/min per model: steady state ≈ one vision step per ~45 s; a paid tier or a self-hosted vLLM removes it (config only). Free tier also has a daily token cap (hit 2026-09-30 00:43 after ~60 vision calls: 429 Retry-After 1022 s). | User: fix latency, screenshot every step. |
| 2026-09-30 | QUALITY-2 | Picture-heavy pages: on amazon.in's home page faces + full-frame text detection + CLIP used the whole 2.5 s frame deadline and 0 lines in pictures were read (24.7 % of the screenshot grey: every banner's text). Text reading now always gets ≥ 1.5 s (`MIN_TEXT_READ_MS`); pictures past CLIP's budget are screened by pixel structure (QR finder patterns, barcode bars, signature ink) and their fully read text, and cleared when none of those fire (outcome `pixels`), else grey. Live: grey 24.7 % → 6.9 %, OCR rec ×0 → ×49, perceive 2.7 → 4.2 s. | User: too much non-sensitive content grey. |
| 2026-09-30 | EVAL-LABELS | **Resolves the EVAL-QUALITY-1 open item (user: "only the phone number should be redacted not the entire sentence").** Text labels in `eval/labels/*.json` (dev and held-out) are now value-level: `eval/src/aegis_eval/corpus/value_boxes.py` finds the value's span in the element text by its label hash (case, spaces, `+`/`-` and Devanagari digits folded) and measures it with a DOM Range, or with a fillText hook for canvas text; picture entities, NONE items and items with no matching span keep their boxes; `generate_fixtures.py` runs it after generation. Harness `eval/reports/2026-09-29T192728Z-dev` (n=182, same code as EVAL-QUALITY-1 plus VISION-2/QUALITY-2): PHONE 30 TP / 1 FP / 1 FN (was 10/21/21), EMAIL 28/1/0 (was 23/6/5), UPI_VPA 3/1/1 (was 2/2/2), mean IoU of matched boxes 0.862 (was 0.626); leak count 1 (same PIN_CODE, LOW by policy); over-redaction on 28 hard negatives 0; step round trip p50/p95 1638/2056 ms (mock model; was 1475/1896). Open: pixel precision 0.856 (was 0.910) and PAN 14/1/2 (was 15/0/1) — expected with tighter labels wherever the client still greys more than the value, not yet traced per screen. Pre-existing, not fixed: `eval/tests/test_airplane_mode_rehearsal.py` uses a `file://` page (panel: UNSUPPORTED_PAGE) and expects an "Error" terminal state the no-interruption rule no longer produces. | Measure, do not assert. |
| 2026-09-30 | PLAN-TEXT-1 | User's Gmail task "write a professional reply to this mail …" stopped `SERVER_ERROR: PLAN_INVALID` (the user suspected the Groq key; the key was fine: both calls 200). Gateway log: the model put the whole reply in one `type` action and the text failed `string_too_long` (the schema capped `type.text` at 500 characters); the corrective retry was told so and wrote it too long again → 422. A reply or message routinely exceeds 500 characters. Fix: `action-plan.schema.json` `type.text` maxLength 500 → 2000 (TS types, ajv validators and Pydantic models regenerated; both extension builds carry `maxLength:2e3`); the system prompt states the limit; `AEGIS_MODEL_MAX_TOKENS` 300 → 900 (`run-gateway.sh`, `model.env.example`) so a 2000-character reply fits the completion; the budget ledger (`_TokenBucket.refund`) now gives back the unused part of max_tokens after each answer, as Groq does, so the larger reservation does not lengthen the wait between steps. Typing is one `insertText` per line, so long text costs no extra time. Tests: gateway 164 (new: refund), protocol 12, extension 688, tsc clean. Not yet shown in a live run (a message send is the user's own run, not an agent run). | |
| 2026-09-30 | LOOP-TYPE-1 | User's Gmail reply task after PLAN-TEXT-1: the reply was typed into the message box on step 1, then again on steps 2, 3, 4, 5 (gateway log: every step `type` into the same node, text_len 641), stacking copies in the draft. Causes: (1) `extractor.ts` `computeHasValue` only knew input/textarea/select, so a contenteditable (Gmail's body) was always sent as `has_value: false` and the prompt showed it `empty`; (2) `type` appended by default; (3) history entries carried only the op (`type -> acted`), not which element. Fix: a contenteditable reports its text length (length only, never the text) as `has_value`/`value_len`; `dispatchType` replaces the field's content unless the plan says `clear_first: false`, so a repeat leaves one copy; history entries carry the node id and the prompt renders them with this step's alias (`s-1: type e5 -> acted`); the system prompt says type replaces and that a field already typed into that shows `has value` must not be typed again; the gateway remembers a digest of the literal text last typed into each field and post-validation refuses the same text into a field that still has a value (the corrective retry tells the model to go on, e.g. click Send, or finish). Tests: gateway 166 (repeat refused; different text / emptied field allowed; history alias), extension node 688, browser dispatch+extractor 28 (replace by default, reply typed twice leaves one copy, contenteditable has value). Both builds rebuilt. Not yet shown in a live run: the user's own Gmail run (a message send is theirs to run). | |
| 2026-10-25 | DOCS-TRACKED | `docs/` is tracked in git; `API.md`, `DEVELOPMENT.md`, `TESTING.md`, `DEPLOYMENT.md` moved to `docs/guides/` and rewritten from the code. | README, CLAUDE.md and AGENTS.md all link into `docs/`, which teammates and GitHub could not see. |
| 2026-10-25 | UNWIRED-KEEP | Modules that are built and tested but have no production caller stay in the tree, listed in architecture-as-built.md §11. | Product owner's call: kept for later work rather than deleted. |
| 2026-10-25 | MACHINE-NO-BLOCK | The controller no longer models a `BLOCK` state or the `guard_block` / `reconciled_locally` events. | No code sent them: a guard block fails only the step and the session sends `recover`. |
| 2026-10-25 | HISTORY-FWD | Pushed git history is not rewritten. Commits from now on follow CONTRIBUTING.md. | Rewriting `main` would force-push over five authors' commits. |
| 2026-11-03 | PERSIST-RESUME | Closing the panel still ends the task; the panel saves and restores its view and offers Resume. The agent is not moved out of the panel. | Product owner's choice between "restore + resume" and "keep running when closed". The second rewrites the runtime-context layout (§15.2) and every browser call in the panel wiring. |
| 2026-11-03 | PERSIST-STORE | The saved task lives in `storage.session` (memory-only, extension pages only), one record per window, removed when the window closes or on Dismiss. It holds the task text as typed, the run log (sanitized payloads, redacted screenshots, model text) and HISTORY; never vault values or raw captures. Older steps' screenshots, then payloads, are dropped to keep a record under 4 MB. | Same lifetime as the session it describes; `storage.local` would put the task text on disk. 10 MB quota shared by the extension. |
| 2026-11-03 | PERSIST-DRAFT | The task-box draft is kept like the saved task: `storage.session`, per window, dropped with the window; not cleared by Dismiss. | Same privacy reasoning as PERSIST-STORE (the user's own text, memory-only); Dismiss is about the interrupted run, not what the user is typing. |
| 2026-11-03 | PERSIST-REFS | A resumed run starts a fresh vault; sealed refs in the earlier HISTORY (`⟪EMAIL#1⟫`) are reduced to their type (`⟪EMAIL⟫`). Budgets restart. | The new vault may mint the same ref for a different value; the model must not type an old ref expecting the old value. |
| 2026-11-03 | PROMPT-SITUATIONS | The prompt is split: a fixed system message with the rules for every step, and per-step `SITUATION` rules chosen from the guarded step by code-defined triggers (`agent/situations.ts`), placed in the user message. Capped at 2 rules (compact) / 4 (rich). | Product owner: "the prompt should be dynamic according to the situation". Rules for every kind of task in one fixed message were read as optional; the Codeforces run asked the user for code. The system message stays a stable prefix for provider caching. |
| — | R7-AC6 | *(fill in when R-7 lands)* "Forced detector miss blocks egress" is read as "the raw value never leaves the device". | |
| — | R9-face-render | *(fill in)* Whether the sent image shows the mosaic or only the solid fill. | |
