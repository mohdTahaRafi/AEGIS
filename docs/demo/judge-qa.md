# Judge Q&A pack

**Task basis:** phase_7_demo_submission.md §5 (T-7.7), DR-5, honesty rules in §4
**Rule this document follows:** lead with the weakest area, don't wait to be asked (NFR-15).
**All numbers below are cited from a specific report file** — never restated from memory, never
rounded up. If a number in this document ever disagrees with the report it cites, the report is
right and this document is stale; fix the document.

---

## 1. The weakest area, stated first

**Metric 1 (task success — visual context accuracy) has never been measured, on any split.**

Why: it requires two live-model runs (sanitized-context and raw-context) compared against each
other, and this environment has no GPU — `navigator.gpu.requestAdapter()` returns `null` here,
confirmed by direct probe, not assumed (see `DECISIONS.md`'s OQ-7 entry, same root cause). Every
scoreboard in this repository shows Metric 1 as `—`, including the authorised held-out run
(`eval/reports/2026-09-18T145854Z-heldout/rich-scoreboard.md`). There is also a genuine
**open ambiguity in what Metric 1 even measures** (OQ-4): a primary reading (does the task still
succeed when the model only sees sanitized context) and a secondary reading (does the model still
correctly understand the screen). Both readings are reported wherever this scoreboard appears;
neither has a number yet.

If asked "does the agent actually complete tasks with a real model": **no measured answer exists.**
What *is* measured: the local privacy pipeline (detection → redaction → vault → guard) runs
correctly against 204 real fixture screens and completes the DOM-manipulation half of tasks
(typing, clicking, submitting) against real pages — see the demo-fixture proof
(`apps/extension/test/e2e/demo-fixture.spec.ts`) and the zero-egress proof
(`apps/extension/test/e2e/privacy.spec.ts`). The missing piece is specifically "does an actual
language model, given only the sanitized context, plan the right actions" — untested here.

---

## 2. Residual risk (architecture §10.6, said out loud)

**The guard can only find what its recognizers can find.** AEGIS's redaction is pattern- and
structure-based (Verhoeff/Luhn/GSTIN checksums, 13 entity patterns, DOM protected-value rules, OCR
over vision regions). It is not a general PII classifier. A sensitive value that matches none of
the 13 recognized entity types, has no DOM signal (no `type="password"`, no accessible-name hint),
and produces no OCR-legible text will not be redacted. This is a structural limit of the approach,
not a bug to be fixed later.

**The measured leak count, with n:**
- Held-out split (authorised, one-time — `eval/reports/2026-09-18T145854Z-heldout/`): **0 leaks,
  n=36 payloads.**
- Dev split (`eval/reports/2026-09-18T161944Z-dev/`): **1 leak, n=156 payloads** — a disclosed
  `PIN_CODE` finding, tied to a specific policy-class gap (`PIN_CODE` was classified in a way that
  let one instance through; see HISTORY.md's 2026-09-18 entries for the exact root cause). The
  independent auditor that found this leak is a **separately re-implemented recognizer set**
  (`eval/src/aegis_eval/auditor/recognizers.py`), not a re-export of the client's own recognizers —
  it exists precisely so the client can't grade its own homework.
- Both leak-count auditors scan **JSON text only, not image pixels** — no OCR model exists in the
  auditor (disclosed gap, `auditor/ocr.py`). A leak baked into a composited image's pixels (rather
  than the JSON envelope) would not be caught by this specific audit.

---

## 3. The vault's memory-zeroing limitation

The vault (`apps/extension/src/host/privacy/vault/`) is in-memory only, exports no `toJSON`, no
`entries()`, and no iteration except a guard-only `normalizedValues()` — by construction it never
serializes a raw value anywhere. **It does not, however, zero its backing memory on eviction or
session end.** JavaScript gives no primitive for guaranteed memory zeroing (no `memset`-equivalent
over a string or object once garbage collected) — this is a JS-runtime-level limitation, not
something AEGIS chose not to build. The practical mitigation is scope: the vault only ever exists
for the lifetime of one side-panel session, and a browser process exit reclaims that memory through
the OS's normal page-reuse path, same as any other in-memory secret in a browser extension. If a
judge presses on "can a memory-scanning attacker recover values after the fact" — the honest answer
is: possibly, for a bounded window, same as most software that doesn't run in a language with
manual memory control. This was never claimed to be solved.

---

## 4. The numbers (DR-4 — live scoreboard)

**Authorised held-out run** (`eval/reports/2026-09-18T145854Z-heldout/rich-scoreboard.md`,
n=38, Linux x86_64/fedora, chromium 153.0.8010.12, policy 2026.09.1, spent exactly once per
phase_5_measurement.md's discipline rule):

| Metric | Value |
|---|---|
| 1. Task success | **not measured** (OQ-13 — no GPU here) |
| 2. PII recall (structured / free-text / visual) | 0.803 / 0.250 / not measured (0.000 TP) |
| 3. Redaction pixel precision / over-redaction | 0.981 / 0.0000 |
| 4. Client resources | not measured on this split |
| 5. Latency | not measured on this split |
| Leak count | **0, n=36** |

**Dev-split numbers for 4/5** (a *different, non-authorised* split — labelled as such, never
presented as the held-out number — `eval/reports/2026-09-18T161944Z-dev/rich-scoreboard.md`,
n=166): peak RSS 1123.8 MB, task CPU p95 35.0%, per-stage latency p50/p95 (guard is the slowest
stage: 43/65 ms), task wall clock p50/p95 1247.4/1658.6 ms, bundled model size 0.2 MB (dominated
in the actual shipped build by the 28.31 MB ORT WASM runtime, not the models).

**The visual category's recall is 0.000 across every report in this repository.** This is not a
detection failure — it is a disclosed **corpus gap**: no real FACE/ID_DOCUMENT/SIGNATURE/QR_CODE
example exists in either split (no licensable photo reachable in this sandbox). Say this plainly
if the visual row comes up; don't let a judge read it as "face redaction doesn't work."

---

## 5. Why two detection channels both matter (DR-5 — ablation table)

`docs/planning/ablations_phase6.md`, real 4-arm × 166-fixture dev-split run, zero errors:

| Arm | Structured recall | Pixel precision | Leak count |
|---|---|---|---|
| **fused** (both channels) | 0.826 | 0.978 | 1/156 |
| dom_only | 0.798 | 0.981 | 1/156 |
| pixel_only | 0.353 | 0.718 | not measured |
| blackbox (fused detection, no typed placeholders) | 0.826 | 0.978 | 1/156 |

Reading it: `fused` recovers PII that `dom_only` alone misses (canvas/PDF-rendered IDs with no DOM
signal at all — the OCR path this phase built, T-6.5/T-6.6). `pixel_only` degrades sharply on both
recall and redaction precision — vision alone, without DOM structure, is a materially worse
detector here. `blackbox` matching `fused` exactly shows that **typed placeholders don't change
what gets redacted** — they change what the server can reason about (the differentiating claim of
the whole project), which this ablation isn't designed to measure and doesn't claim to.

---

## 6. What has not been rehearsed or executed yet (say this if asked "are you demo-ready")

Per `docs/demo/demo-script.md` §3 and `docs/TASKS.md`'s Phase 7 board:
- No airplane-mode rehearsal (T-7.4), no judge's-own-page rehearsal on 10 real unseen pages
  (T-7.5), no three-consecutive-clean-runs proof (T-7.8), no second configured laptop (T-7.9), no
  narrated video (T-7.10), no exported/link-tested slide deck (T-7.11).
- **Firefox (AC-12, T-6.14) is genuinely blocked in this environment**, not skipped by choice:
  Playwright's Firefox build can't be downloaded here (network-blocked to that CDN, confirmed by
  trying), and the system Firefox doesn't speak Playwright's juggler protocol. If a judge asks
  about Firefox support specifically, this is the honest answer — not "it works," not "we didn't
  try."
- The demo fixture's profile photo has never been checked against real face-detection accuracy
  (see `demo-script.md`'s explicit disclosure). Don't claim it fired unless it was rehearsed with
  a real photo and actually observed to fire.

This section should shrink as each task above is closed for real, with a link to the verification
that closed it — never by deleting the line without one.
