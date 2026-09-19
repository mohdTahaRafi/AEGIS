# AEGIS

**A privacy-preserving browser agent with on-device visual perception.**

A browser extension runs a vision model locally, detects sensitive data on screen, and replaces
every sensitive value with a **typed sealed placeholder** — `⟪AADHAAR#2⟫` — before anything is sent.
A remote open-weights model reasons over that anonymized context and returns constrained UI actions.
The client validates each action against the live page and resolves placeholders back to real values
**only inside the browser**, from an in-memory vault, under a confirmation policy.

The server can be assumed hostile and the user's sensitive values still never leave the device.

## Status

Phase 7 (demo & submission) of 7. Phases 1–5 are complete; Phase 6's non-Firefox scope is complete
and verified; Firefox itself (AC-12) is genuinely blocked in the current build/CI environment (no
way to launch a Playwright-driven Firefox here — confirmed by trying, not assumed). The full
privacy pipeline is real and running end to end: DOM extraction, on-device vision (face detection,
OCR), dual-channel fusion, typed-placeholder substitution, the vault, the egress guard, and action
dispatch back into the real page. See [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) for the
detailed state and [docs/PLAN.md](docs/PLAN.md) for the roadmap.

**Measured, not asserted** (full detail and citations in [docs/demo/judge-qa.md](docs/demo/judge-qa.md)):

| | Held-out (n=38, one-time authorised run) | Dev (n=166, re-run freely) |
|---|---|---|
| PII recall — structured entities | 0.803 | 0.798 |
| Redaction pixel precision | 0.981 | 0.981 |
| Over-redaction on hard negatives | 0.0000 | 0.0000 |
| Leak count | 0 / 36 payloads | 1 / 156 payloads (disclosed `PIN_CODE` finding) |
| Task peak RSS / CPU p95 | not measured on this split | 1123.8 MB / 35.0% |
| Task wall-clock p50 / p95 | not measured on this split | 1247.4 / 1658.6 ms |

**Not measured, on any split: task success with a live model (Metric 1).** This environment has no
GPU (`navigator.gpu.requestAdapter()` returns `null`, confirmed) — OQ-13 remains open. Everything
above concerns the local detection/redaction/action pipeline, which runs and is measured
independently of that gap.

## Documentation

| Start here | |
|---|---|
| [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) | How to work in this repo; the invariants that cannot be suspended |
| [docs/CURRENT_BUILD.md](docs/CURRENT_BUILD.md) | What exists right now and how to run it |
| [docs/PLAN.md](docs/PLAN.md) | The 8 phases and their exit gates |
| [docs/planning/](docs/planning/) | One detailed execution document per phase — implement from these |
| [docs/FEATURES.md](docs/FEATURES.md) | All 105 features, traced to requirements |
| [docs/TASKS.md](docs/TASKS.md) | The task board |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Open questions and their resolution status |
| [docs/HISTORY.md](docs/HISTORY.md) | What has been done, and why |

Requirements are the authority:
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

## Known limitations

- The guard can only find what its recognizers and detectors can find. A PII type none of them knows
  can pass. The residual risk is measured by the harness, not claimed away — see the leak counts
  above, and note the auditor scans JSON text only, not image pixels (no OCR model in the auditor).
- JavaScript offers no secure memory zeroing; vault values are ordinary strings kept in one module
  and dropped on clear, reclaimed only via the browser process's normal memory lifecycle.
- Task success with a live model (Metric 1) has never been measured — no GPU in the build/CI
  environment (OQ-13). What's measured instead is the full local pipeline (detection through
  action dispatch), independent of model quality.
- **Firefox is currently untested (AC-12 open)** — genuinely blocked in this environment, not a
  design choice: Playwright's Firefox build isn't downloadable here and the system Firefox doesn't
  speak Playwright's automation protocol.
- Face-detection *accuracy* is unverified against a real photograph — no licensable face photo is
  reachable in this environment. The detection pipeline runs end to end against the real bundled
  model; only accuracy on real faces is untested.
- No CLIP-family vision-language model exists in this build, so zero-shot region screening and the
  screen-state label are real call shapes with no model behind them yet.
- WebGPU is an accelerator, not a requirement. The WASM path is first-class and slower; both are
  measured and reported. Firefox on Linux still needs a preference for WebGPU, so it runs the
  single-threaded WASM path (once Firefox itself is verified — see above).
- The visual PII category (face/ID document/signature/QR code) shows 0.000 recall in every report
  produced so far — a disclosed corpus gap (no real example of any of these exists in either
  split), not a detector failure.

## Scope

Not built: mobile, multi-language UI, payments, RBAC or auth beyond a session, model training or
fine-tuning, blockchain, a second database, Kubernetes, CAPTCHA solving.
