# CLAUDE.md — AEGIS

Guidance for Claude Code working in this repository.

## What this project is

AEGIS is a **privacy-preserving browser agent**: a browser extension that runs a vision model
locally, detects and redacts sensitive data **before any network request**, sends only anonymized
context to a server model, and executes the returned actions on the page — resolving
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
or `[OQ-n]` (open question) the way those docs do, and record it in the decision log of
[docs/planning/bugs/tasks.md](docs/planning/bugs/tasks.md#decision-log).

## Working documents — in this repo

Index: [docs/README.md](docs/README.md).

| Document | Purpose |
|---|---|
| [docs/architecture-as-built.md](docs/architecture-as-built.md) | What exists right now, from the code: builds, contexts, step loop, privacy pipeline, failure handling, built-but-unwired modules |
| [docs/audit-2026-10-10.md](docs/audit-2026-10-10.md) | Defects found in the code, and the fix pass |
| [docs/planning/bugs/tasks.md](docs/planning/bugs/tasks.md) | The task list (R-0…R-18, follow-ups) with checkboxes, and the decision log |
| [docs/planning/bugs/](docs/planning/bugs/) | One implementation file per remediation step (`R-N-*.md`) |
| [docs/guides/](docs/guides/) | Development, testing, deployment, legacy gateway API |
| [docs/planning/](docs/planning/) | The original per-phase execution plans; background, not current status |

`CURRENT_BUILD.md`, `PLAN.md`, `TASKS.md`, `FEATURES.md`, `HISTORY.md` and `DECISIONS.md` are retired;
older documents still link to them.

## Rules of engagement

### 1. Work from the task list
Pick work from [docs/planning/bugs/tasks.md](docs/planning/bugs/tasks.md). Before implementing, read
its `R-N-*.md` file and the matching sections of [architecture-as-built.md](docs/architecture-as-built.md);
for background on a component, its original phase document in [docs/planning/](docs/planning/).
When implementation shows a document was wrong, fix the document rather than letting doc and code
drift apart.

### 2. Maintain the docs every time
After any unit of work, in the same turn:
- tick the task in [docs/planning/bugs/tasks.md](docs/planning/bugs/tasks.md) and add any new tasks discovered;
- update [docs/architecture-as-built.md](docs/architecture-as-built.md) if what exists or how it works changed;
- update the guide in [docs/guides/](docs/guides/) if how to run, test or deploy it changed;
- record any decision or answered open question in the tasks.md decision log (date, id, decision, why).

Docs that disagree with the code are a defect. Fix them in the same change.

### 3. Privacy invariants — never violate, never "temporarily" bypass
- Sanitization happens **before** any network request. No exceptions, no debug flags that skip it.
- `fetch` / `XMLHttpRequest` / `WebSocket` exist **only** in `apps/extension/src/host/egress/`.
- The release is self-contained and bring-your-own-key: models ship in the package, the user's own
  key for one of the providers in `apps/extension/src/host/egress/providers.ts` (Gemini default,
  Groq, Mistral, OpenRouter; all vision models on free tiers — closed-weights models such as Gemini are
  allowed since 2026-10-10, when the product owner lifted the open-weights constraint C-2 for now) is what calls the model, and no server or
  team key is part of the product.
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

[docs/guides/development.md](docs/guides/development.md) and [docs/guides/testing.md](docs/guides/testing.md)
have the commands that work today. The common ones:

```bash
pnpm install                 # JS/TS workspace
uv sync                      # Python workspace (gateway + eval)
pnpm gen:protocol            # JSON Schema → TS types + Pydantic models
pnpm dev:chrome              # WXT dev build, Chrome
pnpm dev:firefox             # WXT dev build, Firefox
pnpm build                   # both browser targets, with the release gates
pnpm -r test                 # Vitest unit + browser tests
pnpm lint                    # includes the no-network-outside-egress rule
uv run pytest                # gateway tests (in server/gateway)
uv run aegis-eval run --split dev    # evaluation harness (in eval)
```

## Style

- TypeScript strict. Python 3.12, typed, Pydantic v2.
- Policy is **data**, not code: thresholds and classes live in versioned JSON.
- Logs use a closed vocabulary (numbers, enums, versions). Never log page text, node names or values.
- Comments only where the *why* is non-obvious. No narration of what the code does.
- dont do commit by your dont even ask you dint have to add dommit msg or anything and dont add like  coorther my your self  it should be check and commit  and ppush my me only dont ask for commit 