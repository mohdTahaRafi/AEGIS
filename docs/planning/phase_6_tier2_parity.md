# Phase 6 — Tier 2: Firefox Parity, OCR, Canvas/PDF Categories, Ablations & Settings

**Document type:** Phase 6 execution document
**Requirements basis:** FR-2, FR-8, FR-12, FR-35, FR-36, FR-53; NFR-11, NFR-16; **AC-12**
**Architecture basis:** `architecture.md` §5.1 (platform facts), §6.3 (OCR, NER profile L), §12.3 (ablations), §16 (Tier 2 and the cut order)
**Design basis:** `design.md` §5.5 (volatile, hostile-dynamic), §6.3 (NER profiles), §6.4 (OCR), §13.5 (settings), §14 (platform abstraction), §18.3 (ablation runner)
**Depends on:** Phases 1–5 in full. The ablation runner needs the Phase 5 scorers; the pixel-only arm needs the OCR this phase builds; profile L's decision needs Phase 5's measured free-text recall.

> **Depth note.** Written at lower initial depth and deepened when reached. **What is fixed now is
> the cut order, the fact that Firefox is a PS requirement rather than an optional extra, and the
> ablation definitions.** File-level detail grows when the phase begins.

---

## 1. Objective

Phase 6 closes the gap between "works on Chrome, on well-structured pages" and what the problem
statement actually asked for.

Two of its items are not really Tier 2 at all. **FR-2 requires Firefox** [PS]; the strategy merely
*scheduled* it after Tier 1 [SS], and product-requirements §5 flags the tension explicitly: "the
Firefox build is a PS requirement that the team has chosen to schedule after Tier 1; it should not
be dropped from the final submission" (OQ-12). **FR-12 requires analysis of content not represented
in the DOM** [SS] — canvas, images, video, PDF viewers — and without OCR those regions are merely
grey rather than analysed. Phase 4 made them safe; Phase 6 makes them useful.

The rest is genuinely optional and genuinely valuable: the ablations are what turn the
architecture's central claims into measurements.

**By the end of this phase:** the demo task completes on Firefox; a PDF.js viewer and a
canvas-rendered app are handled end to end with real OCR; and `ablations_phase6.md` contains a table
showing what DOM-only leaks, what pixel-only costs, and what black-box redaction does to metric 1
compared with typed placeholders.

---

## 2. The cut order — what goes first if time runs out

Architecture §16, unchanged and binding:

1. OCR on low-priority regions
2. NER profile L
3. Deltas
4. Firefox parity

**Never cut:** the additive compositor, the vault-leak check, the canary test. "They are what make
the privacy claim true rather than asserted."

Note that Firefox is *last* on the cut list, i.e. the last thing to be given up — consistent with it
being a PS requirement rather than a nicety.

---

## 3. Firefox parity (AC-12)

Design.md §14's table, every row verified on real Firefox rather than against documentation.

| Capability | Chrome | Firefox | Consequence |
|---|---|---|---|
| Panel host | `side_panel` | `sidebar_action` | WXT maps both from one entrypoint (verified Phase 0) |
| Closed shadow roots | `chrome.dom.openOrClosedShadowRoot(el)` | `el.openOrClosedShadowRoot` | Both work — architecture §1.3 C-8(a) |
| Cross-origin isolation | Manifest COEP/COOP → threads | **Not available to normal extensions** | Firefox WASM is single-threaded, permanently |
| WebGPU | Default on Win/macOS/ChromeOS/Android | Default on Win/macOS; **Linux behind a preference as of 152–155** | The WASM path is the Linux path |
| MV3 signing | Not needed unpacked | `browser_specific_settings.gecko.id` | Set since Phase 0 |
| Capture | `captureVisibleTab` ≤2/s | `captureVisibleTab` | Rate limit differs; verify |

AC-12 has two halves: the demo task completes on Firefox (Windows or macOS), **and** the WASM path
works on Firefox on Linux. The second half is the NFR-11 portability claim, and it is the one most
likely to be quietly skipped.

---

## 4. OCR

Architecture §6.3's selection: **PP-OCRv5 mobile** detection (~4.6–4.8 MB) + recognition (~16 MB
multilingual ONNX), Apache-2.0, purpose-built and small. A Latin/English-only recognizer may be
smaller — measure rather than assume.

Design.md §6.4: detector on unexplained regions (long side ≤ 960 px), recognizer on detected lines
(height 48 px). **Script routing** — if charset detection or the page `lang` suggests Devanagari,
use the Devanagari recognizer where bundled. Word boxes derived by proportional splitting of line
boxes when character positions are available; otherwise **line-level redaction** (fusion §7.1
step 8), which is the fail-closed choice.

OCR is what makes three things work at once: the canvas/PDF categories (FR-12), the guard's halo
re-scan (Phase 4 §8), and the Indic coverage that A-4 anticipates.

It is also **first on the cut list**, because it is the largest single addition to the model budget
and metric 4 is 20%.

---

## 5. Ablations — the studies that prove the architecture

Design.md §18.3. Config switches in a **debug build only**, never exposed in the normal UI:

| Ablation | Switch | The claim it tests |
|---|---|---|
| DOM-only | Disable Channel V; never attach images | *DOM-only leaks on canvas/PDF/image pages.* Expect metric 2 recall to collapse on those categories |
| Pixel-only | Ignore Channel D and DOM text; OCR the full frame | *Pixel-only is slower and type-blind.* Expect metric 5 to worsen and metric 3 to suffer from line-level boxes |
| Fused | Default | The claim |
| Black-box vs placeholder | Render redactions as unlabelled black boxes, send no refs | *Black-box redaction destroys the context the server needs.* Expect metric 1 to drop sharply while metric 2 is unchanged |

The fourth is the most important experiment in the project. [SS]'s entire thesis is that typed
placeholders let metrics 1, 2 and 3 improve together instead of trading off. That is currently an
argument. This ablation makes it a number — and if the number does not support it, that must be
reported too (NFR-15).

Each ablation runs the same corpus and tasks; results land in one comparison table.

---

## 6. Other Tier 2 work

| Item | Source | Note |
|---|---|---|
| Volatile regions + hostile-dynamic mode | design.md §5.5, F-B10 | Node mutating >3×/s → `⟪LIVE⟫`, not a plan target without fresh observation; >20 semantic changes/s for 2 s → image path disabled, CPU capped, stop with an explanation. Phase 2 already computes the counters |
| NER profile L | architecture §6.3, OQ-7 | OpenAI Privacy Filter q4, WebGPU only, behind a setting. ~770 MB reported on first load — a metric-4 problem. **Only ship it if Phase 5's free-text recall missed NFR-2's ≥0.95 and profile L measurably closes the gap** |
| CAPTCHA detection and hand-off | FR-8, NG-8 | Detect, label, stop, hand control to the user. The agent must never solve one |
| Settings UI | FR-35, design.md §13.5 | Server URL/token, backend, NER profile, policy, debug overlay, show raw payload, per-entity redaction policy |
| Session un-redact | FR-36 (P3) | The only de-escalation path besides a versioned allow-rule — must be auditable in the ledger |
| Threshold sweeps | Phase 5 forward dep | Policy is data; sweeping needs no code change |

---

## 7. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 6.1 | Firefox build: gecko id, sidebar host, single-thread WASM | Temporary add-on loads; sidebar opens; `crossOriginIsolated === false` and the thread count is 1 |
| 6.2 | Platform shim parity for every design.md §14 row | A table of **observed** values on real Chrome and real Firefox, not documentation claims |
| 6.3 | PP-OCRv5 det + rec integrated | Text in a canvas region is detected and recognised; model sizes recorded against the metric-4 budget |
| 6.4 | Devanagari routing | A Devanagari page routes to the Devanagari recognizer; an Aadhaar number in Devanagari digits is detected (normalisation from Phase 3 does the rest) |
| 6.5 | Canvas-rendered app category end to end | A canvas form is perceived, redacted and acted on; coverage escalation produces L1 |
| 6.6 | PDF.js viewer category end to end | A PDF with an ID number is handled; the number is redacted; the document stays readable to the model |
| 6.7 | Volatile `⟪LIVE⟫` + hostile-dynamic mode | A 10 Hz-updating counter becomes `⟪LIVE⟫` and cannot be a plan target; a mutation storm disables the image path and eventually stops with an explanation |
| 6.8 | NER profile L behind a setting | Loads only on WebGPU; its weight cost is shown in the resource bar; **the default stays S unless the harness says otherwise** |
| 6.9 | Ablation switches in a debug build | Not reachable from the normal UI; asserted by a build-output check on the release build |
| 6.10 | Ablation runner + comparison table | All four arms run on the same corpus and tasks; `ablations_phase6.md` holds one table with n and hardware |
| 6.11 | Settings UI | Every design.md §13.5 row present; settings stored in `storage.local`; **never contains vault values or captures** |
| 6.12 | Session un-redact | A user-un-redacted region is recorded in the ledger with its reason; it expires with the session |
| 6.13 | CAPTCHA detection and hand-off | A reCAPTCHA fixture is labelled, the agent stops, control returns to the user; **no solving attempt is ever made** |
| 6.14 | **AC-12** | The demo task completes on Firefox (Windows or macOS); the WASM path works on Firefox on Linux |

---

## 8. Milestone Definition

Phase 6 is **complete** when:

> A judge asks to see it on Firefox. The team loads the temporary add-on, opens the sidebar, and
> runs the same task. It works — slower, single-threaded, with the resource bar honestly reading
> *WASM · threads 1* — and the payload viewer shows the same placeholders it showed on Chrome.
>
> They then open a PDF.js viewer holding a scanned enrolment form. The DOM explains almost nothing;
> coverage reads 34%. OCR runs over the unexplained region, finds the twelve-digit number, Verhoeff
> confirms it, and the sanitized image comes back with a labelled `⟪AADHAAR#7⟫` box over it and the
> rest of the document perfectly readable. The same on a canvas-rendered dashboard.
>
> The judge asks the obvious question: *how do you know the two channels are both earning their
> keep?* The team opens `ablations_phase6.md`. DOM-only: metric 2 recall on the canvas and PDF
> categories drops from 0.97 to 0.31 — the leak the fusion exists to prevent, measured. Pixel-only:
> metric 5 p95 nearly doubles and metric 3 falls, because line-level boxes over-redact. And the
> fourth row: black-box redaction holds metric 2 exactly steady while metric 1 falls by a third —
> the typed-placeholder thesis, no longer an argument.

---

## 9. Files to Create

```
apps/extension/
├── src/perception/models/{ocr-det,ocr-rec,script-route}.ts   # [new]
├── src/perception/models/pii-ner.ts                          # [modify] profile L branch
├── src/content/observe/{volatile,hostile-dynamic}.ts         # [new]
├── src/content/detect/captcha.ts                             # [new]
├── src/host/platform/*                                        # [modify] Firefox rows
├── src/host/privacy/policy/unredact.ts                       # [new]
├── src/ui/Settings.tsx                                        # [new]
└── src/debug/ablations.ts                                     # [new] debug builds only

eval/src/aegis_eval/ablations/{dom_only,pixel_only,fused,blackbox}.py   # [new]
eval/corpus/dev/{canvas-*,pdfjs-*,indic-*}/                              # [grow]

docs/planning/ablations_phase6.md                              # [new] the committed result
```

---

## 10. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| OCR det + rec, per frame | Worker timings | ≤ 60 ms for unexplained regions (design.md §10.2) |
| Model budget after OCR | Manifest sum | Recorded — this is the biggest metric-4 regression in the project; if it is unacceptable, OCR is cut first |
| Firefox WASM latency | Same corpus, both browsers | Reported side by side; never averaged with Chrome |
| NER profile L cost | Load time, memory, latency | Compared against profile S on the same corpus, with the recall gain stated beside the resource cost |
| Ablation arms | Full corpus per arm | Each arm carries its own n and hardware |

---

## 11. Forward Dependencies Declared Here

- **The ablation results feed the deck.** **[Phase 7: DR-5 requires the ablation chart to be
  available on request.]**
- **Firefox is verified on one OS family at a time.** **[AC-12 asks for the task on Windows or
  macOS and the WASM path on Linux. Full three-OS parity is not claimed and must not be implied.]**
- **Profile L may ship disabled.** **[If Phase 5's free-text recall met NFR-2, shipping 770 MB of
  weights to improve a metric that already passes would be a net loss on metric 4. Record the
  decision either way in DECISIONS.md against OQ-7.]**

---

## 12. Implementation notes (added during the build, 2026-09-18)

**Firefox (T-6.1/6.2/6.14): checked for real, genuinely blocked.** A real system Firefox 155.0 is
installed (`/usr/bin/firefox`), but Playwright needs its own patched build (the juggler
remote-debugging protocol) — the system binary just exits when launched via Playwright rather than
speaking that protocol. `playwright install firefox` hung 35+ minutes with zero progress; direct
`curl` probes of the Playwright CDN hosts returned nothing, confirming a real network block (unlike
`podman`'s container registry in Phase 5's T-5.13, which worked). This is a genuine, verified
environment block, not an inherited assumption — don't re-attempt without either a different
Firefox automation approach (e.g. `webdriver-bidi` against the system binary directly, untried) or
network access to Playwright's CDN.

**OCR (T-6.3/T-6.4): done, real, verified.** Architecture.md §6.3 names PP-OCRv5 mobile but cites
no concrete source ("measure"). Real ONNX exports sourced from RapidAI/RapidOCR (ModelScope-hosted,
`v3.9.2`), sha256-verified against RapidOCR's own published hashes: `ch_PP-OCRv5_det_mobile.onnx`,
`en_PP-OCRv5_rec_mobile.onnx`, `devanagari_PP-OCRv5_rec_mobile.onnx` + dict files. Real ORT
introspection (not the architecture doc's assumption) showed the detector is a DBNet-style
segmentation head, not an anchor decoder — post-processing transcribed from PaddleOCR's real
`DBPostProcess` source (`thresh=0.3`/`box_thresh=0.7`/`unclip_ratio=2.0`/`min_size=3`), with a
disclosed simplification (axis-aligned boxes, not rotated `minAreaRect`+Vatti-clipping — deliberate
for AEGIS's screen-content domain, not a shortcut). CTC vocabulary construction
(`['blank']+dict+[' ']`) verified against PaddleOCR's real source AND cross-checked against the
real bundled models' own output dimensions (438 = 1+436+1 English, 570 = 1+568+1 Devanagari).

**Real accuracy proof** (OCR has no photo-licensing barrier, unlike Phase 4's face detection):
rendered "HELLO WORLD" and "आधार" (Aadhaar) via real `<canvas>` text, both decoded back **exactly**
through the full real detect→crop→recognize pipeline. See `docs/HISTORY.md`'s 2026-09-18 entry for
the full account, including a resource-contention finding in the full test suite (mitigated by
sharing ONNX sessions across a test file's cases rather than reloading per test) and the files
touched. Not yet wired into the fusion pipeline, guard halo re-scan, or any canvas/PDF corpus
category (T-6.5/T-6.6) — this was model-integration only.

## 13. Implementation notes, part 2 — T-4.18's halo re-scan closed for real (2026-09-19)

The first real consumer of §12's OCR work: `perception/rescan/halo.ts`'s `checkHalosForText`,
a permanent no-op since Phase 4 explicitly waiting on this model ("no OCR model exists until
Phase 6"). Now runs the real det+en-rec pipeline over each halo crop of the composed image,
flagging a hit only when text is both detected AND decoded to non-trivial content — detection
alone would flag the DB detector's own thresholded noise too often to be a useful safety net.

Wiring touched `worker-protocol.ts` (`ModelSpec.role` extended with `ocr-det`/`ocr-rec`, plus
`script`/`dictUrl`/`dictSha256`), `runtime/sessions.ts` (`ModelRegistry.getDict()`, verified
through the same one disclosed fetch exception — confirmed scoped to the whole file, not widened),
`worker.ts` (lazy-loads OCR on first rescan use, never resident), and `main.tsx` (three more
hand-duplicated `ModelSpec` constants, same pattern as `FACE_MODEL_SPEC`).

A real bug in the FIRST version of this work's own test, not the implementation: placing a whole
word 24-150px from a redaction box and expecting `HALO_PX=24` to reach it — it can't, by design;
the halo's real job is a few leftover pixels at a box's own edge, not a distant separate word.
Fixed by testing the actually-intended scenario (a value redacted all but its trailing ~15px).

Verification: 3 new real-Chromium tests, 496 total (was 493), `tsc`/lint/no-network-scan all clean.
See `docs/HISTORY.md`'s 2026-09-19 entry for the full account. Still open: the halo re-scan is
English-only (a disclosed, coarse-safety-net simplification, not script-routed); OCR is still not
in the fusion pipeline's DETECTION half (T-6.5/T-6.6 — finding NEW PII in an unexplained region,
not just re-checking an already-redacted one).

## 14. Implementation notes, part 3 — T-6.5/T-6.6's detection-side wiring (2026-09-19)

The gap §13 left open: OCR existed and worked, but nothing in `handlePerceive` ever called it —
`checkHalosForText` only re-verifies pixels already decided to be redacted. `perception/detect/
text-region.ts` is the new detection-side pass: for each admitted vision-node crop (canvas/img/
video — the same crops `detectFaces` already runs on), it runs the real det+rec pipeline, then
feeds every decoded line through `@aegis/recognizers`'s `findAll` — `perception` may import
`packages/*` at runtime (architecture §15.3: pure logic, no browser APIs), so this stays a
self-contained worker-side pass rather than a new host round trip carrying raw decoded text
across the worker/host boundary. The result is a ready `Candidate` (`channel: 'text-ocr'`) that
needs zero new fusion code: `fusion/index.ts`'s `fuse()` already treats every candidate the same
regardless of channel, and design.md §7.1 step 8 ("OCR line fallback") turned out to already be
this implementation's *only* path for OCR-derived boxes — the bundled recognizer's CTC decode
gives per-line text with no character positions at all, so there is nothing to proportionally
split; every match fails closed to the whole detected line, unconditionally.

Both capabilities (face, OCR) now run inside one per-region job in `handlePerceive`, sharing the
crop and the deadline slot, rather than two separately-queued jobs at the queue's `face`/`ocr`
priority bands — a disclosed simplification: design.md §11.4's face > OCR ordering is about which
capability the (still entirely unwired) degradation ladder sheds first under load, not about
interleaving within one region. `unexplained[]` (FR-12's own schema field, a permanent `[]` since
Phase 4) is now populated for real from every `role:'img'` node — that required threading a new
`tagName` field through `RawScreenNode`/`WireScreenNode` (content script → wire), since
`computeRole`'s CANVAS/VIDEO→`'img'` overload (T-4.x) had already thrown away the information
needed to tell a canvas from a real `<img>` for the schema's `reason` enum.

**A real, pre-existing bug found and fixed in the course of this work, not introduced by it:**
`context/builder.ts`'s node loop only ever minted a region into a placeholder ref through
`toNodeValue`, which bails out immediately for any node with no `field` — true for every
canvas/img/video node. A FACE region on a canvas silently got `ref: null` since Phase 4; nothing
noticed because a face candidate has no `value` to mint anyway (`replacementFor` returns a bare
`⟪FACE⟫` either way). An OCR candidate's `value` (the actual decoded text) made this a real,
visible bug: without the fix, the compositor would draw an unlabelled black box over a found
Aadhaar number instead of the typed `⟪AADHAAR#N⟫` placeholder design.md's own milestone demo
describes. Fixed by minting directly from the region when the node has no field, the same call
`sanitizeFreeText` already makes for a free-text match.

**T-6.6 specifically — a real, non-obvious finding about "PDF.js viewer category":** a typical
PDF.js viewer also renders an invisible `.textLayer` of real DOM text on top of its canvas (for
selection/accessibility), which Channel D/T would already read without any OCR at all. Design.md
§7's own milestone scenario is specifically a *scanned* enrolment form — a PDF page with no
extractable text, only a rasterized image — which is the case that actually needs OCR, and which
is, from this extension's point of view, identical to the canvas-app case above (an opaque
`<canvas>` the DOM cannot explain). Verified for real, not assumed: added `pdfjs-dist` as a
devDependency (test-only — the extension never renders PDFs itself), hand-built a minimal
single-page PDF with a FlateDecode image XObject and zero text-showing operators, loaded it
through the real library, confirmed `page.getTextContent()` is genuinely empty, rendered it to a
real canvas, and ran the same detection-side OCR pass over it — it found the embedded Aadhaar
number. The existing dev/heldout `pdf-*` corpus fixtures remain disclosed placeholder divs (fully
DOM-visible, no OCR exercised) — this test, not the Python corpus, is what closes T-6.6 for real
this pass; a genuine PDF.js-embedded corpus fixture is still a follow-up for the `eval/` harness.

Verification: 8 new unit tests (`test/unit/context-builder.spec.ts`) + 4 new real-Chromium tests
(`test/browser/{ocr-detection,pdf-scanned-canvas}.spec.ts`), `tsc`/lint/no-network-scan all clean.
See `docs/HISTORY.md`'s 2026-09-19 entry for the full account.

Still open: this detection path is English-only (script routing, T-6.4, exists but is unused here
— same disclosed gap as the halo re-scan, since neither caller threads the page's `lang` into the
worker); the degradation ladder's `no-ocr` rung (`schedule/ladder.ts`) is fully implemented, unit-
tested, and has zero consumers anywhere in the codebase; nothing exercises this new path through
the full `session.ts` step loop into a real guard→gateway→executed action (T-6.5's AC's "acted
on" half) — only detection, fusion, minting and redaction are verified end to end this pass.

## 15. Implementation notes, part 4 — T-6.8/OQ-7 investigated (2026-09-19); T-6.7 closed for real

**T-6.8 (NER profile L): investigated, not built — genuinely unverifiable here, not merely
skipped.** §6's own shipping condition needs both halves to hold: Phase 5's free-text recall
missing NFR-2's ≥0.95 (confirmed true — the real dev scoreboard reports 0.250 macro/0.697 micro —
but root-caused as neither NER profile ever having real weights, not profile S specifically
underperforming), AND profile L "measurably closing the gap." The second half is checked, not
assumed: a real-Chromium test called `navigator.gpu.requestAdapter()` directly — the API surface
exists, but the call returns `null`, confirmed fresh today, not inherited from design.md/
architecture's older WebGPU note. Profile L is explicitly WebGPU-only (~770 MB, OpenAI Privacy
Filter q4), so there is no execution path to measure at all here — the same root cause as OQ-13's
live-model gap. Decided (recorded against OQ-7 in DECISIONS.md, user consulted first given the
resourcing tradeoff): not built this pass; default stays profile S. Building just the call-shape/
settings-toggle wiring (the ViT/NER-S stub pattern) was considered and rejected — unlike those
stubs, there is no way to even structurally exercise it, and the shipping condition explicitly
requires a measured claim.

**T-6.7 (volatile nodes + hostile-dynamic mode): done, real, end-to-end verified.** design.md
§5.5's rate-based signals had real classification/epoch infrastructure since Phase 2
(`content/observe/{classify,epochs}.ts`) but zero rate/frequency tracking, by that phase's own
disclosed deferral. New `content/observe/volatility.ts`: `VolatilityTracker` (per-element,
`WeakMap`-keyed, counts every mutation regardless of class — design's own "clocks/counters"
example is itself classified cosmetic, so excluding cosmetic mutations would miss the textbook
case; `>3` in a trailing 1000ms window → volatile) and `HostileDynamicTracker` (global,
non-cosmetic only; `>40` in a trailing 2000ms window, i.e. `20/s × 2s` read as "sustained" without
a continuous rate state machine → hostile-dynamic).

Wired through the whole pipeline: `startObserving` (5th optional param — every pre-existing
4-arg call site unaffected) records into both trackers and fires `onHostileDynamicChange` only on
a transition edge; `extractScreenGraph`/`extractTextRuns` take a real `isVolatile` predicate now
(text runs needed their own flag — a clock `<span>` has no interactive affordance, so it's a
`TextRun`, not a graph node, and node-level `volatile` alone would have missed design's own
primary example entirely); `runPreflight` rejects a currently-volatile target with a new
`NODE_VOLATILE` reason, checked live immediately before dispatch (no TOCTOU gap, same reasoning
every other facet in that file already uses); `builder.ts` replaces a volatile node's/run's text
with the literal `⟪LIVE⟫` (deliberately unescaped — it's meant to look like a placeholder) and
skips Channel D/T entirely for it (nothing worth detecting or minting for a value that might be
stale by read time); `session.ts` disables the image path for a hostile-dynamic step (reusing the
exact `perceptionResult = null` shape a step with no `deps.perception` already produces) and
stops with a new `HOSTILE_DYNAMIC` reason after >3 consecutive hostile-dynamic steps, not the
first reading — "eventually stops," giving a brief storm a chance to settle; `port.ts` caps the
mutation-triggered auto-resend cadence to 500ms while hostile-dynamic, the other half of
"observation cadence... capped."

**A real, pre-existing bug found and fixed along the way, unrelated to T-6.7 itself:**
`builder.ts` had 5 literal NUL bytes sitting inside template-literal dedup keys where a space was
clearly intended — confirmed via `git show HEAD` to already be present in committed history, not
introduced this session. Harmless in practice (JS string equality tolerates embedded NULs, and
both sides of each lookup used the same corrupted key consistently) but clearly unintended; fixed.

Verification: 13 new real-Chromium tests (`test/browser/volatility.spec.ts`, including a real
mutation-storm test that empirically trips the hostile-dynamic transition) + 5 unit + 2 preflight
+ 2 session tests. 508→530 extension tests, `tsc`/lint/no-network-scan all clean. See
`docs/HISTORY.md`'s 2026-09-19 entries for the full account.

Still open: cross-frame volatility is a disclosed no-op (the observer only watches the top
document's body, the same pre-existing scope limit epoch tracking already has); `⟪LIVE⟫` has no
vault/audit trail entry by design (nothing to mint) — a deliberate difference from every other
placeholder.
