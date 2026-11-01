# docs/planning — AEGIS phase execution documents

One execution document per phase. Each is written to be implemented from directly: it states what
already exists (verified in source, not assumed), what this phase builds, the exact schemas and
algorithms involved, a task table with acceptance criteria, and a milestone definition that
describes what a person actually sees when the phase is done.

These are the *detailed* counterpart to [../PLAN.md](../PLAN.md), which holds the one-page view of
all eight phases and their exit gates.

| Phase | Document | Depth | Status |
|---|---|---|---|
| 0 | [phase_0_spike_foundations.md](phase_0_spike_foundations.md) | full | **in progress** — scaffold built, spike numbers outstanding |
| 1 | [phase_1_contract_harness.md](phase_1_contract_harness.md) | full | **essentially complete** — T-1.1…T-1.21 done and verified |
| 2 | [phase_2_spine.md](phase_2_spine.md) | full | ready to implement — **next up** |
| 3 | [phase_3_privacy_core.md](phase_3_privacy_core.md) | full | ready to implement |
| 4 | [phase_4_vision.md](phase_4_vision.md) | full | ready to implement |
| 5 | [phase_5_measurement.md](phase_5_measurement.md) | reduced — deepened when reached | not started |
| 6 | [phase_6_tier2_parity.md](phase_6_tier2_parity.md) | reduced — deepened when reached | not started |
| 7 | [phase_7_demo_submission.md](phase_7_demo_submission.md) | reduced — deepened when reached | not started |

## Study and report documents

Phases that end in a measurement rather than a feature write their answer into a report document,
committed alongside the raw results. A report is never written before the measurement exists.

| Document | Produced by | Holds |
|---|---|---|
| [spike_report_phase0.md](spike_report_phase0.md) | Phase 0 | The go/no-go answer: WebGPU/WASM availability and face-detector latency on the reference laptop, both browsers |
| `bakeoff_phase4.md` | Phase 4 | Client model selection: ViT variant, NER profile S vs L, quantisation, measured against the size and latency budget |
| `scoreboard_phase5.md` | Phase 5 | The five official metrics plus leak count, with n, split, hardware, versions |
| `ablations_phase6.md` | Phase 6 | DOM-only vs pixel-only vs fused; black-box vs typed placeholders |

## Conventions used in these documents

**State markers** in "what exists today" tables:

| Marker | Meaning |
|---|---|
| `[built]` | Exists and works as described |
| `[built-spike]` | Exists as throwaway Phase-0 measurement code; deleted or replaced by the phase that supersedes it |
| `[scaffold]` | File/folder exists with a stub; no behaviour |
| `[new]` | Created by this phase |
| `[modify]` | Changed by this phase |
| `[delete]` | Removed by this phase |

**Source tags**, carried over from the requirement documents so provenance is never lost:

| Tag | Meaning |
|---|---|
| `[PS]` | Stated in SIH problem statement 26171. Binding. |
| `[SS]` | Stated in the team's solution strategy. Binding. |
| `[AD]` | From the earlier architecture draft; adopted where architecture.md says so. |
| `[TD]` | Technical decision made in the requirement docs to make the idea implementable. |
| `[A]` | Assumption, needs confirmation. |
| `[OQ-n]` | Open question — see [../DECISIONS.md](../DECISIONS.md). |

**Numbers.** Every threshold, budget and limit in these documents is an *initial tunable* until the
evaluation harness produces a measurement, exactly as design.md §1 requires. A phase document that
states a target states it as a target.

## Requirement documents these are derived from

[product-requirements.md](../product-requirements.md) ·
[architecture.md](../architecture.md) ·
[design.md](../design.md)
