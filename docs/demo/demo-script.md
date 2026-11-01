# Demo script — the 30-second run and follow-ups

**Task basis:** phase_7_demo_submission.md §2 (DR-1…DR-6), §5 (T-7.1)
**Fixture:** [`apps/extension/test/fixtures/demo-login.html`](../../apps/extension/test/fixtures/demo-login.html)
(also proven for real in [`apps/extension/test/e2e/demo-fixture.spec.ts`](../../apps/extension/test/e2e/demo-fixture.spec.ts) — 3/3 passing against a real Chromium layout)
**Status:** script content fixed now, per the phase doc's depth note. **Timings below are estimates, not rehearsed** — no human has run this script yet in this environment. Replace the bracketed estimates with real stopwatch numbers on first rehearsal, and do not present the estimates as measured.

---

## Cast

| Role | Says |
|---|---|
| **Operator** | Drives the laptop, narrates the technical beats (DR-6: team-narrated, no AI narration) |
| **Second team member** | Fields the judge's own-page request (DR-3) and the numbers questions (hands off to judge-qa.md) |

---

## 0. Setup (before the judge arrives, not timed)

1. Chrome (or Chromium) open, AEGIS extension loaded, side panel docked to the right so the live
   page and the panel are visible side by side — this satisfies T-7.3 structurally: the panel *is*
   a side panel, not a separate window, so "live page and outbound payload side by side" is the
   default layout, not a special mode. Verify at the actual venue's projector resolution before
   the event — this has not been checked outside a laptop screen in this environment.
2. Open `apps/extension/test/fixtures/demo-login.html` in the main tab.
3. Confirm the gateway is reachable (live model) **or** record/replay mode is active with a
   rehearsed recording for this exact fixture (§3 reliability mechanisms; T-7.8 needs both paths
   proven with three consecutive clean runs each — not yet done, see judge-qa.md's status note).
4. Settings panel: confirm "Show raw payload" is **on** (design.md §13.5's own demo default) so
   the JSON is visible without an extra click.

---

## 1. The 30-second run (DR-1)

> **The claim, said out loud before starting:** "This page has a real Aadhaar number, a filled
> password, and a profile photo. Watch what the server actually receives."

| Beat | Action | What the judge sees | Est. time |
|---|---|---|---|
| 1 | Operator types the task: `log in and submit the form` and clicks run | Panel moves to "Running" | [~2s] |
| 2 | — | Step card appears: observe → perceive → guard timings | [~3s] |
| 3 | Operator points at the panel's "What the server saw" tab | Sanitized image (face region greyed/boxed) + JSON showing `⟪AADHAAR#1⟫`, a `PASSWORD` presence-only entry with no value, no plaintext Aadhaar digits anywhere | [~5s] |
| 4 | — | Panel shows the planned action: `type ⟪AADHAAR#2⟫ into "Aadhaar number"` (if the task includes a confirm-Aadhaar field) or a direct submit plan | [~3s] |
| 5 | Operator clicks **Allow** if a confirmation card appears | The real value is written into the real DOM field, locally, never round-tripping through the server | [~3s] |
| 6 | — | Fixture's own success state appears: "Signed in successfully." | [~2s] |
| 7 | Operator says the line: **"The server helped complete a task that required an Aadhaar number, and never received it."** | — | [~3s] |

**Total: roughly 20 seconds of action, ~10 seconds of narration — an estimate to be corrected by
rehearsal, not a measured figure.**

**Known gap to disclose if asked, not hidden:** the profile photo in this fixture is a synthetic
placeholder (no licensable face photo exists in the build/dev environment — see
`apps/extension/src/perception/models/face.ts`'s own disclosure and
`test/browser/face-pipeline.spec.ts`). The redaction *plumbing* for the photo is real and verified
(the `<img>` is extracted as a real vision-eligible node, composited through the same additive
compositor as any other image); **whether YuNet actually detects a face in it has never been
checked against a real photograph in this environment.** Before the actual event: swap in a real,
consented demo photo and rehearse the detection actually firing. If that has not happened by demo
day, don't claim face redaction fired — describe it as "the same pipeline that redacts documents
and photos, shown here on a document; face redaction is proven separately in the scoreboard."

---

## 2. Follow-ups (on request, not part of the 30-second beat)

### 2.1 Network pulled (DR-2)
Physically disconnect Wi-Fi/ethernet. Re-run the same task. Detection and the sanitized preview
(panel's "What the server saw" tab) must keep working — this is a local-only pipeline
(perception/detection/redaction never touch the network; only `host/egress/` does). The task
itself won't *complete* with the network off (no server to talk to) — say so; that's expected, not
a bug. **Not yet rehearsed in this environment** (T-7.4 is open).

### 2.2 Judge's own page (DR-3)
Judge names a page. Operator navigates there, grants the extension access to that origin (the
real permission prompt — not `<all_urls>`, that's debug-build-only per `wxt.config.ts`), runs a
task the judge suggests. **Not yet rehearsed against 10 real unseen pages** (T-7.5 is open) — see
judge-qa.md's honest status on this.

### 2.3 Live scoreboard (DR-4)
Open the held-out scoreboard: `eval/reports/2026-09-18T145854Z-heldout/rich-scoreboard.md`
(n=38, the one-time authorised held-out run — see phase_5_measurement.md's discipline note; it is
never re-run to make the numbers look better). Point at:
- Structured-entity recall 0.803, precision 1.000
- Redaction pixel precision 0.981, over-redaction rate on hard negatives 0.0000
- **Leak count: 0, n=36 payloads**
- Metric 1 (task success) and Metric 4/5 (resources/latency) are **not measured** on this split —
  say this before being asked (NFR-15's honesty rule). Dev-split numbers exist for 4/5
  (`eval/reports/` dev runs — see judge-qa.md) but are explicitly a different, non-authorised
  split, and must be labelled as such if shown.

### 2.4 Ablation chart (DR-5)
`docs/planning/ablations_phase6.md` — fused vs. dom_only vs. pixel_only vs. blackbox, n=166 (dev
split, all four arms, zero errors). Headline: fused shows real measured recall improvement over
dom_only on structured entities (0.826 vs 0.798); pixel_only degrades sharply (0.240 macro recall)
as expected; blackbox matches fused on redaction correctness (placeholder labelling doesn't affect
what gets redacted, only what the server can reason about).

---

## 3. What is NOT yet true, said plainly here rather than discovered on stage

- **Three consecutive clean runs (AC-1/T-7.8) have not been executed.** This script has not been
  rehearsed even once end to end in this environment.
- **Record/replay fallback exists (FR-45, Phase 2) but has not been rehearsed as the primary
  demo path** — only proven via `docker-compose.replay.yml`'s isolated topology test
  (`server/gateway/tests`), not through this exact fixture and this exact panel flow.
- **Second laptop (T-7.9) does not exist as a checked, configured device** in this record.
- **No team-narrated video exists yet** (T-7.10).
- **Metric 1 (task success) has never been measured**, on any split — OQ-13 (no GPU, no live
  model in this environment) blocks it. The scoreboard must show this as `—`, not a guess.

This section exists so nobody on the team is surprised by a gap discovered live. Update it as each
gap closes, and delete a line only once the corresponding task in TASKS.md is checked off with a
real verification behind it.
