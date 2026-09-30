# CLAUDE.md — AEGIS

Guidance for Claude Code working in this repository.

## What this project is

AEGIS is a **privacy-preserving browser agent**: a browser extension that runs a vision model
locally, detects and redacts sensitive data **before any network request**, sends only anonymized
context to an open-weights server model, and executes the returned actions on the page — resolving
sensitive values back to real values **only inside the browser**.

The differentiating idea: **typed sealed placeholders** (`⟪AADHAAR#2⟫`) that the server can
reason about but never resolve, plus a local vault for **zero-egress task completion**.

## Requirement documents — the source of truth

Mirrored in `docs/` per architecture §15.1. Read them before making design decisions.

| Document | Path | Covers |
|---|---|---|
| Product Requirements | [product-requirements.md](docs/product-requirements.md) | Goals, FR-*/NFR-* requirements, scope tiers, acceptance criteria AC-1…AC-12, risks |
| Architecture | [architecture.md](docs/architecture.md) | Components, runtime contexts, model stack, server topology, repo layout, build order, open questions OQ-1…OQ-17 |
| Detailed Design | [design.md](docs/design.md) | Data models, JSON protocol, action DSL schema, algorithms (fusion, guard, compositor), UI, tests, harness |

**Never invent product behaviour.** If the requirement docs are silent, mark it `[A]` (assumption)
or `[OQ-n]` (open question) the way those docs do, and record it in [docs/HISTORY.md](docs/HISTORY.md).

## Working documents — in this repo

| Document | Purpose |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | Every feature that must be built, with ID, phase, tier and traceability to FR/NFR |
| [docs/PLAN.md](docs/PLAN.md) | Phased implementation plan, phase gates, cut order — the one-page view |
| [docs/planning/](docs/planning/) | **One detailed execution document per phase.** Implement from these: exact schemas, algorithms, task tables with acceptance criteria, milestone definitions |
| [docs/TASKS.md](docs/TASKS.md) | Actionable task board per phase, with checkboxes and status |
| [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) | What exists right now: phase, components, how to run, known gaps |
| [docs/HISTORY.md](docs/HISTORY.md) | Append-only log of every change, decision and measurement |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Resolved open questions (OQ-n) with the decision and rationale |

## Rules of engagement

### 1. Work phase by phase
Work only on the **current phase** named in [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md).
Do not start Phase N+1 work until the Phase N exit gate in [docs/PLAN.md](docs/PLAN.md) passes.
If a task seems to need a later-phase feature, stub it and note the dependency in TASKS.md.

**Before implementing anything, read that phase's document in
[docs/planning/](docs/planning/).** It carries the detail PLAN.md does not: what already exists
(verified in source), the exact schemas and algorithms, the task table with acceptance criteria,
and the "Forward Dependencies Declared Here" section that tells you what is deliberately left
unfinished and which phase finishes it. When implementation reveals the document was wrong, record
the deviation in its *Implementation Notes* section rather than letting doc and code drift apart.

### 2. Maintain the docs every time
After any unit of work, in the same turn:
- tick the task in [docs/TASKS.md](docs/TASKS.md) and add any new tasks discovered;
- update [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) if what exists or how to run it changed;
- append an entry to [docs/HISTORY.md](docs/HISTORY.md) (date, what changed, why, files, follow-ups);
- update [docs/FEATURES.md](docs/FEATURES.md) status if a feature moved state;
- record any answered open question in [docs/DECISIONS.md](docs/DECISIONS.md).

Docs that disagree with the code are a defect. Fix them in the same change.

### 3. Privacy invariants — never violate, never "temporarily" bypass
- Sanitization happens **before** any network request. No exceptions, no debug flags that skip it.
- `fetch` / `XMLHttpRequest` / `WebSocket` exist **only** in `apps/extension/src/host/egress/`.
- The release is self-contained and bring-your-own-key: models ship in the package, the user's Groq
  key (extension storage) is what calls the model, and no server or team key is part of the product.
  `server/` and `model.env` are dev/eval-only. `pnpm build` runs the release gates (`verify:models`,
  `verify:release`); never weaken them to make a build pass.
- The content script contains **no** network code and **never** reads `.value` of
  password / OTP / CVV / card-number fields.
- The vault is in-memory only. It exports no `toJSON`, no `entries()`, no iteration
  except the guard-only `normalizedValues()`.
- Everything fails **closed**: a crash, timeout, missing model or denied permission must yield
  grey pixels and a blocked request, never content.
- The egress client accepts only branded `GuardedPayload` objects produced by the guard.

### 4. Respect the runtime-context layout
The extension is organised by JavaScript context, not by feature, because these contexts cannot
share memory (architecture §15.2):

```
apps/extension/src/content/     → page frames. May touch DOM. No pixels, no vault, no network.
apps/extension/src/host/        → side panel / sidebar. Owns vault, guard, egress, controller, UI.
apps/extension/src/perception/  → dedicated Web Worker. The only place raw pixels live. No network.
packages/                       → pure TypeScript, no browser APIs (recognizers, policy, protocol).
```

Dependency rules are in architecture §15.3 and enforced by lint. Do not add cross-imports.

### 5. Measure, do not assert
Every number in docs or code comments is a **target** until the evaluation harness produces it.
When reporting a measurement always state: n, data split, hardware, browser version, backend,
model versions, policy version, date. Report failure cases next to success rates.

### 6. One contract
`packages/protocol/schema/*.json` (JSON Schema draft 2020-12) is the single source of truth for
anything crossing the network. TypeScript types and Pydantic models are **generated** from it.
Never hand-edit generated files; regenerate and commit.

### 7. Scope discipline
Do **not** build: mobile, multi-language UI, payments, RBAC/auth beyond a session, model training
or fine-tuning, blockchain, a second database, Kubernetes, or anything not in the demo script.

### 8. Show every fix in a run the user can watch
A fix to how the extension or the agent behaves is not done until it has been shown working in a
**visible** browser run on the user's screen — headless runs and unit tests alone do not count.
- **Visible runs:** `eval/.venv/bin/python tools/e2e/probe_site.py <url> "<task>" --watch`
  opens a real Chromium window (DISPLAY :0) with the built extension: the page on the left, the
  AEGIS panel's live run log in its own window on the right, confirmation cards shown before they
  are allowed, the full run log opened at the end (`--hold N` keeps the windows up N seconds).
  Rebuild first (`npx wxt build --mode development` in `apps/extension`).
- **The user's own Chrome:** the Playwright MCP server (`playwright`, extension mode) drives the
  user's real tabs and sessions — use it to look at what the user sees (their tabs, the page a bug
  happened on). Chrome does not let it into another extension's pages or its permission prompts,
  so it cannot click inside the AEGIS panel; the task runs themselves go through `--watch`.
- Run on **real websites**, not the `demo/` pages: public pages that need no login (Wikipedia, a
  shop's search and product pages, …). Never banking/financial sites, never a purchase, payment,
  sign-up or message send — read, search, navigate and report only.
- Use the live gateway (real model) for these runs; the scripted upstream `tools/e2e/fake_vlm.py`
  is for debugging only, and a run that used it must say so.
- Report which run showed which fix, and what was on screen (steps, screenshots sent, results).

## Commands

See [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) for the commands that actually work today.
Target commands once scaffolding exists:

```bash
pnpm install                 # JS/TS workspace
uv sync                      # Python workspace (gateway + eval)
pnpm gen:protocol            # JSON Schema → TS types + Pydantic models
pnpm dev:chrome              # WXT dev build, Chrome
pnpm dev:firefox             # WXT dev build, Firefox
pnpm build                   # both browser targets
pnpm test                    # Vitest unit tests
pnpm lint                    # includes the no-network-outside-egress rule
uv run pytest                # gateway tests
uv run aegis-eval run --split dev    # evaluation harness
```

## Style

- TypeScript strict. Python 3.12, typed, Pydantic v2.
- Policy is **data**, not code: thresholds and classes live in versioned JSON.
- Logs use a closed vocabulary (numbers, enums, versions). Never log page text, node names or values.
- Comments only where the *why* is non-obvious. No narration of what the code does.
- dont do commit by your dont even ask you dint have to add dommit msg or anything and dont add like  coorther my your self  it should be check and commit  and ppush my me only dont ask for commit 