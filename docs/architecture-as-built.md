# AEGIS — architecture as built

**Date:** 2026-10-10 (updated after the fix pass the same day) · **Source:** the code in `AEGIS/` only. Older docs (`architecture.md`,
`design.md`, `planning/`) describe the original plan. Where they disagree with this file, this file
follows the code. Defects found while writing it are in [audit-2026-10-10.md](audit-2026-10-10.md).

## 1. What it is

AEGIS is a Chrome/Firefox MV3 extension that carries out a typed task ("search for X and tell me the
price") on the open web page. Each step it reads the page (DOM and a screenshot), redacts sensitive
data **on the device**, sends the redacted step to a vision LLM, and runs the returned actions on the
page. Sensitive values reach the model only as sealed placeholders (`⟪AADHAAR#2⟫`). When the model
types a placeholder, the real value is filled in locally from an in-memory vault.

## 2. Two builds, two behaviours

The release and dev builds differ in ways that matter for debugging. A bug that only shows in
release cannot be reproduced with the dev harness.

| | Release (`pnpm build`) | Dev (`wxt build --mode development`, `wxt`) |
|---|---|---|
| Model path | Always in-panel agent → the chosen provider's API with the user's key | In-panel agent if a key is saved, otherwise the legacy Python gateway (`:8787`) |
| Provider / model | Google Gemini (default, Flash-Lite first), Groq, Mistral or OpenRouter (`src/host/egress/providers.ts`); model picked by "Test key"; on Gemini the client moves to the next model when one's daily quota runs out | Same, plus `modelUrl` / `modelName` overrides from Settings |
| Host permissions | `<all_urls>` **required** + the three model APIs | `<all_urls>` required |
| Screenshot permission | Required `<all_urls>` (works on every site; measured 2026-10-10). `activeTab` + toolbar click only if the user restricts site access | Same |
| CSP `connect-src` | `'self' https://api.mistral.ai https://generativelanguage.googleapis.com https://api.groq.com https://openrouter.ai` | Also `localhost:*` and `127.0.0.1:*` |
| NER profile | S, a no-op (no model shipped) | S or L (L = 950 MB local model, not shipped) |
| Ablation switch | Stubbed out at build | Available |

Source: [wxt.config.ts](../apps/extension/wxt.config.ts), [main.tsx:40-52, 435-440, 495-500](../apps/extension/entrypoints/sidepanel/main.tsx#L40-L52).

## 3. Runtime contexts

```
 ┌─────────────────────────── browser tab (any http/https page) ───────────────────────────┐
 │  content script (top frame)                    child frames: handshake responder only   │
 │  src/content/**                                                                         │
 │   • screen graph extractor (DOM walk, roles, accessible names, boxes, field semantics)   │
 │   • text runs, Channel D field classification, CAPTCHA detection                         │
 │   • Mutation/Resize/scrollend/focus observers → auto-send graph deltas                   │
 │   • action executor (synthetic pointer/key/input events, preflight hit-test)             │
 │   • never reads .value of password/OTP/CVV/card fields; no network                      │
 └───────────────▲─────────────────────────────────────────────────────────────────────────┘
                 │ runtime.Port "aegis" (host connects; buffered until Session exists)
 ┌───────────────┴──────────────── side panel / sidebar (the "host") ──────────────────────┐
 │ entrypoints/sidepanel/main.tsx  ── Preact UI + all wiring (1,083 lines)                  │
 │ src/host/session.ts             ── step loop orchestrator (1,349 lines)                  │
 │ src/host/privacy/**             ── vault, placeholders, fusion, context builder, guard   │
 │ src/host/agent/**               ── prompt, plan normalise/validate, token budget         │
 │ src/host/egress/**              ── the ONLY fetch: model-client (BYOK) / gateway-client  │
 │ src/host/capture/**             ── captureVisibleTab of the task tab, activeTab grant gate│
 │ src/host/actions/**             ── plan validator, risk/confirmation, rehydration        │
 └───────▲──────────────────────────────────────────────▲──────────────────────────────────┘
         │ postMessage (ImageBitmap transfer)            │ HTTPS (only guarded payloads)
 ┌───────┴──────── perception Web Worker ───────┐   ┌───┴────────────────────────────────┐
 │ src/perception/** (ONNX Runtime Web)          │   │ Mistral/Gemini/Groq/OpenRouter (OAI- │
 │  YuNet faces · CLIP ViT-B/32 image classes ·  │   │ compatible, user's own key; dev:    │
 │  PP-OCRv5 det + rec (latin, devanagari) ·     │   │ server/gateway FastAPI, old prompt  │
 │  compositor (WebP + id tags) · halo rescan    │   │ re-implemented in Python)           │
 └───────────────────────────────────────────────┘   └─────────────────────────────────────┘

 background service worker (entrypoints/background.ts): opens the panel on toolbar click (this
 grants activeTab), records the grant in storage.session, relays permission removal (the panel stops
 the task if its site access is removed), drops a closed window's saved task and task-box draft.
```

One Session and one vault exist **per task**. The perception worker lives as long as the panel:
it starts (and loads the ~110 MB of models) when the panel opens, and a `reset` message after each
task drops that task's last capture and cached per-region findings. It is recreated only when the
backend or NER setting changes ([main.tsx:489, 642, 707-713](../apps/extension/entrypoints/sidepanel/main.tsx#L489)).

### Closing the panel

Closing the panel ends its page, and with it the task (Session, vault, model session, worker). What
survives is the panel's **view** of the task: [host/saved-task.ts](../apps/extension/src/host/saved-task.ts)
saves the task text, tab, panel state, run log and sanitized HISTORY to `storage.session` (memory
only), one record per window, at most every 400 ms and on `pagehide`. A reopened panel restores
it; a record left in a running state shows as **Interrupted** with Resume and Dismiss. Resume calls
`handleStart` with the record: same tab (or the active one if it closed), run log kept, and
`Session` gets `resume: { history, stepsDone }`, so step ids continue and the model sees the earlier
HISTORY with sealed refs reduced to their type (a fresh vault, fresh budgets). The background
removes a window's record when the window closes. Records stay under 4 MB by dropping older
screenshots, then older payloads. The text in the task box (run or not) is saved the same way, per
window, on every change (`aegis.draft.<windowId>`), and put back when the panel reopens; Dismiss
leaves it, closing the window drops it.

## 4. Task start (main.tsx `handleStart`)

1. Release only: refuse if no API key is saved.
2. Resolve the target tab: the active tab, or `targetTabId` from the harness hook. It must be http(s).
3. `ensureTaskPermissions`: ask for `<all_urls>`; if declined, ask for this origin only.
4. Wait up to 2.5 s if the tab is still loading.
5. `connectToLiveContent`: connect the port and wait 1.5 s for `ready`. If none comes, inject the
   declared content script and retry once.
6. Open a model session (local for BYOK; HTTP with 6 back-off attempts for the gateway).
7. Reuse the panel's perception worker (normally already loaded; specs in
   `perception-client/model-specs.ts`).
8. Build `Session` with injected deps: content port, `sendToGateway`, `confirm`, `askUser`, gated
   capture, `browserControl` (navigate/open_tab/back/forward/reload via `tabs` API), `reconnect`
   / `followOpenedTab` (re-attach after navigation or a new tab), and policy.
9. `await session.start(task)`, then clean up in `finally`: remove listeners, disconnect the port,
   close the model session, `reset` the worker. Stop settles every open card (confirm, question,
   grant) and `Session.cancel()` rejects every pending wait, so cleanup always runs.

## 5. The step loop (session.ts)

`start()` loops `runStep()` until a terminal controller state. A step that fails returns
`'failed'`, and the next step re-observes from scratch. Five failed steps in a row →
`RECOVERY_EXHAUSTED`.

```
runStep(n)
 ├─ budgets: steps ≤ 30, wall clock ≤ 10 min
 ├─ OBSERVE    follow a newly opened tab / reconnect after navigation (≤ 4 re-attaches)
 │             await-ready (page visually complete, 8 s first / 3 s later) → request graph
 │             (12 s timeout: a silent content script is re-attached and re-injected)
 │             same page as before the last plan → HISTORY gets "no visible change"
 │             pageNodes = every node seen on this document (deltas folded into allSeenNodes)
 ├─ CAPTCHA?   hand to user, poll every 2 s up to 5 min
 ├─ PERCEIVE   (every step; no text-only path)  up to 4 attempts:
 │               capture task tab (if the user is on another tab: pause until they return)
 │               geometry digest of stable text-bearing nodes present before AND after
 │               (pictures, animated and newly arrived nodes excluded) → mismatch = retry
 │               worker.perceive: whole-frame faces + text detection, then crops (≤ 2.5 s)
 │             no redacted-capable capture after 4 tries → step 'failed', nothing sent
 ├─ NER        worker.ner over free text — only when profile L is active (dev); skipped in release
 ├─ SANITIZE   buildSanitizedContext: Channel D + T (+N, +V) → fuse → vault mint → substitute
 │             tighten text-run redaction boxes to measured character rects (content script)
 │             attachImage: compose redacted WebP (clear-by-default if whole-frame passes OK,
 │             else grey-by-default with DOM-based clearance), masked sensitive fields, then
 │             Set-of-Marks: yellow `eN` tags on the listed interactive elements
 ├─ GUARD      schema → id shapes → vault leak sweep → pattern re-sweep → image re-scan
 │             (OCR ring around boxes, recompose) → canaries (harness only)
 │             PATTERN/VAULT_LEAK → one repair (seal flagged strings) → guard again
 │             still blocked → step 'failed', nothing sent
 ├─ SEND       sendWithRetry: ≤ 6 attempts, Retry-After honoured up to 65 s, reopen session
 │             on 404/409. UNSANITIZED_CONTEXT → re-seal and resend once. PLAN_INVALID / too
 │             large → this step fails (HISTORY says why), the task continues
 │  └─ (BYOK) agent engine: tripwire → prompt (profile + model notes) → model-client
 │             (token bucket pacing, 429 retries, 413 → rebuild smaller ×2) → normalise
 │             (op aliases, truncation, ≤5 actions) → validate → one corrective retry
 ├─ VALIDATE   extension validator: schema, step lease, hard denials (CAPTCHA target, own UI)
 └─ ACT        per action: done/stop/report/ask_user/wait (host) · navigate/open_tab/back/...
               (tabs API; cross-origin asks the user) · type-with-ref (rehydration: confirm
               for CRITICAL, 6 checks, then dispatch real value) · page actions (risk check →
               confirm → content dispatch, 15 s result timeout; a target=_blank link is
               handed back and opened by the host) → settle (≤ 2.5 s); the tab-level load
               wait runs only when a navigation is pending
```

## 6. What the model actually receives

Built on the device by [agent/prompt.ts](../apps/extension/src/host/agent/prompt.ts), in one of
two profiles chosen by the provider: `rich` (Mistral, Gemini, OpenRouter) or `compact` (Groq's ~8K
tokens/minute free tier). The Python gateway (dev only) still builds the old compact prompt.

| Part | compact | rich |
|---|---|---|
| System message | fixed per profile: privacy rules, reply shape `{"thought","notes","actions"}`, batching, recovery, answer rules | same |
| `TASK`, `PAGE` (sanitized title), `NOTES` (the model's own memory from its last reply) | yes | yes (notes up to 1,500 chars) |
| `HISTORY` | last 5 steps | last 8 steps |
| `ELEMENTS` | 45, names ≤ 50 chars | 90, names ≤ 80 chars |
| `TEXT` | 10 visible runs × 120 chars | up to 70 runs × 300 chars, ≤ 7,000 chars, visible first then `↓`/`↑` off-screen |
| Report length | ≤ 150 words | ≤ 400 words |
| `max_tokens` | 900 | 2,000 (Gemini 4,000: its thinking counts) |
| click_point units | 0–1000 of the long side (qwen) | image pixels (Mistral, OpenRouter); 0–1000 of width / height (Gemini) |

Every step also carries the redacted WebP (long side ≤ 1,280 px) with `eN` id tags drawn on the
listed elements. Not sent: the URL or origin (OQ-11), off-screen text beyond one screen, page
category. `temperature 0.2` (Gemini 1.0, as Google advises for Gemini 3), `json_object`, provider-specific extras
(Groq: `reasoning_effort: none`; Gemini: `reasoning_effort: low`, since Gemini 3 cannot turn thinking off).

## 7. Privacy pipeline

| Channel | Where | What |
|---|---|---|
| D — DOM semantics | content `detect/field-semantics.ts`, `channel-d.ts`, `protected.ts` | Field type from label/autocomplete/type. Protected fields are never `.value`-read (presence only) |
| T — text patterns | `packages/recognizers` | Aadhaar (Verhoeff), PAN, GSTIN, card (Luhn), IFSC, UPI, phone, email, DOB, PIN, passport, vehicle, secrets; label-bound values ("Mobile: …") |
| N — NER | `perception/models/pii-ner.ts` | Profile S returns nothing. Profile L is dev-only (WebGPU, 950 MB) |
| V — vision | worker | Faces (YuNet), image class (CLIP: ID document, QR, signature…), OCR text → recognizers |

Fusion (`privacy/fusion`) merges candidates, sets each region's class from the policy
(`packages/policy/policies/default.policy.json`) and dilates the boxes. The vault (`privacy/vault`)
mints refs per origin, holds values in memory only and is cleared at stop or cancel. The guard
(`privacy/guard/guard.ts`) is the single choke point: only its branded output (a `WeakSet` brand) is
accepted by egress. The agent engine runs an independent tripwire (`agent/tripwire.ts`) before any
model call.

Image composition: if the worker's whole-frame face and text passes both completed, the screenshot
is sent **clear-by-default**: only redaction boxes are black and unanalysed areas grey. Otherwise it
is **grey-by-default**: only DOM boxes proven clean are copied from the capture.

## 8. Failure handling (what stops a task)

| Condition | Result |
|---|---|
| User Stop | `CANCELLED`; every wait unwinds and cleanup runs |
| Steps > 50, wall clock > 20 min | `STEPS_EXCEEDED` / `WALL_CLOCK_EXCEEDED` |
| 5 consecutive failed steps (no screenshot, guard block, page crash, transient server failure, failed action) | `RECOVERY_EXHAUSTED` |
| Non-retryable model error: 401/403 key, other permanent 4xx, Retry-After > 65 s (daily quota) | `SERVER_ERROR` (task ends) |
| PLAN_INVALID, 413 after rebuilds | that step fails; the next prompt says why |
| Site access removed during the task | `PAGE_DISCONNECTED` |
| Model `stop` / `done` | `MODEL_STOPPED` / `DONE` |
| User denies a confirmation / gives no answer | `USER_DECLINED` / `NEEDS_USER` |
| CAPTCHA not solved in 5 min | `CAPTCHA_DETECTED` |
| Tab closed, non-web page, no host permission after navigation | `PAGE_DISCONNECTED` |
| Panel closed | Task ends with the page (no stop event); reopened, it shows **Interrupted** with Resume (§3) |

## 9. Contracts

- **Network:** `packages/protocol/schema/*.json` (JSON Schema 2020-12) → generated TS (`src/generated`)
  and Pydantic models. `SanitizedContext` is the step request, `ActionPlan` the response.
- **Host ↔ content:** [shared/messages.ts](../apps/extension/src/shared/messages.ts): `extract`,
  `dispatch-action`, `await-ready`, `measure-spans`, `ping` / `graph`, `action-result`, `settled`,
  `page-ready`, `span-boxes`, `ready`.
- **Host ↔ worker:** [shared/worker-protocol.ts](../apps/extension/src/shared/worker-protocol.ts):
  `init`, `perceive`, `compose`, `rescan`, `ner`.
- **Lint-enforced boundaries:** `fetch` only in `src/host/egress/` (`scripts/check-no-network.ts`);
  host never imports `src/perception/**`; `packages/` have no browser APIs.

## 10. Repository map

| Path | Role | State |
|---|---|---|
| `apps/extension` | The product | Typecheck, lint and 1,079 tests (unit + browser) pass (2026-10-10) |
| `packages/recognizers`, `policy`, `protocol` | Pure TS libraries | Used by the extension |
| `server/gateway` | FastAPI gateway: prompt, Groq/vLLM client, replay | Dev and eval only. Duplicates `src/host/agent` in Python |
| `eval/` | Playwright harness, 166 labelled screens, scorers | Last run (2026-09-29) produced no metric values |
| `tools/e2e/` | `probe_site.py` (visible runs), `run_demo.py`, `release_smoke.py`, `fake_vlm.py` | Probe uses the dev build and, by default, the gateway |
| `tools/models/`, `public/models/` | Model export/quantise; 8 shipped files (~110 MB, 88 MB of it CLIP) | Checked by `verify:models` |
| `demo/` | Static demo pages | Used by `run_demo.py` |
| `docs/` | This file, the audit, guides (`docs/guides/`), requirements, design, planning | Tracked in git since 2026-10-25 |

## 11. Built but not wired

These modules are implemented and covered by their own tests, but no production code path calls
them (checked by import reachability from `entrypoints/` on 2026-10-25). They are kept deliberately
for later work; do not read their tests as evidence that the behaviour runs in the product.

| Module | What it does | Note |
|---|---|---|
| [host/perception-client/probe-cache.ts](../apps/extension/src/host/perception-client/probe-cache.ts) | Caches the resolved WebGPU/WASM backend in `storage.local` | The worker re-probes on every load |
| [host/privacy/fusion/decompose.ts](../apps/extension/src/host/privacy/fusion/decompose.ts) | Rectangle decomposition of a box union (≤4 rects) | Compositor geometry, design.md §7.1 step 5 |
| [host/privacy/fusion/dilate.ts](../apps/extension/src/host/privacy/fusion/dilate.ts) | Box dilation clamped against siblings; token expansion | The image rescan uses its own `dilateForRescan` |
| [perception/detect/text-region.ts](../apps/extension/src/perception/detect/text-region.ts) | Detection-side OCR of regions the DOM never explained | The worker reads picture text inline instead |
| [perception/models/masked-glyph.ts](../apps/extension/src/perception/models/masked-glyph.ts) | Finds visible "••••" masking in custom widgets | Native password inputs are covered by Channel D |
| [perception/models/script-route.ts](../apps/extension/src/perception/models/script-route.ts) | Picks the Devanagari recognizer from page `lang` | OCR always uses the Latin recognizer today |
| [perception/preprocess/dhash.ts](../apps/extension/src/perception/preprocess/dhash.ts) | Perceptual hash for a crop cache | `region-cache.ts` keys by exact pixel bytes (`pixelKey`) |
| [perception/schedule/deadline.ts](../apps/extension/src/perception/schedule/deadline.ts), [ladder.ts](../apps/extension/src/perception/schedule/ladder.ts), [queue.ts](../apps/extension/src/perception/schedule/queue.ts) | Per-frame deadline runner, degradation ladder, priority queue | The worker enforces its deadline inline in `handlePerceive` |
| `checkHalosForText` in [perception/rescan/halo.ts](../apps/extension/src/perception/rescan/halo.ts) | Halo OCR over decoded WebP bytes | The worker uses `readHaloText` from the same file |

