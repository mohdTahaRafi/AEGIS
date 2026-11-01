# AEGIS documentation

## Current state: start here

| Document | Holds |
|---|---|
| [architecture-as-built.md](architecture-as-built.md) | What exists now, from the code: builds, runtime contexts, the step loop, the privacy pipeline, failure handling, and modules that are built but not wired |
| [audit-2026-10-10.md](audit-2026-10-10.md) | Defects found by reading the code end to end, and the fix pass that followed |
| [planning/bugs/tasks.md](planning/bugs/tasks.md) | The task list (R-0…R-18, follow-ups) and the decision log |

## Guides

| Guide | For |
|---|---|
| [guides/development.md](guides/development.md) | Setup, running each part, where code goes |
| [guides/testing.md](guides/testing.md) | Test suites and how to run them |
| [guides/deployment.md](guides/deployment.md) | Building, verifying and publishing a release |
| [guides/gateway-api.md](guides/gateway-api.md) | The legacy gateway's HTTP API (dev / eval only) |

## Requirements and original design

Where these disagree with the code, [architecture-as-built.md](architecture-as-built.md) follows the
code and the difference is a recorded decision or an open defect.

| Document | Holds |
|---|---|
| [product-requirements.md](product-requirements.md) | Goals, FR-*/NFR-* requirements, acceptance criteria AC-1…AC-12 |
| [architecture.md](architecture.md) | The planned components, model stack, repo layout, open questions OQ-1…OQ-17 |
| [design.md](design.md) | Data models, protocol, action DSL, algorithms, UI, tests |
| [project-overview.md](project-overview.md) | A short overview of the project |

## History and demo

| Folder | Holds |
|---|---|
| [planning/](planning/) | The original phase-by-phase execution plans (Phases 0–7); background, not current status |
| [planning/bugs/](planning/bugs/) | One implementation file per remediation step (`R-N-*.md`) |
| [demo/](demo/) | Demo script and judge Q&A |
