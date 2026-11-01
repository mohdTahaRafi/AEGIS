# R-1 — Choose and stand up the VLM

**Priority:** P0 · **Depends on:** R-0 · **Unblocks:** R-2, R-3, R-6, R-12
**Parent list:** [tasks.md](tasks.md)
**Status (2026-09-28, second pass):** model chosen and measured; the gateway now reaches Groq
(authenticated, with the image, `json_object`, validated plans). **R-1 is not complete**: the live
gateway checks could not reach their targets before the free tier's daily token limit ran out, and
three acceptance criteria are not met. See [Acceptance](#acceptance) and
[Open items](#open-items).

## Goal

Pick one server model, get it reachable through an OpenAI-compatible `/chat/completions`
endpoint, measure it with `tools/vlm/smoke.py`, and make the gateway's and the probe's defaults
agree with that choice.

**Constraint (team decision, 2026-09-28):** Groq's free tier only. No paid API, no GPU hosting, no
billing upgrade. This replaces the earlier plan for a paid OpenRouter route.

## Decision

| Use | Endpoint | Model id | Why |
|---|---|---|---|
| **Demo and development** | `https://api.groq.com/openai/v1` (free tier) | `qwen/qwen3.8-27b` | It is the **only** image-input model Groq serves (verified below). Open weights (Alibaba Qwen). It passed text, read pixels, answered grounding consistently, gives `json_object` output, and runs with thinking off. |
| **Offline** | Gateway `AEGIS_MODE=replay` | — | Recorded from the demo model in R-6. It is also the fallback when Groq is down or throttling. |

There is no second live endpoint: a self-hosted vLLM needs a GPU, which the constraint rules out.
`DEPLOYMENT.md` §3 B keeps the vLLM commands for reference only.

### What Groq offers (verified 2026-09-28)

These were checked against both Groq's official docs and the live API with the team key.

| Fact | Value | Source |
|---|---|---|
| Image-input models | `qwen/qwen3.8-27b` only | console.groq.com/docs/vision; `GET /openai/v1/models` |
| Status | **Preview** ("may be discontinued without notice") | console.groq.com/docs/models |
| Context / max completion | 131,072 / 16,384 tokens | model card; `/models` |
| Images per request | up to 3; 20 MB per URL image | docs/vision |
| Structured output | `json_object` on all models; `json_schema` strict and best-effort listed for this model | docs/structured-outputs |
| Thinking switch | `reasoning_effort`: `none`, `default`, `low`, `medium`, `high` | docs/reasoning |
| Free-tier limits | 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD, **per organization** (all keys share them) | docs/rate-limits; `x-ratelimit-*` headers (`limit-requests: 1000`, `limit-tokens: 8000`); the TPD 429 body (below) names the organization |
| Data | Not retained by default. Temporary logging (≤ 30 days) for troubleshooting or abuse. Zero Data Retention can be enabled in Data Controls | docs/your-data |

The live `/models` list for this key (2026-09-28) is: `allam-2-7b`, `canopylabs/orpheus-*`,
`meta-llama/llama-prompt-guard-2-*`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`,
`openai/gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b`, `whisper-large-v3(-turbo)`. No Llama 4
Scout/Maverick and no Qwen-VL is listed, so there is no other vision model to choose.

`qwen/qwen3.8-27b` is the same model the earlier plan ruled out on OpenRouter's free route. That
was ruled out for throttling (1/30 calls succeeded) and thinking-by-default, not quality. On Groq
the throttling is different (the organization's own quota, not a shared pool) and thinking is off
(measured below).

## Implementation

### First pass (2026-09-28): probe and defaults

- **`tools/vlm/smoke.py`**
  - Groq defaults (`https://api.groq.com/openai/v1`, `qwen/qwen3.8-27b`), with the key read from
    `AEGIS_MODEL_API_KEY`, `GROQ_API_KEY` or `OPENROUTER_API_KEY`, never printed.
  - `--extra-body`, defaulting to `{"reasoning_effort": "none"}` on Groq.
  - A `kwargs` baseline, a `gateway` probe (the gateway's exact request), `--trials N`, and the
    long-side grounding convention.
  - On a 429 it honours `retry-after`, and records the `x-ratelimit-*` headers.
  - Transport errors are failed samples, not crashes.
- **`config.py`** defaults: Groq URL and model, timeout 30 s.
- **`server/deploy/model.env.example`** (new); `.gitignore` ignores `server/deploy/model.env`.
- **`DEPLOYMENT.md` §3** and **`tools/vlm/README.md`** rewritten for Groq.

### Second pass (2026-09-28): gateway integration and reliability

The gateway could not call Groq: no key header, `chat_template_kwargs` (HTTP 400), strict
`json_schema` (HTTP 400). This pass implements only the parts of R-2 and R-3 that Groq needs, as
those specs describe them. The rest of R-2 and R-3 is untouched and listed under
[Follow-up](#follow-up-for-r-2-r-3-and-r-12).

| Spec part | What changed | Files (under `server/gateway/src/aegis_gateway/`) |
|---|---|---|
| R-2 §1 | `Settings.model_api_key` (`repr=False`), `model_vision`, `model_max_tokens`; env `AEGIS_MODEL_API_KEY`, `AEGIS_MODEL_VISION`, `AEGIS_MODEL_MAX_TOKENS` | `config.py` |
| R-2 §2–3 | The guarded WebP becomes an `image_url` content part. IMAGE/LEGEND lines go after TEXT, and legend lines carry the first redaction box. A step without an image is byte-identical to before | `prompt/__init__.py`, `prompt/legend.py` |
| R-2 §4–5 | `Authorization: Bearer` and `max_tokens` on every call; the route passes `vision=settings.model_vision` | `model_client/vllm.py`, `api/routes_steps.py` |
| R-2 §6 (A5 logging half) | `log_payload` replaces image bytes with `<N b64 chars>` | `structured_log.py` |
| R-3 A1 | `model_response_format` (default **`json_object`**) and `model_chat_template_kwargs` (default `false`); env `AEGIS_MODEL_RESPONSE_FORMAT`, `AEGIS_MODEL_CHAT_TEMPLATE_KWARGS` | `config.py` |
| R-3 A2 | `normalize_plan`: wraps a bare action or list; server-owned `step_id`/`plan_id` (`p-N`); unknown top-level keys dropped; bare refs wrapped to `⟪…⟫`. Unreadable output → `PlanShapeError` | `model_client/normalize.py` (new) |
| R-3 A3–A4 | `load_model_facing_schema` (bare refs, no server ids); `_response_format()` per setting; code fences stripped; every upstream failure a `GatewayError` (A21 fixed) | `model_client/vllm.py` |
| R-3 A5 | `MODEL_UNAVAILABLE` message names the reason: `no_replay_match`, `unreachable`, `upstream_429`, `upstream_4xx`, `upstream_5xx`, `bad_body` | `errors.py` |
| R-3 A6 | The system prompt spells out every action shape and "one JSON object `{"actions":[…]}`", because `json_object` sends no schema | `prompt/system.py` |
| R-3 A10 (validation half) | `_validate_candidate_plan(raw, session, step_id)` = normalize → wire schema (`ActionPlan`) → session post-validation; the one retry goes as a **user** turn; the response is the normalized plan | `api/routes_steps.py` |

**Reliability additions (R-1, not in the R-2/R-3 specs):**
- **Bounded retry** (`VLLMClient._post`):
  - at most `AEGIS_MODEL_MAX_RETRIES` (default 1);
  - only for a 429 whose `retry-after` ≤ `AEGIS_MODEL_RETRY_MAX_WAIT_S` (default 10 s), waiting
    exactly that long, or for a dropped connection (`ConnectError`, `RemoteProtocolError`,
    `ReadError`, 1 s wait);
  - never after a timeout (the model may still be generating), never on a 4xx/5xx, never without
    a `retry-after`.
- **429 reporting.** A 429 that isn't retried becomes a 503 with Groq's `Retry-After` passed
  through. `GatewayError` gained optional `headers`; the error body's shape is unchanged.
- **Logging.** `model_call`, `model_retry` and `model_error` events carry only status, reason,
  attempt, wait and error class.
- **Pre-existing bug fixed:** the `aegis_gateway` logger had no handler, so every INFO event
  (`step_processed` included) was silently dropped. `configure_logging()` in `create_app` gives it
  one JSON-lines stderr handler.
- **Extension error reporting** (`apps/extension/`):
  - `host/egress/gateway-client.ts` throws `StepFailedError(status, detail)`, where `detail` keeps
    only the closed-vocabulary error code, the `MODEL_UNAVAILABLE` reason and `Retry-After` (never
    free text from the response);
  - `host/session.ts` puts it on the `stopped` event;
  - `entrypoints/sidepanel/main.tsx` shows e.g.
    `SERVER_ERROR: MODEL_UNAVAILABLE upstream_429 retry in 204 s` instead of a bare `SERVER_ERROR`.
- **`smoke.py`:**
  - `--grounding-grid` (4 targets × landscape/portrait, a per-axis linear fit);
  - `--image-format png`;
  - 429 waits capped at 120 s (a longer `retry-after` is a daily limit);
  - every 429 received counted.
- **Live check scripts** `server/gateway/scripts/{_live,r2_live_check,r3_live_check}.py`, with
  `--pause` between runs to respect the TPM limit. They run on the system Python (Pillow needed).

The protocol schema, the generated models and the error envelope are unchanged. Deliberately not
done:
- R-2 §7 (session metadata, A12);
- R-3 A7–A9 (full snapshots, element rendering);
- R-3 A11 (rate-limit leak);
- R-3 Part B (extension snapshots);
- any R-12 adapter change.

## Measured results

All against Groq `qwen/qwen3.8-27b`, `reasoning_effort: "none"`, from
`mightylord77-IdeaPad-Slim-5-14IMH9` (Linux 7.0.0-34, Wi-Fi), end to end. Dates are UTC.

### Probe (`smoke.py`)

| Check | Result | Report |
|---|---|---|
| Text call | pass (0.29 s) | `r1-2026-09-28-groq.json` |
| Latency, n=10 | 10/10; TTFT p50 1.40 s / p95 17.23 s; total p50 1.60 s / p95 17.47 s; 2,414 prompt + 120 completion tokens | same |
| Thinking | off: `reasoning_effort: "none"` → 0 reasoning chars, 2 completion tokens; no switch → the same | same |
| `chat_template_kwargs`, OpenRouter `reasoning` | HTTP 400 "property … is unsupported" | same |
| Structured output | `json_object` ✅; `json_schema` strict ❌ 400 (optional keys); strict all-required schema ❌ `json_validate_failed`; best-effort (`strict: false`) ✅ | same |
| **Vision, WebP q80** (what the extension sends) | **11/14 exact** across all runs: 6/8 in the first pass, 5/6 in `--trials 6`. Misses: two dropped letters (`KHPY-96`, `CTSG-94`), one inserted (`TQQUEZ-88`) | `r1-2026-09-28-groq.json`, `…-vision-webp.json` |
| **Vision, PNG** | **6/6 exact** | `…-vision-png.json` |
| **Grounding, landscape 1280×720** | **24/24** points inside the target under 0–1000 **of the longer side**; 0/24 under pixels or per-axis 0–1000. 20 points on the fixture button, 4 on distinct grid targets. Grid fit: x scale 1277, y scale 1275 (≈ 1280), max residual 4 px | `r1-2026-09-28-groq.json`, `…-grounding-grid.json`, `…-vision-*.json` |
| **Grounding, portrait 720×1280** | **0/4 under every convention.** x roughly per-axis (fit scale 692 ≈ 720, residual 4.8 px); y inconsistent (fit residual 484 px), e.g. the purple circle at y=998 px answered y=378 | `…-grounding-grid.json` |
| 429s | 19 in the decision run (all retried); 6 in the grid; 11 and 12 in the vision runs, all at the 8K TPM limit and all resolved by waiting `retry-after` | all |
| Transport | 7/20 trial calls failed before any HTTP status in the first pass (1 DNS failure on the client, 1 TLS timeout, 1 reset, 4 closed); **0** in every later run (32 image calls) | `r1-2026-09-28-groq.json` |

The PNG-versus-WebP difference (6/6 against 11/14) points to lossy compression, but n=6 can't
show it: a 6/6 run has about a 1-in-4 chance even at the WebP rate. Portrait grounding: one call
per target, so it shows the convention fails, not how often.

### Gateway → Groq, live (the second pass)

The gateway ran in `AEGIS_MODE=live` with the settings from `model.env.example`,
`AEGIS_LOG_PAYLOADS=true`, and the **rotated** key. Report:
`tools/vlm/reports/r1-2026-09-28-groq-gateway-live.json`.

| Check | Result |
|---|---|
| Authentication | ✅ Groq answered 200 to the gateway's bearer-key requests |
| Image input | ✅ R-2 check (three nameless buttons; only the pixels identify the right one): **2/3 picked `n-b2`**. One answer's `done` summary names the "red ZEBRA-42 banner", text that exists only in the image. The third run was a 429 (below) |
| Response parsing + validation | ✅ Both image answers and the one text answer parsed as JSON, and were normalized (server-set `step_id`, `plan_id: p-1`), schema-validated and post-validated before being returned. The model's bare `USERNAME#1` came back as `⟪USERNAME#1⟫` |
| Bounded retry, live | ✅ Once: a 429 with `retry-after: 3` → wait 3 s → 200 on attempt 1. A 429 with `retry-after: 12` (> 10) failed fast as `503 MODEL_UNAVAILABLE upstream_429` |
| R-3 text check (login, 10 runs) | ❌ **Not completed.** First batch 0/10, second 1/10: every other call got `503 upstream_429`. The one 200 typed the ref but didn't also click Sign in |
| Why the 429s | Groq's 429 body, read with one direct request: **`tokens per day (TPD): Limit 200000, Used 199490, Requested 982`**. The day's organization budget was spent, mostly by this R-1 day's probe runs. The per-minute headers at the same moment showed 8000/8000 tokens free |
| Privacy (log scan) | ✅ In both gateway logs (23 payload lines): key 0 hits, `gsk_` 0, WebP base64 (`UklGR`) 0, and image steps carried the `<N b64 chars>` marker. All six reports: `gsk_` 0 |

Only synthetic data was sent (the fixture images, a made-up login form). The exposed key was
never used for a test call. One read-only `/models` request did go out with it, before the
rotation was confirmed; it showed the key was still active at that point.

## Tests

| Suite | Kind | Result |
|---|---|---|
| Gateway pytest, 119 tests (`server/gateway/.venv/bin/python -m pytest -q`) | **Mocked**: fake `httpx.AsyncClient` or fake `VLLMClient.complete`, replay mode, or a stub URL. No test calls Groq | **119 passed** (was 69) |
| — new: `test_model_client.py` (rewritten, 28), `test_normalize.py`, `test_model_facing_schema.py`, `test_prompt_image.py`, `test_payload_logging.py`, `test_route_model_output.py` | mocked | pass |
| — updated: `test_replay.py`, `test_e2e_subprocess.py` (the response now has `plan_id: "p-1"`) | mocked | pass |
| Extension node suite (`pnpm exec vitest run --project node`) | mocked | **564 passed**, including the new `StepFailedError` cases in `gateway-client.spec.ts` and `session.spec.ts` |
| Extension `tsc --noEmit`, `check:no-network`, eslint on the changed files | static | clean |
| Gateway ruff | static | 13 E501s, all pre-existing: 12 in the generated `protocol/*.py`, 1 in an old assertion in `test_model_client.py` |
| Local end-to-end: real uvicorn gateway → a local fake OpenAI server, over HTTP | **integration, no Groq** | ✅ The upstream saw a bearer key, `response_format: json_object`, `max_tokens: 512`, one system message, no `chat_template_kwargs`, and the WebP as an `image_url` part; the log had no key or image bytes |
| `smoke.py` probes (5 reports) | **live Groq** | see Measured results |
| `r2_live_check.py --runs 3`, `r3_live_check.py --runs 10` ×2 | **live Groq via the gateway** | 2/3; 0/10 and 1/10 (TPD exhausted) |

## Acceptance

- [x] `smoke.py` and `config.py` defaults match the decision table.
- [x] `server/deploy/model.env.example` exists; `server/deploy/model.env` is ignored
  (`git check-ignore`), mode 600, and holds a rotated key. The exposed key was removed.
- [x] Probe report with text and vision passing, n=10 latency (10/10), and no key or image bytes
  (`grep -c "gsk_\|base64"` → 0 in every report).
- [x] `DEPLOYMENT.md` §3 matches this file.
- [x] The `R1-model` Decision-log row in `tasks.md` has the measured numbers.
- [x] The gateway pytest suite is green (119).
- [x] **The gateway authenticates with Groq and sends the image** (live, 2/3 image-only picks).
- [x] **json_object answers are normalized and validated**, never trusted (mocked cases in
  `test_route_model_output.py`; live answers passed validation).
- [ ] **Live gateway check at n=10 (R-3's `ok=10/10`): not met.** The daily token budget ran out
  mid-check (1/10). Re-run when the budget has recovered.
- [ ] **`rate_limited_429_total` = 0: not met, and can't be on this tier.** The 8K TPM makes 429s
  routine (handled by waiting `retry-after`), and 200K TPD per organization caps the day at about
  80 image steps.
- [ ] **json_schema enforced: not met.** Groq rejects strict mode for this schema. `json_object`
  plus gateway validation is the replacement.
- [ ] **One grounding convention: not met.** Landscape is consistent (longer side, 24/24);
  portrait fails (0/4).
- [ ] **Stable vision: partly met.** WebP 11/14 (79 %), PNG 6/6.
- [ ] **Zero Data Retention: not verified.** How to enable it is in `DEPLOYMENT.md` §3; nobody has
  checked the team account.

**R-1 stays open.** Closing it needs the n=10 live gateway check, plus an explicit team decision
to accept the three tier-inherent misses (429s, no enforced schema, portrait grounding) with the
mitigations above.

## Open items

1. **Re-run the live gateway checks** once the rolling daily budget recovers. Most of the 200K
   was spent between about 17:25 and 18:31 UTC on 2026-09-28, so the full budget is back by
   about 18:31 UTC on 2026-09-29. Run nothing else on the organization in between:
   ```bash
   python3 server/gateway/scripts/r3_live_check.py --runs 10 --pause 20
   python3 server/gateway/scripts/r2_live_check.py --runs 3 --pause 20
   ```
   Record the results in `tools/vlm/reports/`, and tick the box above only if `ok=10/10`.
2. **Budget discipline.** Each full `smoke.py --runs 10 --trials 10` costs about 60–70K tokens, a
   third of the organization's day. Run probes only when something changed.
3. **Preview model risk.** Groq may withdraw `qwen/qwen3.8-27b`; there is no other vision model on
   Groq. The fallback is replay.
4. **ZDR:** enable it and verify it in the console (Settings → Data Controls), then record the date
   in `DEPLOYMENT.md`.
5. **Key hygiene:** confirm that the exposed key is deleted in the console (not just replaced in
   the file). A `/models` call made with it before the rotation still returned 200.

## Follow-up for R-2, R-3 and R-12

- **R-2, still to do:**
  - §7 extension session metadata (A12: `l1_image: false`, `policy: 'phase2-none'`);
  - the "extension node tests" box.

  The gateway half (§1–6), its tests and its live check (`scripts/r2_live_check.py`) are done;
  its live box needs 3/3 once the budget allows.
- **R-3, still to do:**
  - A7–A9 (full snapshots, `nodes_by_id`, `render_elements` with the new-node flag);
  - the rest of A10 (`prompt_view`, `changed_ids`, the prompt-size log);
  - A11 (the rate-limit leak);
  - Part B (the extension sends full snapshots, A17);
  - `test_full_snapshot_prompt.py` and `test_rate_limit_cleanup.py`.

  Done here: A1–A6, and A10's normalize/validate/retry, with the spec's tests. Note for A10: the
  live answer that typed the ref and stopped is what the full-page view and history are meant to
  improve.
- **R-12:** add the longer-side convention for landscape. `rel1000_long`:
  `x_css = region.x + x/1000 · max(region.w, region.h)`, and the same for y. It fits within 4 px.

  For portrait, no convention fits. Either:
  - pad portrait captures to a landscape/square canvas before sending, then re-measure with
    `smoke.py --grounding-grid`; or
  - have the client refuse `click_point` when the image region is portrait.

  Either is an R-12 decision; nothing in its contract was changed here.
- **Vision (for R-9/R-10, not R-1):** if code-word misreads matter for a demo, measure a higher
  WebP quality in `perception/compose/compositor.ts:encodeWebp`. The wire format stays
  `image/webp` (the schema requires it).
