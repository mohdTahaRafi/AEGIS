# AEGIS

**On-device visual perception for light-weight browser agents.**
SIH 2026 · Problem Statement 26171 · Indian Space Research Organisation (ISRO).

A browser extension runs a vision model locally, detects sensitive data on screen, and replaces
every sensitive value with a **typed sealed placeholder** — `⟪AADHAAR#2⟫` — before anything is sent.
A remote open-weights model reasons over that anonymized context and returns constrained UI actions.
The client validates each action against the live page and resolves placeholders back to real values
**only inside the browser**, from an in-memory vault, under a confirmation policy.

The server can be assumed hostile and the user's sensitive values still never leave the device.

## Status

**Phase 0 — spike and foundations. Documentation only; no code yet.**
No metric has been measured. Every number in the documents is a target, not a result.
See [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md).

## Documentation

| Start here | |
|---|---|
| [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) | How to work in this repo; the invariants that cannot be suspended |
| [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) | What exists right now and how to run it |
| [docs/PLAN.md](docs/PLAN.md) | The 8 phases and their exit gates |
| [docs/FEATURES.md](docs/FEATURES.md) | All 105 features, traced to requirements |
| [docs/TASKS.md](docs/TASKS.md) | The task board |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Open questions and their resolution status |
| [docs/HISTORY.md](docs/HISTORY.md) | What has been done, and why |

Requirements are the authority (mirrored in `docs/`, originals in `../project_requredment/`):
[product-requirements.md](docs/product-requirements.md) ·
[architecture.md](docs/architecture.md) ·
[design.md](docs/design.md)

## How it works

```
page → screen graph (DOM + a11y + exact geometry) ┐
                                                  ├→ fusion → typed placeholders → egress guard → server
     → local vision (faces, ViT screening, OCR) ──┘                                      │
                                                                                    action plan
       real value ← vault ← rehydration (type-matched, origin-bound, confirmed) ←───────┘
```

Five things make the privacy claim true rather than asserted:

1. **Dual detection** — DOM structure plus pixels, so canvas, images and PDF viewers are covered.
2. **Typed placeholders** — the model keeps the meaning of a value without ever receiving it.
3. **Additive image composition** — the outgoing image is built only from positively cleared
   regions, so a crash or timeout leaves grey, never content.
4. **One egress choke point** — a guard re-scans the final bytes independently of the detectors and
   blocks on any survivor. Fail-closed.
5. **An independent auditor** — the evaluation harness re-implements the recognizers in another
   language and counts leaks the client could not see.

## Honest limitations

- The guard can only find what its recognizers and detectors can find. A PII type none of them knows
  can pass. The residual risk is measured by the harness, not claimed away.
- JavaScript offers no secure memory zeroing; vault values are ordinary strings kept in one module
  and dropped on clear.
- WebGPU is an accelerator, not a requirement. The WASM path is first-class and slower; both are
  measured and reported.
- Firefox on Linux still needs a preference for WebGPU, so it runs the single-threaded WASM path.

## Scope

Not built: mobile, multi-language UI, payments, RBAC or auth beyond a session, model training or
fine-tuning, blockchain, a second database, Kubernetes, CAPTCHA solving.
