# AEGIS

**A privacy-preserving browser agent with on-device visual perception.**

*Smart India Hackathon 2026 — Problem Statement 26171*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

AEGIS is a browser extension that lets a remote AI model drive web tasks on a user's behalf —
filling forms, navigating government and financial portals, completing multi-step workflows —
**without that model, or the server hosting it, ever seeing the user's sensitive data.**

Today's browser agents send a full screenshot or DOM dump to a remote model on every step. If that
page shows an Aadhaar number, a bank balance, a password field or a face, the model sees it, and so
does every system between the browser and the model: the API gateway, the inference server's logs,
any third party the provider shares data with. AEGIS removes that trust requirement entirely. The
server can be assumed **hostile** — compromised, logging everything, run by an adversary — and the
user's sensitive values still never leave the device.

It does this with two ideas working together:

- **Local, dual-channel detection.** Every screen is read twice: once through the DOM/accessibility
  tree (structure, field types, ARIA roles), once through an on-device vision model (faces, OCR,
  layout). What either channel finds is fused into one picture of what's sensitive — canvas
  widgets, scanned PDFs and images are covered, not just plain HTML forms.
- **Typed sealed placeholders.** A detected value is never sent as-is and never simply deleted. It
  is replaced with a typed reference — `⟪AADHAAR#2⟫`, `⟪PASSWORD#1⟫` — that keeps the remote model
  reasoning about *what kind of thing* is there and *where*, without ever learning the value
  itself. When the model's plan calls for typing that value back into the page, an in-memory vault
  resolves the reference to the real value **locally, inside the browser, under a confirmation
  policy** — the round trip to the server never carries it.

## Install and use

AEGIS is a single extension: **install it, paste your own [Groq API key](https://console.groq.com/keys),
run a task.** Every on-device model is inside the package and there is no server to set up. The key
stays in your browser and is sent only to `api.groq.com`; only redacted pages ever leave your device.
See [DEPLOYMENT.md](DEPLOYMENT.md) (building and publishing a release) and [PRIVACY.md](PRIVACY.md).

## Key features

- **Dual-channel PII detection** — DOM/accessibility signals (Channel D) and on-device computer
  vision (Channel V: face detection, OCR, Channel T: free-text pattern recognition) fused into a
  single detection surface, so sensitive values are caught whether they're a form field, a photo,
  a canvas-rendered app, or text baked into a scanned PDF.
- **13 built-in entity recognizers** with real checksum validation — Aadhaar (Verhoeff), PAN,
  GSTIN, IFSC, UPI VPA, card numbers (Luhn), phone, email, passport, vehicle registration, PIN
  code, date of birth, and generic secrets — plus context-boosted scoring and a policy-driven
  threshold system.
- **Typed sealed placeholders**, not blackout. The remote model keeps enough structure to reason
  correctly about the page (`⟪AADHAAR#2⟫` is still "an Aadhaar number, in this field") while never
  receiving the actual value.
- **An in-memory vault** with a minimal, audited surface — no serialization, no iteration beyond a
  guard-only normalized-value check — that resolves placeholders back to real values only for
  actions the user has confirmed, and only inside the browser.
- **An additive image compositor.** The image sent to the server is built up only from regions
  positively cleared as safe; everything else stays grey by construction. A crash, a timeout, or a
  missing model degrades to *more grey*, never to *more content* — privacy fails closed.
- **A single egress choke point.** All network calls are confined to one module
  (`apps/extension/src/host/egress/`), enforced by a custom ESLint rule, not just a convention.
  Before a payload reaches it, an independent guard re-scans the final bytes for anything the
  detectors missed and blocks the request outright if it finds a survivor.
- **Session-scoped, audited un-redaction.** A user can deliberately reveal a specific redacted
  value to the model for a later step — logged with a reason, never retroactive, never touching an
  already-sent payload.
- **CAPTCHA hand-off, not CAPTCHA solving.** The agent detects reCAPTCHA/hCaptcha widgets and stops
  immediately, before any payload is built, handing control back to the user — solving one is an
  explicit non-goal.
- **An independent evaluation harness.** A separate Python auditor re-implements the entity
  recognizers from scratch and re-scans every outbound payload for leaks the client's own code
  could not see — so the system doesn't grade its own homework.

## How it works

```
page → screen graph (DOM + a11y + exact geometry) ┐
                                                   ├→ fusion → typed placeholders → egress guard → server
     → local vision (faces, ViT screening, OCR) ──┘                                      │
                                                                                     action plan
       real value ← vault ← rehydration (type-matched, origin-bound, confirmed) ←────────┘
```

1. **Observe** — a content script walks the live page's DOM and accessibility tree, extracting a
   typed screen graph (roles, names, geometry, affordances) with no network access of its own.
2. **Perceive** — a dedicated Web Worker runs on-device inference (face detection, OCR, region
   screening) over a captured frame, backed by WebGPU where available and WASM everywhere else.
3. **Fuse** — DOM signals and vision detections are merged by entity and region, arbitrated against
   a versioned policy (`packages/policy/`) that maps entity types to sensitivity classes and
   confidence thresholds.
4. **Sanitize** — every detected value is minted into a typed placeholder by the vault (same real
   value → same placeholder, deterministically, for the life of the session) and substituted into
   the outgoing context; the outgoing image is composited additively from cleared regions only.
5. **Guard** — an independent re-scan of the final, fully-assembled payload checks for any raw
   value that slipped through. Any survivor blocks the send outright — fail closed, not fail open.
6. **Reason** — the sanitized context, and only the sanitized context, goes to the remote model
   (an open-weights vision model on Groq, called directly from the extension with the user's own
   API key), which returns a constrained action plan referencing page elements and placeholders.
   The extension builds the prompt and validates the plan itself; no server sits in between.
7. **Act** — the client validates every planned action against the live page (does this element
   still exist, is it still visible, is it still the same origin) before dispatching it, and
   resolves any placeholder argument back to its real value from the vault — locally, and only for
   actions the confirmation policy has cleared.

## Privacy invariants

These are enforced, not just documented:

- Sanitization happens **before** any network request — no debug flag, no code path, skips it.
- `fetch` / `XMLHttpRequest` / `WebSocket` exist **only** inside `apps/extension/src/host/egress/`,
  checked by a custom ESLint rule that scans for violations and verifies the egress module itself
  genuinely makes a network call (a positive check, not just a negative scan).
- The content script never reads `.value` of password, OTP, CVV or card-number fields — those
  fields are presence-only signals (`{kind: 'presence', entity, len}`), the raw characters are
  never extracted at all.
- The vault is in-memory only. It exposes no `toJSON`, no `entries()`, no iteration except one
  guard-only normalized-value check used purely to catch leaks, never to read a value out.
- Everything fails **closed**: a worker crash, an inference timeout, a missing model or a denied
  permission yields grey pixels and a blocked request, never a fallback to raw content.

## Tech stack

| Layer | Technology |
|---|---|
| Extension | TypeScript (strict), [WXT](https://wxt.dev/) + Vite, [Preact](https://preactjs.com/), Manifest V3 (Chrome & Firefox) |
| On-device inference | [onnxruntime-web](https://onnxruntime.ai/) (WebGPU → WASM fallback), a bundled YuNet face detector and PP-OCRv5 detection/recognition models |
| Contract | JSON Schema (draft 2020-12) as the single source of truth — TypeScript types, Ajv validators and Pydantic v2 models are all generated from it |
| Planning model | Groq (OpenAI-compatible API), open-weights `qwen/qwen3.8-27b`, bring-your-own-key, called from the extension |
| Legacy gateway (dev / eval only) | Python 3.12, [FastAPI](https://fastapi.tiangolo.com/), Pydantic v2 — the pre-release server path, not part of a release |
| Evaluation harness | Python, [Playwright](https://playwright.dev/) (real headless Chromium), an independently re-implemented recognizer set for auditing |
| Tooling | pnpm workspaces (JS/TS), `uv` workspaces (Python), ESLint (custom dependency-boundary + no-network rules), Vitest (jsdom + real-browser projects), pytest |

## Project structure

```
apps/extension/        Browser extension (WXT + Preact), organised by JS runtime context:
  src/content/            page frames — DOM extraction, no pixels, no vault, no network
  src/host/               side panel — owns the vault, guard, egress, controller, UI
    agent/                  prompt building, plan validation, session state (no network code)
    egress/                 the only network code: the Groq client, guarded-payload check
  src/perception/         dedicated Web Worker — the only place raw pixels live, no network
  src/shared/              types shared across contexts that cannot import each other
  src/ui/                  panel components (payload viewer, settings, confirmations)
packages/
  protocol/               JSON Schemas + generated TS types / Ajv validators / Pydantic models
  recognizers/             pure-TS entity recognizers (Aadhaar, PAN, GSTIN, card, phone, ...)
  policy/                  versioned policy JSON + typed accessors
server/
  gateway/                FastAPI app: auth, sessions, prompt building, model client, replay store
  deploy/                 Dockerfiles and compose topologies (live vLLM, offline replay)
eval/                     Evaluation harness: fixture corpus, Playwright runner, metric scorers,
                          an independently-authored auditor
docs/                     Requirements, architecture, design, per-phase execution plans, task
                          board, build log, decision log, demo materials
```

## Getting started

**Prerequisites:** Node.js ≥ 22, [pnpm](https://pnpm.io/) 10+, Python 3.12, [`uv`](https://docs.astral.sh/uv/).

```bash
# Install JS/TS dependencies
pnpm install

# Regenerate the protocol contract (TS types + validators + Pydantic models)
pnpm gen:protocol

# Type-check and test everything
pnpm -r typecheck
pnpm -r test

# Build a release for Chrome and Firefox (checks every bundled model and the finished package)
pnpm build
# or individually:
pnpm --filter @aegis/extension build           # → apps/extension/.output/chrome-mv3
pnpm --filter @aegis/extension build:firefox   # → apps/extension/.output/firefox-mv3

# Load the unpacked chrome-mv3 (or firefox-mv3) folder as a temporary extension
# in chrome://extensions (Developer mode) or about:debugging (Firefox)

# Lint (includes the no-network-outside-egress boundary check)
pnpm lint
```

```bash
# Gateway server
cd server/gateway
uv sync
uv run pytest -q          # 67 passing
uv run uvicorn aegis_gateway.main:app --reload

# Evaluation harness
cd eval
uv sync
uv run pytest -q
uv run aegis-eval run --split dev   # drives the real extension against the fixture corpus
```

See [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) for the exact, currently-verified command set
and what each one is known to do in this environment.

## Status

Phase 7 (demo & submission) of 7. Phases 1–5 are complete; Phase 6's non-Firefox scope is complete
and verified; Firefox itself (AC-12) is genuinely blocked in the current build/CI environment — no
way to launch a Playwright-driven Firefox here, confirmed by trying rather than assumed. The full
privacy pipeline is real and running end to end: DOM extraction, on-device vision (face detection,
OCR), dual-channel fusion, typed-placeholder substitution, the vault, the egress guard, and action
dispatch back into the real page. See [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) for the
detailed state and [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## Evaluation results

All numbers below are cited from a specific report in `eval/reports/`, never rounded up or
re-derived. Full detail, methodology and honest caveats in
[docs/demo/judge-qa.md](docs/demo/judge-qa.md).

| Metric | Held-out split (n=38, one-time authorised run) | Dev split (n=166, re-run freely) |
|---|---|---|
| PII recall — structured entities | 0.803 | 0.798 |
| PII recall — free text | 0.250 | 0.250 |
| Redaction pixel precision | 0.981 | 0.981 |
| Over-redaction rate on hard negatives | 0.0000 | 0.0000 |
| Leak count | **0 / 36 payloads** | 1 / 156 payloads (disclosed `PIN_CODE` finding, see below) |
| Task peak RSS / CPU p95 | not measured on this split | 1123.8 MB / 35.0% |
| Task wall-clock p50 / p95 | not measured on this split | 1247.4 / 1658.6 ms |

**Task success with a live model (Metric 1) has not been measured, on any split.** This
build/CI environment has no GPU — `navigator.gpu.requestAdapter()` returns `null`, confirmed by
direct probe — so the two live-model runs Metric 1 requires have never executed (tracked as OQ-13
in [docs/DECISIONS.md](docs/DECISIONS.md)). Everything else above concerns the local
detection/redaction/action pipeline, which is real, measured, and independent of that gap.

The one disclosed leak (dev split, `PIN_CODE`, n=156) was found by an independently re-implemented
auditor recognizer set, not the client's own code — see
[docs/demo/judge-qa.md](docs/demo/judge-qa.md) §2 for the root cause and
[docs/HISTORY.md](docs/HISTORY.md) for the fix history.

## Known limitations

- **The guard can only find what its recognizers and detectors can find.** A PII type none of them
  knows about can pass through. This is a structural limit of a pattern/structure-based approach,
  not a bug — the residual risk is measured by the harness (see the leak counts above), and the
  independent auditor scans JSON text only, not image pixels (no OCR model in the auditor).
- **JavaScript offers no secure memory zeroing.** Vault values are ordinary strings kept in one
  module and reclaimed only through the browser process's normal memory lifecycle, not actively
  zeroed on eviction.
- **Task success with a live model (Metric 1) has never been measured** — no GPU in the
  build/CI environment (OQ-13). What's measured instead is the full local pipeline (detection
  through action dispatch), independent of model quality.
- **Firefox is currently untested (AC-12 open)** — genuinely blocked in this environment, not a
  design choice: Playwright's Firefox build isn't downloadable here and the system Firefox doesn't
  speak Playwright's automation protocol.
- **Face-detection accuracy is unverified against a real photograph** — no licensable face photo is
  reachable in this environment. The detection pipeline runs end to end against the real bundled
  model; only accuracy on real faces is untested.
- **No CLIP-family vision-language model exists in this build**, so zero-shot region screening and
  the screen-state label are real call shapes with no model behind them yet.
- **The visual PII category (face / ID document / signature / QR code) shows 0.000 recall** in
  every report produced so far — a disclosed corpus gap (no real example of any of these exists in
  either split), not a detector failure.
- WebGPU is an accelerator, not a requirement. The WASM path is first-class and slower; both are
  measured and reported. Firefox on Linux still needs a preference enabled for WebGPU, so it runs
  the single-threaded WASM path once Firefox itself is verified.

## Documentation

**Quick references (start here):**
- [DEVELOPMENT.md](DEVELOPMENT.md) — Setup, local dev workflow, common tasks
- [TESTING.md](TESTING.md) — Running & writing tests
- [API.md](API.md) — Legacy gateway API reference (dev / eval only)
- [DEPLOYMENT.md](DEPLOYMENT.md) — Building, verifying and publishing a release; bring-your-own-key setup
- [PRIVACY.md](PRIVACY.md) — What is sent, to whom, and what is never collected

**Design & architecture:**
- [docs/product-requirements.md](docs/product-requirements.md) — Features, requirements, acceptance criteria
- [docs/architecture.md](docs/architecture.md) — System design, contexts, model stack, layout
- [docs/design.md](docs/design.md) — Data models, algorithms, protocol, UI design
- [docs/DECISIONS.md](docs/DECISIONS.md) — Resolved open questions

**Planning & build log:**
- [docs/PLAN.md](docs/PLAN.md) — 7 phases and exit gates
- [docs/planning/](docs/planning/) — Phase-by-phase execution plans (implement from these)
- [docs/TASKS.md](docs/TASKS.md) — Task board
- [docs/HISTORY.md](docs/HISTORY.md) — Build log with measurements
- [docs/FEATURES.md](docs/FEATURES.md) — 105+ features with traceability

**Demo & metrics:**
- [docs/demo/demo-script.md](docs/demo/demo-script.md) — Demo walkthrough
- [docs/demo/judge-qa.md](docs/demo/judge-qa.md) — Honest limitations and measured numbers
- [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) — What exists now, verified commands

**Working in this repo:**
- [CLAUDE.md](CLAUDE.md) — How Claude works here; privacy invariants
- [AGENTS.md](AGENTS.md) — Agent guidelines

## Scope

Deliberately **not built**: mobile apps, multi-language UI, payments, RBAC or auth beyond a
session, model training or fine-tuning, blockchain, a second database, Kubernetes, CAPTCHA
solving.

## License

MIT — see [LICENSE](LICENSE). Third-party notices in [NOTICE](NOTICE).
