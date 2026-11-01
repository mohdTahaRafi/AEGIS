# AGENTS.md — AEGIS

Contract for any AI agent or contributor working in this repository.
Claude Code users: [CLAUDE.md](CLAUDE.md) is the same contract with tool-specific detail.

## Orientation, in order

1. **[docs/architecture-as-built.md](docs/architecture-as-built.md)** — what exists and how it fits
   together, from the code.
2. **[docs/planning/bugs/tasks.md](docs/planning/bugs/tasks.md)** — the task list and the decision
   log. Each task's detail is in its `R-N-*.md` file next to it.
3. **[docs/audit-2026-10-10.md](docs/audit-2026-10-10.md)** — known defects and the fix pass.
4. **[docs/guides/](docs/guides/)** — how to develop, test and deploy.
5. **Requirement docs** — the authority when anything is ambiguous:
   - [product-requirements.md](docs/product-requirements.md)
   - [architecture.md](docs/architecture.md)
   - [design.md](docs/design.md)

## The project in one paragraph

A browser extension runs a vision model locally, fuses DOM/accessibility structure with pixel
perception, detects sensitive data (faces, passwords, Aadhaar, cards, free-text PII), replaces every
sensitive value with a **typed sealed placeholder** (`⟪AADHAAR#2⟫`), and sends only that anonymized
context to a remote vision model, called with the user's own API key. The server returns constrained UI actions. The client
validates them against the live page and resolves placeholders to real values **only in the browser**,
from an in-memory vault, under a confirmation policy.

## Hard invariants

Violating any of these is a defect, not a trade-off. There is no debug flag that suspends them.

1. **Sanitize before any network request.** No path sends page-derived data that has not passed the
   egress guard.
2. **One egress choke point.** `fetch` / `XMLHttpRequest` / `WebSocket` exist only in
   `apps/extension/src/host/egress/`, and that module accepts only branded `GuardedPayload` objects.
3. **Protected values are never read.** No code path reads `.value` of password, OTP, CVV or
   card-number fields. Presence and length only.
4. **The vault never leaves the device.** In-memory only, no serialization API, no logging, cleared
   on task end, cancel, panel close and idle timeout.
5. **Fail closed.** Crash, timeout, missing model, denied permission, missed deadline → grey pixels
   and a blocked request. Never "send raw because redaction was unavailable".
6. **No identifying side channels.** No URLs, paths, CSS selectors, XPaths or frame URLs in any
   payload. Node ids are opaque and random per session.
7. **Server output is data, never code.** It is parsed against a closed schema and re-validated
   against the live page before anything runs.
8. **No runtime model downloads.** Models ship in the package and are sha256-verified at build and load.

## Runtime-context layout

The extension is organised by JavaScript context, because these contexts cannot share memory.
A file's folder tells you what it may touch.

| Folder | Context | May touch | Must never |
|---|---|---|---|
| `src/content/` | Page frames, isolated world | DOM of its own frame | Network code; protected field values; page instructions |
| `src/host/` | Side panel / sidebar | Vault, guard, egress, controller, UI | Serialize the vault |
| `src/perception/` | Dedicated Web Worker | Raw pixels, model inference | The network |
| `packages/` | Pure TS, node-testable | Nothing browser-specific | Import from `apps/` |

Dependency rules: architecture §15.3. They are enforced by lint — do not work around them.

## Working rules

- **Work from the task list.** If a task needs something not yet built, stub it and record the
  dependency as a new task in [tasks.md](docs/planning/bugs/tasks.md).
- **Resolve open questions, do not guess.** Decisions are recorded in the
  [decision log](docs/planning/bugs/tasks.md#decision-log). A proposed default is not a decision.
- **One contract.** JSON Schema in `packages/protocol/schema/` is the source of truth; TS types and
  Pydantic models are generated. Never hand-edit generated files.
- **Policy is data.** Sensitivity classes, thresholds, operators and rehydration rules live in
  versioned JSON. Every payload records the policy version.
- **Measure, do not assert.** Numbers are targets until the harness produces them. Report n, split,
  hardware, browser version, backend, model versions, policy version and date. Report failures next
  to successes.
- **Closed-vocabulary logging.** Numbers, enums and version strings only. Never page text, node
  names or values.

## Out of scope — do not build

Mobile, multi-language UI, payments, RBAC or auth beyond a session, training or fine-tuning models,
blockchain, a second database, Kubernetes, CAPTCHA solving, and anything not in the demo script.

## Definition of done

A change is done when all of these hold:

- [ ] Behaviour matches the requirement docs, or the divergence is recorded as `[A]`/`[OQ-n]`.
- [ ] Hard invariants hold; privacy-relevant code has a test that proves it.
- [ ] Lint, typecheck and tests pass, including the no-network-outside-egress scan.
- [ ] The task is ticked in [tasks.md](docs/planning/bugs/tasks.md) and new tasks are added.
- [ ] [architecture-as-built.md](docs/architecture-as-built.md) and the relevant guide updated if
      what runs, or how, changed.
- [ ] Any decision recorded in the [decision log](docs/planning/bugs/tasks.md#decision-log).
- [ ] Commit message follows [CONTRIBUTING.md](CONTRIBUTING.md).
