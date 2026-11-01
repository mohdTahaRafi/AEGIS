# Phase 5 — Measurement: The Five Metrics, the Independent Auditor & Offline Deployment

**Document type:** Phase 5 execution document
**Requirements basis:** FR-46, FR-50, FR-51, FR-52, FR-54; NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, NFR-6, NFR-13, NFR-15; **AC-8, AC-10**
**Architecture basis:** `architecture.md` §2 P1/P10, §11.2–11.3 (budgets), §12 (observability and evaluation), §13.2 (offline path), §16 (build order step 6)
**Design basis:** `design.md` §18 in full (harness design), §17 (testing strategy), §19 (performance notes)
**Depends on:** Phases 1–4 in full. Phase 1 built the corpus format, the runner and the held-out guard; Phase 3 made ledger exports non-empty; Phase 4 made images and coverage real. OQ-16 (reference laptop) must be closed — every metric-4 and metric-5 number is meaningless without it.

> **Status (2026-09-18, updated):** The harness-integration gap named below has since been closed
> (same day, "ok start doing left work") — the eval harness now genuinely drives the built
> extension through a real task on every real corpus fixture (via an in-process mocked gateway
> response, since OQ-13 still has no live model), and metrics 2/3 plus the leak count are measured
> for real against the full 30-screen dev corpus for the first time. Closing that gap surfaced five
> real, previously-invisible bugs (a CSP/Ajv incompatibility that broke the panel outright in a
> real browser, a missing bearer token, a real race condition, a systemic double-redaction bug, and
> a corpus-generator bug that made one fixture's PAN undetectable by design) plus one scoring
> methodology fix — all fixed, all disclosed in `docs/HISTORY.md`'s second Phase 5 entry, not
> silently absorbed. **Still not done:** corpus growth to 200–300 (still 30 fixtures — real
> content-authoring work), and real measurement of metrics 1/4/5 against reference hardware/a live
> model (OQ-16/OQ-13, both still open). The held-out split remains deliberately NOT exercised.

> **Depth note.** Phases 5–7 are written at lower initial depth than 0–4 and deepened when reached,
> following the same convention the requirement documents use for later-tier work. **What is fixed
> now, and not open to redesign at implementation time, is the metric definitions, the held-out
> discipline, and the independence of the auditor.** Everything in §3, §4 and §5 is binding; the
> file-level detail is expected to grow when the phase begins.

---

## 1. Objective

Every number this project has produced so far is a target. Phase 5 turns targets into
measurements, or into honestly-reported failures.

Architecture §2's principles P1 (*the rubric is the specification*) and P10 (*measure, don't
assert*) both land here, and [SS]'s honesty rule governs the output: own baselines only, no
projected ROI, no rounding up, failure cases reported alongside success rates, and every figure
carrying its sample size, data source and hardware.

**By the end of this phase:** `uv run aegis-eval run --split dev` produces a scoreboard with all
five official metrics plus a leak count, each row stating n, split, hardware, browser version,
backend, model versions, policy version and date. The independent auditor — written in Python, not
ported from the TypeScript — reports how many labelled values or canaries it could recover from
captured payloads. The server stack starts from saved images and pre-downloaded weights with no
internet access at all.

**No new product features.** Phase 5 adds no capability the agent did not have at the end of
Phase 4. What it adds is the ability to say what the agent is actually worth, with evidence.

---

## 2. What this phase inherits

| Path | Inherited | Phase 5 action |
|---|---|---|
| `eval/corpus/` | `[Phase 1]` ~30 dev fixtures | **Grown to 200–300** across all ten categories, 20% held out |
| `eval/src/aegis_eval/runner/` | `[Phase 1]` Playwright driver, ledger collection, resource sampling | **Consumed.** Now drives real tasks and collects real ledgers |
| `eval/src/aegis_eval/report/` | `[Phase 1]` provenance columns, empty metrics | **Filled** — five scorers plus leak count |
| `eval/src/aegis_eval/scorers/`, `auditor/` | *(absent)* | **Created** |
| `src/host/privacy/guard/` | `[Phase 3/4]` steps 1–5 | **Gains step 6** — the canary check, in debug and harness builds |
| `server/deploy/offline/` | `[scaffold]` | **Created** — saved images, pre-downloaded weights, offline env, internal TLS |
| Held-out guard | `[Phase 1]` refuses without flag + reason | **Exercised once**, with its audit line |

---

## 3. The five metrics — definitions that are fixed now

Design.md §18.2. These definitions are binding; how they are computed may be refined, what they
mean may not.

| Metric | Weight | Computation |
|---|---|---|
| **1. Visual context accuracy** | 25% | **Primary** ([SS]'s definition): task success rate with sanitized context ÷ task success rate with **raw** context, on the same tasks and the same model. **Secondary** (OQ-4's other reading): element-level agreement between the sent graph (roles, names, boxes) and ground truth, plus screen-state label accuracy. **Both are reported** — the PS does not define which is meant |
| **2. PII detection** | 20% | Per entity: match predicted regions to labels at IoU ≥ 0.5 (faces ≥ 0.4); precision = TP/(TP+FP), recall = TP/(TP+FN); macro and micro; **separate tables for structured / free-text / visual entities**, because their difficulty is not comparable |
| **3. Redaction precision** | 20% | (a) Pixel precision = redacted pixels overlapping ground-truth sensitive boxes ÷ all redacted pixels; (b) **over-redaction rate on hard negatives** = hard-negative items redacted ÷ hard-negative items; (c) mean IoU of matched boxes |
| **4. Client resources** | 20% | Bundled model MB (from the manifest); peak and mean memory of the browser processes hosting the panel and worker; CPU% mean and p95 during a task **and at idle**; GPU time where available. Each with machine and browser version |
| **5. End-to-end latency** | 15% | Per stage from the ledger, p50/p95; per-step round trip; per-task wall clock; model share from `Server-Timing` |
| **Leak count** | — | Auditor recovers any labelled value (by hash) or canary from any payload (JSON **and** OCR of images) → count, with n payloads. **Target: 0, with n stated** |

**Metric 1's ambiguity is handled by reporting both readings, not by choosing one.** The PS does not
define how "accuracy of visual context from screen" is measured (OQ-4). Reporting a single number
under one interpretation and hoping it is the right one would be a guess presented as a result.

---

## 4. The independent auditor — and why "independent" is not decoration

Architecture §12.3 and FR-52. The auditor re-implements the recognizers **in Python, from the
specification, not as a port of the TypeScript**, and adds a stronger server-grade OCR/NER pass over
captured payloads.

The reason is simple and load-bearing: a ported implementation inherits the original's blind spots.
If the TypeScript Aadhaar recognizer has an off-by-one in its Verhoeff table, a port has the same
off-by-one, agrees with itself, and reports zero leaks — which is exactly the number that gets put
on a slide. Two independent implementations disagreeing is information; one implementation agreeing
with itself is not.

The auditor also runs models the client cannot afford (a large OCR, a large NER) precisely because
it does not have to meet metric 4's budget. Its job is to estimate what the client's cheap detectors
**missed**, which is the residual risk architecture §7.8 declines to claim away.

---

## 5. Held-out discipline

Design.md §18.4, already enforced mechanically since Phase 1. The 20% held-out split is touched
**once**, before submission, behind an explicit flag and a stated reason, with an audit line written
into the report each time.

This is not ceremony. Finale use cases are supplied at the finale (C-5), so the ability to
generalise to unseen pages is the thing actually being tested (NFR-16). A held-out split that has
been peeked at repeatedly has become a dev split, and the number it produces is an overfit number
reported as a generalisation number.

---

## 6. Corpus growth

Phase 1 built ~30 fixtures weighted toward hard negatives. Phase 5 grows to 200–300 across the ten
categories [SS]: government portals, banking, email/chat, social, healthcare, canvas apps, PDF.js
viewers, video/camera previews, Indic-script pages, hard negatives. 80/20 dev/held-out split.

Constraints carried from design.md §17/§18.1: synthetic identities only, identifiers generated with
valid checksums and fictitious, face images only from sources whose licence permits this use
(recorded per image in `eval/corpus/README.md`), values stored as hashes rather than plaintext.

---

## 7. Offline deployment (AC-10)

FR-46 and NFR-13. The same `docker compose` file must run air-gapped: model weights pre-downloaded
onto a volume, container images saved with `docker save`, Hugging Face offline mode enabled, TLS
with an internal certificate.

This is a genuine PS requirement — the server model must be open-weights and offline-deployable —
and it is also the sovereignty argument ISRO's interest rests on [SS]. It is verified by actually
disconnecting the machine, not by reading the compose file.

---

## 8. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 5.1 | Corpus to 200–300 screens, ten categories, 80/20 split | Category quotas met and documented; every asset's licence recorded; `validate-labels` passes over all |
| 5.2 | Metric 1 scorer | Reports **both** the sanitized-vs-raw task-success ratio and the element-level/screen-label agreement, clearly labelled as two readings of an ambiguous rubric item |
| 5.3 | Metric 2 scorer | Per-entity precision/recall at the stated IoU thresholds; macro and micro; three separate tables (structured / free-text / visual) |
| 5.4 | Metric 3 scorer | Pixel precision, over-redaction rate on hard negatives, mean IoU of matched boxes |
| 5.5 | Metric 4 scorer | Model MB, peak/mean memory, CPU mean/p95 during task and at idle, GPU time where available — each tagged with machine and browser version |
| 5.6 | Metric 5 scorer | Per-stage and round-trip p50/p95, per-task wall clock, model share from `Server-Timing` |
| 5.7 | **Independent Python auditor** | Recognizers written from the spec, **not ported** — asserted by a review checklist in the PR and by the auditor finding at least one planted case the client's recognizers miss; stronger OCR/NER pass over payload images |
| 5.8 | Canary check in the guard, wired into CI | Any canary string in payload bytes **or** in OCR of a payload image fails the build |
| 5.9 | Report writer | CSV + one scoreboard; every row carries n, split, hardware, browser, backend, model versions, policy version, date |
| 5.10 | Held-out guard exercised | One authorised run, with the audit line present in the report naming the reason and date |
| 5.11 | Offline deployment | `docker save`d images + pre-downloaded weights + HF offline mode + internal cert; **verified with the machine's network physically disconnected (AC-10)** |
| 5.12 | **AC-8** | All five metrics plus leak count produced for the corpus, each with n, data source and hardware |
| 5.13 | Failure cases reported | The scoreboard has a failures section: what the system got wrong, per category, with examples — not only aggregate success rates (NFR-15) |
| 5.14 | Performance pass | Every optimisation landed in this phase carries a before/after number from the harness (design.md §19). No change is merged on the argument that it "should" be faster |

---

## 9. Milestone Definition

Phase 5 is **complete** when:

> The team runs `uv run aegis-eval run --split dev` on the reference laptop named in DECISIONS.md.
> Twenty minutes later `reports/2026-XX-XX-dev/scoreboard.md` exists, and it is neither flattering
> nor vague.
>
> Metric 2 reads: structured identifiers, recall 0.99, precision 0.97 over n=241 labelled items;
> free-text entities, recall 0.91, precision 0.88 over n=163 — **below the ≥0.95 free-text target**,
> flagged in red, with the note that NER profile L is the untested remedy and that OQ-7 is
> therefore still open. Metric 3 reads: pixel precision 0.94, over-redaction on hard negatives
> 1.4% over n=72, mean IoU 0.81. Metric 4 reads: 21.4 MB bundled models, peak 212 MB, CPU 11% mean
> / 34% p95 during a task, 0.2% idle — on a named 2019 ThinkPad with integrated graphics, Chrome
> 1xx, WebGPU. Metric 5 reads: p50 840 ms per step, p95 1.9 s, of which the model is 71%. Metric 1
> reads twice, under both interpretations, each labelled.
>
> The leak count reads **0, n=1,204 payloads** — and beneath it, the auditor's own caveat: it
> recovered nothing, using recognizers written independently of the client's, plus a large OCR pass
> over every image sent. Two planted values that the client's cheap detectors missed *were* caught
> by the auditor before they ever reached a payload, because the egress guard blocked those steps —
> and the report says so, with the step ids.
>
> Then they disconnect the network entirely, run `docker compose -f docker-compose.yml up` from
> saved images and a pre-downloaded weights volume, and the demo task completes against a model
> running on a machine that cannot reach the internet.
>
> Nothing in the report is rounded up. The weakest number has its own paragraph.

---

## 10. Files to Create

```
eval/
├── corpus/{dev,heldout}/<200–300 screens>/   # [grow]
├── labels/<screen_id>.json                    # [grow]
├── tasks/<scripted tasks>                     # [new] for metrics 1 and 5
└── src/aegis_eval/
    ├── scorers/{metric1,metric2,metric3,metric4,metric5,leak}.py   # [new]
    ├── auditor/{recognizers,ocr,ner,recover}.py                     # [new] independent
    └── report/{writer,scoreboard,failures}.py                       # [fill]

apps/extension/src/host/privacy/guard/canary.py → canary.ts          # [new] guard step 6

server/deploy/offline/
├── save-images.sh          # [new] docker save
├── fetch-weights.sh        # [new] pre-download to the volume
├── offline.env             # [new] HF_HUB_OFFLINE etc.
└── internal-cert/          # [new]

docs/planning/scoreboard_phase5.md  # [new] the committed result
```

---

## 11. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Harness wall clock, full dev split | `time uv run aegis-eval run --split dev` | Recorded; it runs often enough that it must stay tolerable |
| Auditor throughput | Payloads/second incl. the large OCR pass | Recorded; this is the slow part and it runs offline |
| Scorer determinism | Run twice on the same ledgers | Byte-identical metric output; a non-deterministic scorer cannot support a claim |
| Every product target from Phases 2–4 | The harness | **This is the phase where they stop being targets.** Any that fail are reported as failures, not adjusted |

---

## 12. Forward Dependencies Declared Here

- **Ablations are not run here.** **[Phase 6, F-K11: DOM-only vs pixel-only vs fused, and black-box
  vs typed placeholders. These are the studies that *prove* the architecture's central claims
  rather than assert them, and they need OCR (Phase 6) for the pixel-only arm to be fair.]**
- **The held-out split is spent once.** **[Phase 7 reports it on the live scoreboard (DR-4). There
  is no second chance; if a change lands after the held-out run, the report must say the number
  predates it.]**
- **NER profile L remains untested.** **[Phase 6, gated on this phase's free-text recall number and
  on OQ-7.]**
- **Thresholds are measured but not swept.** **[Phase 6 sweeps the policy thresholds and the
  coverage-escalation knees against the dev split, since policy is data and a sweep needs no code
  change.]**
- **Metric 1's ambiguity is reported, not resolved.** **[OQ-4 can only be closed by the evaluators.
  Phase 7's judge Q&A pack must be ready to explain both readings.]**

---

## 16a. Implementation notes (added during the build, 2026-09-18)

1. **The eval harness still cannot drive a real task.** `eval/src/aegis_eval/runner/collect.py`'s
   `collect_ledger_export` and `runner/drive.py`'s `open_fixture` are both still exactly their
   Phase-1 placeholders — the doc comments in both files say "Phase 2/3 replaces this," but neither
   phase actually did. This is the reason T-5.1's corpus, once grown, still wouldn't produce a real
   scoreboard: the five scorers built this phase have nothing real to score until this integration
   exists. Closing it needs: a way to start a task from outside the panel (e.g. a
   `window.__aegisRunTask` hook `entrypoints/sidepanel/main.tsx` exposes) and a way to read the
   resulting ledger back out (`window.__aegisLedgerExport`), plus a running gateway (replay mode
   needs no GPU — `server/gateway`'s own `.venv` has `uvicorn` installed and could serve this
   locally). This was scoped out of this pass rather than half-built; see HISTORY.
2. **The five scorers are real and tested against synthetic data, not real corpus data**, for
   exactly the reason above. `scorers/{metric1,metric2,metric3,metric4,metric5,leak}.py` implement
   design.md §18.2's definitions precisely and are unit-tested with hand-built (detection,
   ground-truth) pairs; they are ready to score real ledger/label data the moment item 1 exists.
3. **The independent auditor is genuinely independent, not just separately-filed.**
   `auditor/recognizers.py` was written fresh from public identifier-format documentation (PAN,
   IFSC, GSTIN, vehicle registration are all publicly specified standards), not by reading
   `packages/recognizers`' TypeScript source, and its checksum tables are a third independent copy
   alongside `eval/src/aegis_eval/corpus/checksums.py`'s (fixture generation) and the TS client's —
   that module's own docstring already called for exactly this before this phase started.
   `test_auditor_recover.py` proves the auditor recovers a planted leak from nothing but a label's
   hash, never given the plaintext value directly.
4. **A real, useful finding: the client's existing SECRET recognizer already catches full-length
   canaries.** `packages/recognizers/src/patterns/secret.ts`'s generic high-entropy fallback (24+
   chars, Shannon entropy ≥ 3.5) independently flags the eval corpus's own canary format (`CANARY`
   + 22 random chars) as a `SECRET` before guard step 6 (the dedicated canary check) ever gets a
   chance to fire. This is good defense-in-depth, discovered while writing `canary.spec.ts` — the
   test had to use a shorter, sub-threshold probe string to exercise step 6 in isolation.
5. **`generate-internal-cert.sh` is the one offline-deployment script actually run and verified**
   in this environment (`openssl` is installed; `docker` is not, unchanged since Phase 2's
   `docker-compose.yml`) — it produced a real, correctly-dated self-signed certificate. The other
   scripts and `docker-compose.offline.yml` are written to the real intended interface and
   YAML-validated for structure, but not executed.
6. **Corpus growth (T-5.1) was not attempted.** Reaching 200–300 labelled, category-balanced
   screens is real content-authoring work (realistic government/banking/healthcare page mockups,
   correctly distributed across ten categories), not a mechanical script invocation — mechanically
   generating 170+ low-effort fixtures just to report a bigger number would be exactly the kind of
   "rounding up" [SS]'s honesty rule forbids, applied to corpus size instead of a metric.
7. **The held-out split was deliberately not touched.** Design.md §18.4 and this very document
   (§5) are explicit that it is spent once, before submission, with a stated reason. Exercising it
   now — against a harness that (per item 1) cannot yet produce a real scoreboard — would spend
   that one irreversible use for a run with nothing real to report, which is worse than leaving
   T-5.10 undone.

## 16b. Implementation notes, part 2 — closing the harness-integration gap (2026-09-18)

Item 1 above ("the eval harness still cannot drive a real task") was closed the same day. Full
detail — five real bugs found purely by actually running the real system end to end for the first
time, plus one scoring-methodology fix, plus the resulting first-ever real scoreboard's actual
numbers — is in `docs/HISTORY.md`'s second Phase 5 entry, not duplicated here. Summary of what each
bug means for this document's own earlier claims:

- Item 6's "the exact same fixture produces a different canonical hash on every run" reasoning
  (why byte-exact replay was abandoned) held up in practice — confirmed empirically before settling
  on route interception (`gateway_mock.py`) instead.
- The CSP/Ajv bug means `packages/policy` needed the same fix `packages/protocol` already had —
  worth checking any FUTURE schema-validated package added to this project for the same pattern
  before it ships, not just at eval time.
- The double-redaction bug (item 4 in the HISTORY entry) was systemic, not an edge case — it fired
  on every one of 30 real fixtures with a canary or a labelled identifier field, and would have
  gone on being invisible to every existing unit test (which construct synthetic node/text-run
  pairs that don't happen to duplicate each other) indefinitely.
- The canary-guard wiring gap means T-5.8's own "wired into CI" language was aspirational until
  today — the mechanism existed but nothing could reach it. It can now.

## 16c. Implementation notes, part 3 — the two follow-ups, resolved to a real conclusion (2026-09-18)

Both items this document's §16b left open ("the PAN false positive" and "the DOB miss") were
investigated to a definite root cause; full detail in `docs/HISTORY.md`'s third Phase 5 entry.

- **PAN false positive: fixed.** Not the GSTIN itself (its embedded PAN substring has no
  word-boundary for `pan.ts`'s regex to land on) — a second, independent instance of the id-003
  fixture-generator bug, this time in `hardneg-003`'s own generator code. Fixed the same way;
  corpus regenerated; scoreboard improved (PAN FP 1→0, over-redaction on hard negatives 0.25→0.125).
- **DOB miss: root-caused and resolved as spec-consistent behaviour — no code change.** Checked
  both halves directly against design.md rather than treating either as an obvious bug:
  - §6.2 scopes context boosts to "**the owning node's** label, name attribute and autocomplete."
    `forms-004`'s DOB div has no programmatically-associated label (a sibling div, not `<label
    for>`/`aria-labelledby`) — its owning node genuinely has none. `builder.ts` implements exactly
    what §6.2 asks for; a sibling/proximity-based label heuristic is not in the spec, and adding one
    would be inventing behaviour beyond it (CLAUDE.md rule 1), not fixing a defect in what was
    built.
  - §6.2's own hard-negative list names "dates in non-DOB context" explicitly — `hardneg-005` is
    that case, and primary detection correctly passes it through (score 0.3, below the HIGH floor of
    0.35). It is the guard's independent pattern resweep (§7.6 step 4) that over-blocks it, by being
    deliberately context-blind — and CLAUDE.md's fail-closed invariant is the standing project
    principle for exactly this conflict (block over leak). Confirmed a score-gated resweep would
    silence the very case (`forms-004`) it exists to catch, since that DOB scores identically low
    without context — there's no way to tell the two apart from context-blind final bytes alone.
  Decided (see `docs/DECISIONS.md`'s 2026-09-18 entry): accept the over-block on this class of hard
  negative as the correct, fail-closed, spec-consistent outcome for any context-required HIGH+
  recognizer (DOB, PASSPORT today); not a defect, no fix applied.

## 16d. Implementation notes, part 4 — corpus growth 30→66, and two more real bugs (2026-09-18)

Item 6 above ("corpus growth not attempted") is now partially closed: grown to 66 real fixtures
(genuinely new page layouts across all ten named categories, including a `health` category that
had zero fixtures before), not yet the full 200-300. Full detail in `docs/HISTORY.md`'s corpus-
growth entry.

Growing the corpus immediately found two more real bugs, the same way every other bug this phase
was found — by actually running the grown corpus through the real harness, not by inspection:

- The fixture generator's Aadhaar base digits were drawn uniformly 0-9 for all 11 digits since
  Phase 1, when the real format (and the client's own recognizer) constrains the first digit to
  2-9. This had simply never rolled a bad first digit in six prior Aadhaar fixtures across Phases
  1-5; the 7th one (`health-005`, this pass) did, producing the corpus's first genuine leak report.
  Fixed once, centrally (`random_aadhaar_base()`), rather than at each of the 11 call sites
  individually — worth checking for this "a bug that only manifests probabilistically, and only
  got unlucky just now" shape whenever a generator function is called many times across a growing
  corpus.
- The independent auditor (T-5.7) had the *identical* missing constraint in its own from-spec
  reimplementation, which is exactly the kind of independent-but-still-wrong-together scenario
  T-5.7's own design intent (two implementations agreeing is not information; two disagreeing is)
  is supposed to catch — and it did: fixing the client-side generator bug alone left leak count at
  1, now flagging an unrelated field, which is what surfaced the auditor's own bug rather than
  masking it. A useful confirmation that the independence property is pulling its weight, not just
  documented aspirationally.

This document's own §6 lists ten target categories; before this pass, `page.category: "health"`
had zero fixtures despite being named explicitly — worth checking for other named-but-unbuilt
categories before assuming §6's list is fully represented just because *a* fixture exists for
most entries on it.

**Immediate self-correction:** this section's own first draft called `gov-004` "the corpus's first
genuine PASSPORT positive." It wasn't — `gov-004`'s PASSPORT field used `field_html()` (two
unrelated `<div>`s), the exact same context-blind shape as `forms-004`'s DOB, so it could never
score above threshold. Checking the real ledger (not the prose) caught it; fixed by adding
`field_html_input()` (a real `<label for>`-associated `<input>`) and converting just that one
field — PASSPORT is now genuinely 1TP/0FP/0FN. Full account in HISTORY's follow-up entry.

## 16e. Implementation notes, part 5 — corpus growth 66→101, three more real bugs (2026-09-18)

Grew the corpus further (66→101), continuing §16d's growth. Full detail in `docs/HISTORY.md`'s
corresponding entry; summary of what each finding means for this document's own claims:

- A **shared, corrected generator** now exists for two identifier-shaped values that other
  fixtures independently kept re-deriving inline (`random_aadhaar_base()` from §16d,
  `random_bank_account()` new this pass) — worth checking future fixture additions use these
  rather than re-inlining the same `rng.randint`-based digit generation, since that's exactly how
  both underlying bugs (first-digit constraint, phone-shape collision) went unnoticed at first.
- **Not every "hard negative" idea is actually safe to assume** without checking the recognizer's
  real behaviour first. Two of this document's own additions (checksum-invalid GSTIN, masked
  Aadhaar display) were built on the assumption that "checksum fails" or "already masked" implies
  "must pass through" — neither is true here by design (GSTIN's invalid score is 0.40, still
  above the unverified-band floor; masked Aadhaar has its own dedicated 0.70 detection row).
  Before adding a hard negative for a new entity, read that entity's actual recognizer source (or
  its design.md §6.2 row) for what happens on invalid/partial input, rather than assuming "not a
  full valid value" implies "not detected."
- The masked-Aadhaar mislabeling (`hardneg-008`) had been wrong since **Phase 1** — six phases and
  three separate scoreboard runs before this one never caught it, because earlier passes checked
  metric 3's *aggregate* over-redaction rate, not which specific fixtures contributed to it. Once
  a metric's aggregate number looks reasonable, check the per-fixture detail behind it at least
  once before trusting it going forward — an aggregate can hide a specific, long-standing error
  as easily as it can average one out.

**The re-measured scoreboard**: structured macro P/R 1.000/0.822 — the first time every
structured entity in the corpus has shown zero false positives at once. n=101, leak count 0/91.

## 16f. Implementation notes, part 6 — corpus growth 101→131, two more collisions (2026-09-18)

Grew further (101→131) on "ok proceed with phase 5." Full detail in HISTORY's corresponding entry.
Both findings this pass are the *same class* as §16e's BANK_ACCOUNT/PHONE collision — cross-entity
shape collisions in random digit generation — just against different entity pairs:

- `gov-010`'s `random_bank_account()` landed on exactly 12 digits with a coincidentally-valid
  Verhoeff checksum — indistinguishable from Aadhaar. Extended the same shared helper rather than
  writing a second one; worth checking any NEW shared random-digit generator against every real
  recognizer's shape space up front, not just the collision most recently found.
- `hardneg-016` (new) rendered a 16-digit hard negative grouped 4-4-4-4 like every other card
  fixture, which gave `aadhaar.ts`'s regex three word-boundary-delimited 12-digit windows to
  match against — one did. Fixed by removing the grouping (one unbroken digit token has no
  internal word boundary for the regex to anchor to at all) rather than rerolling the random
  seed choice, which would only have reduced the odds, not eliminated them.

**The re-measured scoreboard**: structured macro P/R 1.000/0.818 — zero false positives across
every structured entity, now sustained across two consecutive growth passes. n=131, leak count
0/121. Corpus is 131/200-300; genuinely more real content-authoring work remains.

## 16g. Implementation notes, part 7 — corpus growth 131→138, closing zero-coverage recognizer gaps, a leak-count/policy-class finding (2026-09-18)

Before growing further, counted label items per entity across `generate_all()`'s own output —
the same technique §16e used to find the BANK_ACCOUNT-has-no-recognizer gap. Found three more
entities with a real, implemented Channel T recognizer but zero fixtures anywhere: `CARD_EXPIRY`
(`channel-d.ts`'s `autocomplete=cc-exp`), `PIN_CODE` (`pin.ts`, context-required), `SECRET`
(`secret.ts` — a real pattern/entropy recognizer, not NER as design.md's prose might suggest).
Added one genuine fixture each, plus a hard negative and one more VEHICLE_REG/UPI_VPA instance
(n=2 was too few to trust either recall figure).

`hardneg-018`'s hard negative (a 24-digit unbroken tracking number) is provably safe, not just
probably safe: with no internal `\b` boundary, `aadhaar.ts`/`card.ts`/`phone.ts` have nothing to
anchor a bounded sub-match to, and a digits-only alphabet's maximum possible entropy
(log2(10)≈3.32) is mathematically below `secret.ts`'s 3.5-bit threshold regardless of content.
Verified computationally (mirroring the JS regex semantics in Python) before writing it.

A real finding, not a bug: adding `gov-012`'s genuine, context-matched PIN_CODE moved leak count
0→1. Root cause: `PIN_CODE` is `default.policy.json`'s `LOW` class, `operator: "pass"` — the same
class/operator as DATE/AMOUNT/CITY/COUNTRY (design.md §6.2's "Pass through" row) — so it never
gets a redaction region at any score, by design; its raw value reaching the payload is the policy
working as specified. But design.md §18.2 defines leak count as entity-blind ("recovers **any**
labelled value... → count"), with no policy-class carve-out. No code change — see DECISIONS.md's
2026-09-18 entry, same shape as §16a-c's DOB resolution: root-cause against the spec, and if the
spec already answers it, document rather than "fix" a working design.

**The re-measured scoreboard**: structured macro P/R 1.000/0.802 (micro 1.000/0.812) — the macro
recall drop from 0.818 is arithmetic (a third always-zero-recall row, PIN_CODE, now averaged in;
every non-structurally-blocked entity is 1.000/1.000, including the newly-covered ones) — zero
false positives, a third consecutive clean-precision pass. n=138, leak count 1/128 (the disclosed
PIN_CODE finding above). Over-redaction 0/22 (was 0/21) — `hardneg-018`'s safety held in the real
harness. Corpus is 138/200-300; genuinely more real content-authoring work remains.

## 16h. Implementation notes, part 8 — corpus growth 138→204 (past the 200 floor), the 80/20 split, and T-5.10's real held-out run (2026-09-18)

On "ok just complete the phase 5," pushed through both remaining achievable pieces of T-5.1/T-5.10
in one pass, since the two blocking-on-environment tasks (T-5.13's Docker test, T-5.14's
performance pass) genuinely cannot be closed here regardless of further effort.

**Corpus growth (138→204)**: 13 new builder functions, real content across every category — see
HISTORY's corresponding entry for the full list. Two things worth calling out specifically: the
corpus's first Urdu (Perso-Arabic, right-to-left) page, genuinely new bidi-text rendering territory
rather than another instance of an already-covered script; and 8 new hard negatives, each targeting
a *different* recognizer's own documented invalid/edge path (bad PAN holder-type letter, structurally
-broken IFSC, non-real vehicle state code, Luhn-invalid card, Verhoeff-invalid Aadhaar, a
repetition-based low-entropy SECRET hard negative — a different mechanism than §16g's digit-only
one — a context-free PASSPORT-shaped serial, a PHONE-range-excluded order number), each verified
computationally against the actual regex semantics before writing, not just reasoned about.

**The 80/20 split, finally implemented**: `is_heldout(screen_id)` returns
`sha256(screen_id) % 5 == 0` — a stable per-screen_id hash, deliberately not a seeded
shuffle-then-slice of the fixture list. The reasoning: a positional split reshuffles which
*existing* fixtures are held out every time a later pass adds more (since "last 20%" moves), which
recreates exactly the "become a dev split" risk design.md §18.4 warns about, just from the
generator's own churn instead of a human re-running the split. A hash is fixed per screen_id
forever; growing the corpus further only ever assigns *new* ids to a split. Result: 166 dev / 38
heldout (18.6%), every fixture-purpose group represented in both. `main()` now wipes both corpus
roots before regenerating (the generator had only ever added/overwritten, never removed, a stale
directory — the same staleness class §16f's `hardneg-016` renumbering hit) — this makes the
module's own "idempotent" docstring claim true for directory placement, not just file content. The
paired label-cleanup step's first version deleted `label.schema.json` itself (its stem isn't a
screen_id) — caught immediately by `validate-labels` crashing, restored via `git checkout`, fixed
by naming the one exception explicitly. `test_fixture_boxes_match_dom.py` was dev-only and silently
stopped box-checking the 38 now-heldout fixtures (caught by the test count dropping 283→247) —
fixed to scan both splits; `screenshot_fixtures.py` had the same gap, fixed for consistency though
nothing depends on its output.

**T-5.10's held-out run, spent for real**: `aegis-eval run --split heldout
--i-am-really-using-heldout --reason "..."`, n=38 — structured macro P/R 1.000/0.803, closely
matching the same-day dev split's 1.000/0.798 (exactly what a real split of one generator should
produce, not evidence either number is overfit). Zero FPs, over-redaction 0/2, leak count 0/36.
Disclosed rather than assumed clean: `heldout-audit.log` already had one older entry ("2026-09-17,
testing the guard mechanism") with no matching report directory — almost certainly a direct
exercise of `guard_heldout_access()` during T-5.8's own development, not a full corpus run, so no
scoreboard was produced or looked at that time; this was never recorded in HISTORY.md when it
happened, a real (if minor) process gap in earlier work, now disclosed rather than hidden. Today's
run is the first to actually produce a held-out scoreboard.

**A real bug, found only because this was a genuine held-out run**: the held-out
`rich-scoreboard.md` printed `**split:** dev` in its own header — `runner/main.py`'s
`score_and_write_scoreboard()` hardcoded `split="dev"` in its `Provenance` instead of threading
through the real argument. Scores themselves were correct (metric 2/3 and leak count are computed
from the real held-out payloads independent of this label); only the displayed metadata was wrong.
No unit test caught it because the existing scoreboard tests construct a `Provenance` by hand,
never through this function's own wiring — exactly the class of gap a genuine end-to-end run (vs.
a unit test) exists to catch. Fixed with the split threaded through properly, plus a regression
test; the already-generated report was hand-corrected rather than re-run, since re-running would
have spent the held-out split a second time for no new information.

**Verification**: 284 eval tests (was 220), `validate-labels` clean over all 204 files, idempotent
regeneration, real-Chromium box-check passing on every fixture in both splits. Corpus is now
204/200-300 — past the floor for the first time. T-5.1 and T-5.10 both close as done.

## 16i. Implementation notes, part 9 — metrics 4 and 5 were never actually blocked (2026-09-18)

On "ok lets implement the remaining parts of phase 5," re-checked the standing assumption (stated
in this very document, in TASKS.md, in CURRENT_BUILD.md, repeatedly) that metrics 4 and 5 needed
OQ-16's reference hardware and a live gateway. That assumption was wrong, and had been for a while.

`scorers/metric4.py` and `scorers/metric5.py` were both fully built, real, and unit-tested from
early in Phase 5 — `score_and_write_scoreboard()` in `runner/main.py` just never called either one,
hardcoding `None` with a comment citing OQ-13/OQ-16. Checking what each scorer actually needs
showed both inputs already existed, being collected on every run and simply discarded:

- Metric 4 needs a pooled resource sample and the bundled-model manifest size. `runner/resources.py`'s
  `sample_process_tree` was already sampling once per fixture — its numbers were already visible in
  `scoreboard.csv`'s per-screen rows, just never aggregated. Added `merge_samples()` (pools every
  fixture's raw series rather than averaging pre-aggregated peaks, which understates the true peak)
  and one idle sample per run.
- Metric 5 needs per-step stage timings. `apps/extension/src/host/session.ts` has always computed
  real `StepStageTimings` — observe/perceive/sanitize/guard/server/validate/act — regardless of
  whether the gateway behind `server` is live or mocked, and `Ledger.export()` has always included
  this as `timings` on every entry. Confirmed by reading an already-saved `ledger/*.json` from an
  earlier run: the real millisecond values were sitting there the whole time. Just needed reading.

**A bug, found by reading the number rather than trusting the code ran without error**: the first
attempt's idle CPU (34.2% mean, 115.9% p95) came out higher than task CPU (5.2%/27.0%) — backwards.
The idle sample was taken immediately after `extension_context()` returned, catching the
extension's cold-start bootstrap (service worker init, side-panel pre-load), not steady-state
idle. Fixed with a 2-second settle delay; re-run confirmed sane numbers (idle 1.9%/8.7%, well
below task's 5.3%/35.0%).

**The real numbers** (n=166 dev, this sandbox's own hardware, explicitly stated, not OQ-16's
reference laptop): bundled model 0.2 MB; task peak/mean RSS 1123.8/1108.8 MB; task CPU mean/p95
5.3%/35.0%; idle CPU mean/p95 1.9%/8.7%; stage p50/p95 ms — observe 18/28, perceive 13/22,
sanitize 18/32, guard 43/65 (slowest), server 18/26, validate 9/16, act 2/6; step round trip
125/163 ms; task wall clock 1247.4/1658.6 ms (larger than the stage sum because it includes real
panel/page setup overhead, expected). `model_share_pct` stays unmeasured — no `Server-Timing`
header from the mock gateway, nothing to compute a share of. GPU time stays unmeasured — no GPU.
Metrics 2/3/leak count were unchanged from the prior run, confirming this was a pure
instrumentation addition.

**Verification**: 287 eval tests (was 284: +1 `score_and_write_scoreboard` regression test for
real metric4/5 output, +2 for `merge_samples`). Two full harness runs (before/after the idle-sample
fix).

## 16j. Implementation notes, part 10 — T-5.13's "no Docker" blocker was checking the wrong binary (2026-09-18)

On "ok lets do t5.13," applied the same re-check discipline as §16i to this blocker too: no
`docker` CLI, correct, but `podman 5.8.4` is installed and genuinely functional (verified with a
real `podman run hello-world` before trusting it further, rather than assuming CLI-compatibility
claims).

Verified end to end, for the gateway's replay/demo-fallback topology
(`docker-compose.replay.yml` — no GPU, no vLLM, the path Phase 2 built for exactly this kind of
constrained environment): build the real image from source → save to a tarball → delete the local
image (confirmed gone) → reload purely from the tarball → run with `--network=none` (kernel-level
isolation, confirmed real by a `pip install` inside the container failing for lack of network) →
drive a full real HTTP flow through it (session create, a step matched against a genuinely-seeded,
schema-validated replay entry, returning exactly the seeded plan). `/readyz` correctly reported
503 against an empty store and 200 only once real data existed, proving the readiness check does
real work rather than a stub. One infra wrinkle along the way, not a project bug: a bind-mounted
directory was invisible inside the rootless container despite correct Unix permissions — Fedora's
SELinux enforcing mode needs podman's `:z` volume-relabel suffix, not a workaround to the app.

**Not attempted**: the full live topology (Caddy + gateway + vLLM + real weights,
`docker-compose.offline.yml`). Needs a multi-GB `vllm/vllm-openai` pull and 15GB+ of weights, and
there's still no GPU here for vLLM to serve on regardless — a successful pull proves only that a
process launches. Paused to check with the user before spending that bandwidth/time rather than
assuming it's worth it unasked.

T-5.13 moves from `[ ]` (fully blocked) to `[~]` (partial, real) — AC-10's literal claim is now
genuinely proven for the replay topology; the live topology remains open, gated on a real decision
about whether pulling several GB with no GPU to exercise it is worthwhile, not on more work here.

What remains of Phase 5 now: the live-vLLM half of T-5.13 (a resourcing decision, not blocked
work), T-5.14 (needs an actual performance change to justify — a real baseline now exists), and
metric 1's primary reading (needs a live model, OQ-13, none here).
