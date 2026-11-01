# Phase 7 — The Demo, the Judge Q&A and Submission

**Document type:** Phase 7 execution document
**Requirements basis:** DR-1…DR-6; C-4; NFR-14, NFR-15, NFR-16; **AC-1 and the full AC-1…AC-12 sweep**
**Architecture basis:** `architecture.md` §11.1 (demo reliability), §13.1 (distribution), §13.3 (environments)
**Design basis:** `design.md` §13 (panel as the demo instrument)
**Depends on:** Phases 1–6. Phase 5's held-out scoreboard is the live-scoreboard content; Phase 6's ablations are the follow-up material.

> **Depth note.** Written at lower initial depth and deepened when reached. **What is fixed now is
> the demo script's content (DR-1…DR-6 are requirements, not suggestions), the reliability
> mechanisms, and the honesty rules.** Rehearsal detail grows when the phase begins.

---

## 1. Objective

Everything the project can do already exists by the end of Phase 6. Phase 7's job is to make it
survive contact with a conference hall, and to submit it.

The strategy is blunt about the failure mode here [SS]: the primary path must be fully local, the
server on localhost or a pinned VM with recorded responses, a second configured laptop ready, and a
pre-recorded team-narrated video as the final fallback. None of that is optional polish — a demo
that depends on venue wifi and a rented GPU is a demo that has a coin-flip chance.

**By the end of this phase:** the 30-second demo runs three times in a row without incident, on
either of two laptops, with either a live model or recorded responses; a judge can hand over their
own page and watch it work; the five metrics come up on a live scoreboard from the held-out split;
and six slides are exported to PDF with every link tested **inside the exported PDF**.

---

## 2. The demo requirements — these are requirements, not ideas

| ID | Requirement |
|---|---|
| **DR-1** | **The 30-second demo.** Live page and the actual outbound payload side by side. A page with a visible Aadhaar number, a filled password field and a profile photo. A task that *requires* the sensitive value ("log in and submit the form"). The payload shows placeholders and an obscured face while the page structure stays readable. The task completes with the real value |
| **DR-2** | **Network pulled.** Local detection and redaction keep running with the network disconnected |
| **DR-3** | **Judge's own page.** The agent runs on a page the judge chooses |
| **DR-4** | **Live scoreboard.** The harness runs on the held-out split and shows the five metrics |
| **DR-5** | **Ablation chart** available on request |
| **DR-6** | **Narration by the team.** AI narration reportedly disallowed this year |

DR-1 is the whole pitch in one screen: *the server helped complete a task that required an Aadhaar
number, and never received it.* Everything else is evidence supporting that claim.

---

## 3. Reliability mechanisms

Architecture §11.1 and NFR-14:

| Mechanism | Purpose |
|---|---|
| Primary path fully local | Perception, detection, redaction and the vault need no network at all — which is also what makes DR-2 possible |
| Server on localhost or a pinned VM | No dependency on venue networking for the primary run |
| **Record/replay mode** (FR-45, built Phase 2) | The demo completes with no GPU and no model server, from responses recorded during rehearsal |
| Second configured laptop | Identical build, identical models, identical recordings |
| Pre-recorded narrated video | The final fallback, narrated by the team (DR-6) |

The replay path is the one that matters most and is the most often skipped. It must be rehearsed as
a *first-class* path, not discovered under pressure.

---

## 4. Honesty rules for the demo and the deck

NFR-15 and [SS], and they apply to every number that appears on a slide or is spoken aloud:

- Own baselines only. No competitor comparisons the team did not run.
- No projected ROI. No extrapolated "at scale" claims — any scale claim is a measured load test or
  it is not made (Tier 3, labelled as simulated).
- No rounding up.
- **Failure cases reported alongside success rates.** The judge Q&A pack leads with the weakest
  area, it does not wait to be asked.
- The residual-risk statement (architecture §10.6) is said out loud: *the guard can only find what
  its recognizers can find; here is the leak count and here is n.*
- Anything simulated is labelled as simulated — including the cloud-hosted model during SIH, with
  the offline path documented and demonstrated (Tier 3).

---

## 5. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 7.1 | `docs/demo/demo-script.md` | The 30-second run, the follow-ups, and who says what; timed |
| 7.2 | Demo fixture page | Visible Aadhaar (valid Verhoeff, synthetic), a filled password field, a profile photo; realistic without impersonating a real portal |
| 7.3 | Side-by-side presentation mode | Live page and outbound payload visible simultaneously, legible at projector resolution |
| 7.4 | Airplane-mode rehearsal | **DR-2** — detection and the sanitized preview keep working with the network physically disconnected |
| 7.5 | Judge's-own-page rehearsal | **DR-3** — run on at least 10 unseen real pages; record what breaks, honestly, and whether it fails safe |
| 7.6 | Live scoreboard | **DR-4** — the held-out numbers from Phase 5 displayed, with n and hardware on screen |
| 7.7 | `docs/demo/judge-qa.md` | Residual risks, honest limitations, the metric-1 ambiguity (OQ-4), the vault's memory-zeroing limitation, the leak count with n, and the ablation chart (**DR-5**) |
| 7.8 | **AC-1** | The demo task completes end to end on Chrome, **three consecutive times**, with the live model **and** with recorded responses |
| 7.9 | Second demo laptop | Identical build, models and recordings; the full demo runs on it cold |
| 7.10 | Team-narrated video | **DR-6** — narrated by a person, not synthesised |
| 7.11 | Six slides → PDF | **C-4** — links tested **inside the exported PDF**, not in the source deck |
| 7.12 | Honest README | Measured numbers with their conditions; the limitations section from the project README kept current |
| 7.13 | **Full AC sweep** | AC-1…AC-12 all pass on the reference machine, recorded in CURRENT_BUILD.md's tracker |

---

## 6. Milestone Definition

Phase 7 is **complete** when:

> The team runs the demo three times in a row on the reference laptop with the live model, then
> three more times with the model server switched off entirely and the gateway in replay mode. Six
> clean runs. Then they run it on the second laptop, cold, from a fresh boot. Seven.
>
> A judge walks up, opens their own government portal in a new tab, and asks for it to be run
> there. Nobody on the team has seen this page. The agent grants the site, reads it, redacts an
> email and a phone number it finds in the header, shows the judge exactly what left the machine,
> and completes a two-step task. On a second page it stops and says it cannot proceed safely — and
> the team says so plainly rather than retrying until it looks better.
>
> The judge asks about the numbers. The scoreboard comes up from the held-out split: five metrics,
> a leak count of 0 over n payloads, the hardware named, and one metric flagged in red with the
> team's own explanation of why it is the weakest and what would fix it. The judge asks how they
> know the two detection channels both matter; the ablation table answers it.
>
> Then the six slides, exported to PDF, every link clicked inside the exported file to prove it
> resolves. Submitted before the deadline.

---

## 7. Files to Create

```
docs/demo/
├── demo-script.md          # [new] the 30-second run + follow-ups, timed, with speaker notes
├── judge-qa.md             # [new] residual risks, limitations, weakest-area-first
└── slides/                 # [new] six mandated slides → exported PDF

eval/corpus/heldout/        # [consumed once] Phase 5's authorised run
docs/planning/scoreboard_phase5.md   # [consumed] the live scoreboard content
docs/planning/ablations_phase6.md    # [consumed] DR-5 material
```

---

## 8. Forward Dependencies Declared Here

- **After submission** [SS]: broaden page categories, harden the WASM path, rehearse judge
  questions, prepare the second demo laptop for the finale itself.
- **The held-out split is spent.** Any change landing after Phase 5's authorised run means the
  scoreboard predates the build, and the deck must say so rather than implying the numbers describe
  what is being demonstrated.
- **OQ-4 (what metric 1 measures) can only be closed by the evaluators.** Both readings are
  reported; the Q&A pack must be able to walk through either.

---

## 9. Implementation Notes

- **2026-09-28, T-7.26 — deviation from design.md §6.1 (Channel D).** §6.1's "Name/id/label
  heuristics" row lists ten keywords at score 0.60; the build now classifies every entity from
  field-bound evidence via `packages/recognizers/src/context/field-labels.ts` +
  `apps/extension/src/content/detect/field-semantics.ts`, scored by source (label/aria 0.92,
  autocomplete 0.90, placeholder/type 0.85, title/name-id 0.80, nearby caption 0.75, +0.02 per
  agreeing source, KYC boost unchanged). 0.60 sat below MEDIUM's 0.70 threshold, so a label alone
  could never seal a PERSON_NAME/USERNAME/IFSC field. Also `[A]`: a visible label outranks
  `autocomplete` (design is silent on the order), fusion takes the node's entity from Channel D
  when one exists (§7.1 step 4 says "entity = highest class"; class is still the highest), and the
  guard's pattern re-sweep scans payload strings rather than raw bytes (matches F-E03's "every
  string"; raw bytes include float box coordinates). See HISTORY 2026-09-28 "Semantic-first field
  redaction".
