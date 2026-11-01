# Ablations — Phase 6

**Generated:** 2026-09-19 · **Split:** dev · **Hardware:** Linux x86_64 (fedora) · **Browser:** Chromium (Playwright)

design.md §18.3's four arms, run on the same corpus and the same task through the real extension pipeline (not simulated — `eval/src/aegis_eval/ablations/runner.py`). Metric 1 (task success) is not measured for any arm: the mock gateway (`runner/gateway_mock.py`) returns the identical scripted plan regardless of payload content, so there is no real task-success signal to differ between arms in this environment (OQ-13, no live model here) — the same disclosed gap as every other mock-gateway-driven scoreboard in this project, not something this ablation run resolves.

| Arm | n screens | Metric 2 macro recall (overall) | ...by group: structured | ...free_text | ...visual | Metric 3 pixel precision | over-redaction rate | Metric 5 task p95 (ms) | Leak count |
|---|---|---|---|---|---|---|---|---|---|
| fused | 166 | 0.602 | 0.826 | 0.250 | 0.000 | 0.978 | 0.000 | 1468.1 | 1 |
| dom_only | 166 | 0.582 | 0.798 | 0.250 | 0.000 | 0.981 | 0.000 | 614.1 | 1 |
| pixel_only | 166 | 0.240 | 0.353 | 0.000 | 0.000 | 0.718 | 0.000 | 1543.0 | not measured |
| blackbox | 166 | 0.602 | 0.826 | 0.250 | 0.000 | 0.978 | 0.000 | 1277.1 | 1 |

## Claims tested

- **fused**: The default pipeline — the claim every other row is measured against.
- **dom_only**: DOM-only leaks on canvas/PDF/image pages (Channel V disabled, no image ever attached).
- **pixel_only**: Pixel-only is slower and type-blind; line-level boxes over-redact (Channel D/DOM text ignored, OCR runs over the whole frame).
- **blackbox**: Black-box redaction destroys the context the server needs (typed placeholders replaced with unlabelled black boxes, no refs sent).

## Disclosed gaps

- Metric 1 (task success) is not measured for any arm — see the note above the table.
- Metric 2's group breakdown here is by ENTITY GROUP (structured/free_text/visual, `scorers/entity_groups.py`), not by page CATEGORY (canvas/PDF/etc.) — a canvas- or PDF-specific recall column would need a corpus-category filter this run does not currently apply. The `dom_only` row's `visual` recall is the closest existing proxy for "leaks on canvas/PDF/image pages," since canvas/img/video content is exactly what Channel V (now disabled under `dom_only`) is responsible for.
- Each arm is one full run of the given split; n is stated per row, not assumed equal across rows (a run that errors on some fixtures still reports the rest).
- `visual` recall is 0.000 for every arm, including `fused` — not a bug: `entity_groups.py`'s VISUAL group is `{FACE, ID_DOCUMENT, SIGNATURE, QR_CODE}` only, and this synthetic dev corpus has no real examples of those (the same pre-existing, already-disclosed gap as CURRENT_BUILD.md's face-detection-accuracy note — no licensable face photo reachable in this environment). The canvas/PDF PII this run's fixes actually unlocked (e.g. a UPI VPA OCR'd off a `<canvas>`) is classified `structured`, where `fused` (0.826) does show real, higher recall than `dom_only` (0.798) — the improvement is there, just in a different row than "visual" might suggest at a glance.
