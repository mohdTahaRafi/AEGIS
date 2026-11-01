# AEGIS — Product Requirements

**SIH 2026 · Problem Statement 26171 · On-device Visual Perception for Light-weight Browser Agents**
**Organisation:** Indian Space Research Organisation (ISRO), Department of Space · **Category:** Software · **Theme:** Smart Automation

| | |
|---|---|
| Status | Draft v1.0 for team review · 17 September 2026 |
| Companion documents | `architecture.md`, `design.md` |
| Sources of truth | (1) SIH problem statement 26171 **[PS]**; (2) `sih26171-solution-strategy.md` **[SS]**; (3) `sih26171-architecture.md` **[AD]**, adopted only where stated |
| Other tags | **[TD]** technical necessity introduced by the specification (not a product wish); **[A]** assumption; **[OQ-n]** open decision (full list in `architecture.md` §17) |

This document deliberately contains no requirement that is not traceable to a source. Where the sources are silent on something a product would normally define, it is listed as an assumption or open question instead of being filled in.

---

## 1. Problem

AI agents that can see a user's screen can help with complex web workflows, but most agent pipelines run on servers, which limits what users can safely share with them [PS]. A local agent in the browser could avoid sending sensitive data, but local machines have fewer resources and cannot host a full pipeline, so only non-sensitive information such as screen structure and application fields should go to the server [PS]. Browser technologies (WebGPU, WebAssembly, ONNX Runtime Web, Transformers.js) now make lightweight on-device models practical [PS].

The PS asks for a bridge: server-side reasoning power with privacy enforced strictly on the client [PS].

The solution strategy sharpens this into a three-way trade-off between redaction completeness, preserved usefulness of the context, and client cost, and observes that "redact by painting black boxes" loses on most of the scoring rubric [SS].

## 2. Product statement

AEGIS lets a browser agent complete real tasks on screens that contain sensitive data such as Aadhaar numbers, passwords and faces, by replacing every sensitive region with a typed, sealed placeholder that the remote model can reason about but never resolve, and resolving it back to the true value only inside the browser at the moment of execution [SS].

The name is a placeholder; the final name is open [OQ-17] [SS].

---

## 3. Goals and non-goals

### 3.1 Goals

| ID | Goal | Source |
|---|---|---|
| G-1 | Deliver a working prototype: a client extension for Chrome and Firefox plus a server | [PS] |
| G-2 | Run a vision model locally in the browser that evaluates the current screen state | [PS] |
| G-3 | Detect and sanitize sensitive visual and textual data on the client before any network request, and demonstrate this clearly | [PS] |
| G-4 | Send only anonymized context to a server running an open-weights, offline-deployable model that understands the redaction scheme and returns actions or processed data | [PS] |
| G-5 | Demonstrate an end-to-end task that assists the user | [PS] |
| G-6 | Maximise the published rubric: context accuracy, PII precision/recall, redaction precision, client resource use, end-to-end latency | [PS] [SS] |
| G-7 | Complete tasks that require the sensitive value without ever transmitting it ("zero-egress task completion") | [SS] |
| G-8 | Report the system's own scores with stated conditions (sample size, data, hardware) | [SS] |

### 3.2 Non-goals

| ID | Non-goal | Source |
|---|---|---|
| NG-1 | Mobile version | [SS] |
| NG-2 | Multi-language user interface | [SS] |
| NG-3 | Payments functionality | [SS] |
| NG-4 | Role-based access control or authentication beyond a session | [SS] |
| NG-5 | Training models from scratch or fine-tuning models | [SS] |
| NG-6 | Blockchain, a second database, Kubernetes | [SS] |
| NG-7 | Anything not in the demo script | [SS] |
| NG-8 | Solving CAPTCHAs on the user's behalf | [AD] |

---

## 4. Users and stakeholders

The sources identify only the following. No personas, segments or organisations beyond these are assumed.

| Stakeholder | What the sources say | Source |
|---|---|---|
| **User** | A person using a browser who wants an agent to assist with or automate a web workflow without sharing sensitive data with a server | [PS] |
| **Evaluators (SIH judges)** | Score the five metrics on use cases supplied at the finale; may ask to run the agent on a page of their choice | [PS] [SS] |
| **ISRO (problem owner)** | Sponsor organisation; the strategy notes an interest in sovereign, offline deployment | [PS] [SS] |
| **Team** | Builds, operates the server during SIH, maintains the evaluation corpus | [SS] |

Assumptions [A]:
- A-U1: There is one user per browser profile; no shared or multi-user use is required.
- A-U2: The user is present during a task and can respond to confirmation prompts.
- A-U3: The user trusts the extension (it can see everything on granted pages); the user does not trust the server with sensitive values.

---

## 5. Scope

Scope tiers are taken from the strategy [SS].

| Tier | In scope |
|---|---|
| **Tier 1 — must work flawlessly, offline, every time** | One end-to-end task on one real page covering capture → dual detection → fusion → placeholders → egress guard → server → action → local resolution → execution; detection of faces, passwords and Aadhaar/card numbers; the local vault and reverse mapping; a visible view of the outbound payload; a scoreboard computing all five metrics from a local fixture |
| **Tier 2 — if time permits** | Second and third page categories (canvas-rendered apps, PDF.js viewers); ablation runner; Firefox build; settings UI and per-type redaction policy |
| **Tier 3 — simulated and labelled as such** | Cloud-hosted server model during SIH with the offline deployment path documented; any scale claim presented as a measured load test |
| **Tier 4 — do not build** | Items in §3.2 |

**Tension to note:** the PS requires the client to run in Chrome **and** Firefox [PS], while the strategy places the Firefox build in Tier 2 [SS]. The Firefox build is therefore a PS requirement that the team has chosen to schedule after Tier 1; it should not be dropped from the final submission → [OQ-12].

---

## 6. Functional requirements

Priority: **P1** = Tier 1 or a direct PS requirement; **P2** = Tier 2; **P3** = nice to have.

### 6.1 Client: agent operation

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-1 | The client shall run as a browser extension in Chrome. | P1 | [PS] |
| FR-2 | The client shall run as a browser extension in Firefox. | P1 (scheduled Tier 2) | [PS] [SS] |
| FR-3 | The user shall be able to give the agent a task in natural language and start, observe and stop it. | P1 | [PS] ("end-to-end task assisting the user") [TD] (UI form) |
| FR-4 | The client shall execute actions returned by the server on the current page, including at least click, type and scroll. | P1 | [PS] |
| FR-5 | The client shall accept processed data returned by the server and present it to the user. | P1 | [PS] |
| FR-6 | The client shall validate every server action against a constrained action format and against the live page before executing it; invalid or stale actions shall not run. | P1 | [SS] [AD] |
| FR-7 | Destructive or irreversible actions shall require explicit user confirmation before execution. The exact list is to be confirmed. | P1 | [SS] [AD] [OQ-10] |
| FR-8 | When a CAPTCHA is detected, the agent shall stop and hand control to the user. | P2 | [AD] |
| FR-9 | The agent shall stop with an explanation when it cannot proceed safely (budget exhausted, repeated validation failures, page too unstable). | P1 | [AD] |

### 6.2 Client: local visual perception

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-10 | The client shall run a vision model locally in the browser (a ViT or equivalent) that evaluates the current screen state. | P1 | [PS] |
| FR-11 | Local inference shall use WebGPU when available and fall back to WebAssembly when not; both paths shall work and be measured. | P1 | [PS] (WebGPU example) [SS] |
| FR-12 | The client shall combine page structure (DOM/accessibility information) with pixel-based perception, so that content not represented in the DOM (canvas, images, video, PDF viewers) is still analysed. | P1 | [SS] |
| FR-13 | No model shall be downloaded from the internet at runtime; models ship with the extension. | P1 | [AD] [TD] |
| FR-14 | Perception shall be demonstrably local: it shall keep working with the network disconnected (the task itself will not progress without the server). | P1 | [SS] ("airplane mode" demo) |

### 6.3 Client: privacy filter

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-20 | The client shall detect sensitive elements dynamically on the current screen. | P1 | [PS] |
| FR-21 | The client shall sanitize sensitive data before any network request is made. | P1 | [PS] |
| FR-22 | Faces shall be obscured in anything sent to the server. | P1 | [PS] [SS] |
| FR-23 | Password contents shall never be sent; the client shall not read password field values at all. | P1 | [PS] [AD] |
| FR-24 | PII shall be masked in anything sent to the server, including at least: Aadhaar, PAN, GSTIN, IFSC, UPI IDs, card numbers, phone numbers, email addresses, and names in free text. | P1 | [PS] [SS] |
| FR-25 | Structured Indian identifiers shall be validated with their check rules where they exist (Verhoeff for Aadhaar, Luhn for cards, GSTIN check character) to reduce false positives. | P1 | [SS] |
| FR-26 | Each redacted value shall be replaced by a typed placeholder that preserves its type (and structural hints such as length) but not its value. | P1 | [SS] |
| FR-27 | The same value appearing more than once in a session shall map to the same placeholder. | P1 | [AD] |
| FR-28 | Placeholders shall be resolvable to real values only on the client, from an in-memory store that is never transmitted or persisted. | P1 | [SS] [AD] |
| FR-29 | When the server asks the client to type a placeholder, the client shall insert the real value only into a field of matching type, on the page where the value was seen, and under the confirmation policy for its sensitivity class. | P1 | [SS] [AD] [OQ-1] [OQ-8] |
| FR-30 | A single egress control shall re-check the final outgoing payload independently of the detectors and block the request if any sensitive value survives (fail-closed). | P1 | [SS] |
| FR-31 | Any image sent to the server shall contain only regions positively cleared by analysis; regions not analysed in time shall be withheld. | P1 | [AD] |
| FR-32 | Identifying information outside visible values (URLs, paths, CSS selectors) shall not be sent. | P1 | [AD] |
| FR-33 | The user's task text shall itself be sanitized before sending. | P1 | [TD] (consequence of FR-21) |
| FR-34 | The sanitization shall be clearly demonstrable: the user (and judges) shall be able to see exactly what was sent for each step, next to the real page. | P1 | [PS] [SS] |
| FR-35 | The user shall be able to change redaction policy per entity type. | P2 | [SS] |
| FR-36 | The user shall be able to un-redact a specific region for the session (the only way to lower a redaction decision besides versioned policy rules). | P3 | [AD] |

### 6.4 Server

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-40 | The server shall receive only anonymized context. | P1 | [PS] |
| FR-41 | The server shall be aware of the redaction scheme and interpret placeholders and redacted regions correctly. | P1 | [PS] |
| FR-42 | The server shall use an open-source/open-weights model that can be deployed offline; a cloud-hosted instance may be used during SIH. | P1 | [PS] |
| FR-43 | The server shall return either UI actions for the client to execute or processed data for the client to ingest. | P1 | [PS] |
| FR-44 | Server output shall be constrained to a machine-checkable action format so that malformed or invented actions are rejected rather than executed. | P1 | [SS] |
| FR-45 | The server shall offer a recorded-response mode for reliable demonstrations. | P1 | [SS] |
| FR-46 | The offline, single-machine deployment path shall be documented. | P1 | [SS] |

### 6.5 Measurement and evidence

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-50 | An evaluation harness shall compute all five official metrics on a labelled corpus. | P1 | [SS] |
| FR-51 | The corpus shall target 200–300 labelled screens across the strategy's categories, including hard negatives and canvas/PDF/video/Indic pages, with 20% held out and used only once before submission. | P1 (size P2) | [SS] |
| FR-52 | The harness shall report a leak count from an independent audit of outbound payloads. | P1 | [SS] |
| FR-53 | The harness shall run ablations: DOM-only, pixel-only, fused; and black-box versus typed-placeholder redaction. | P2 | [SS] |
| FR-54 | Every reported number shall state sample size, data source and hardware; failure cases shall be reported alongside success rates. | P1 | [SS] |
| FR-55 | The client shall display live latency and resource information during a task. | P1 | [SS] |

---

## 7. Non-functional requirements

### 7.1 Official evaluation metrics [PS]

| ID | Metric (weight) | Team target | Target source |
|---|---|---|---|
| NFR-1 | Accuracy of visual context from screen (25%) | ≥ 90% of the raw-context task-success ceiling | [SS] |
| NFR-2 | Recall and precision for detection of sensitive/PII data (20%) | Recall ≥ 0.99 on structured identifiers, ≥ 0.95 on free text; precision reported per entity type | [SS] |
| NFR-3 | Precision of redaction (20%) | False-redaction rate on hard negatives < 2%; IoU reported | [SS] |
| NFR-4 | Client-side resource utilization (20%) | Model footprint, peak memory, CPU and GPU reported on a mid-range integrated-GPU laptop; idle cost ≈ 0 | [SS] [AD] |
| NFR-5 | Overall end-to-end latency of the task (15%) | p50/p95 per stage and per round trip; p95 added client latency under a named interaction budget | [SS] |
| NFR-6 | Leak count | 0, with n stated | [SS] |

All targets are targets, not measurements. None may be presented as achieved until the harness produces them [SS]. The PS does not define exactly how metric 1 is measured → [OQ-4].

### 7.2 Other qualities

| ID | Requirement | Source |
|---|---|---|
| NFR-10 | **Privacy by construction:** failures (crash, timeout, missing model, denied permission) must never result in unsanitized data being sent. | [SS] [AD] |
| NFR-11 | **Portability:** client works on machines without WebGPU (for example Firefox on Linux, where WebGPU is still behind a preference as of Firefox 152–155). | [SS] [V in architecture §5.1] |
| NFR-12 | **Security:** server output is data only (never executed as code); the client treats page content and server output as untrusted. | [AD] [TD] |
| NFR-13 | **Offline deployability** of the server stack on a single machine. | [PS] |
| NFR-14 | **Demo reliability:** primary path fully local; server on localhost or a pinned VM with recorded responses; a second configured laptop; a pre-recorded, team-narrated video. | [SS] |
| NFR-15 | **Honesty of claims:** own baselines only; no projected ROI; no rounding up. | [SS] |
| NFR-16 | **Generalisation:** behaviour must hold on unseen pages, since finale use cases are supplied at the finale. | [SS] |

---

## 8. Demonstration requirements [SS]

| ID | Requirement |
|---|---|
| DR-1 | **30-second demo:** live page and the actual outbound payload side by side; a page with a visible Aadhaar number, a filled password field and a profile photo; a task that requires the sensitive value ("log in and submit the form"); the payload shows placeholders and an obscured face while the page structure stays readable; the task completes with the real value. |
| DR-2 | **Network pulled:** local detection and redaction keep running with the network disconnected. |
| DR-3 | **Judge's own page:** the agent can be run on a page the judge chooses. |
| DR-4 | **Live scoreboard:** the harness runs on the held-out split and shows the five metrics. |
| DR-5 | **Ablation chart** available on request. |
| DR-6 | Narration by the team (AI narration reportedly disallowed this year). |

---

## 9. Constraints

| ID | Constraint | Source |
|---|---|---|
| C-1 | Client must run in popular browsers, named as Chrome and Firefox. | [PS] |
| C-2 | Server model must be open-source/open-weights and offline-deployable. | [PS] |
| C-3 | Sanitization must happen before any network request. | [PS] |
| C-4 | Submission: six mandated slides as PDF, with links tested inside the exported PDF; portal deadline 20 September 2026. | [SS] |
| C-5 | Evaluation use cases are provided at the finale. | [SS] |
| C-6 | No model training from scratch or fine-tuning (team decision). | [SS] |

---

## 10. Assumptions

| ID | Assumption | Impact if wrong |
|---|---|---|
| A-1 | The browsers used for evaluation are desktop Chrome and desktop Firefox in current versions. | Platform-specific behaviour may differ |
| A-2 | Judges can install an unpacked (Chrome) or temporary (Firefox) extension. | Packaging and signing work needed |
| A-3 | The server can be reached from the evaluation machines over HTTPS, or runs on the demo laptop. | Deployment plan changes |
| A-4 | English is the task language; page content may include Indic scripts. | OCR and NER coverage |
| A-5 | One task runs at a time per browser window. | Controller design |
| A-6 | Values the agent types come from what is visible on the current page (see OQ-2). | Would need a separate value store with consent design |
| A-7 | Server-side concurrency needs are small (demo and evaluation only); no throughput target exists. | Scaling work |
| A-8 | The team has access to at least one GPU suitable for an 8–9 B multimodal model during SIH. | Model choice [OQ-13] |

---

## 11. Open questions

The complete list with proposed defaults is in `architecture.md` §17. The ones that change product behaviour are:

| ID | Question |
|---|---|
| OQ-1 | May the agent automatically type CRITICAL values such as Aadhaar (the strategy's killer feature) or only after user confirmation (the draft's rule)? |
| OQ-2 | Is there any source of values for form filling other than the current screen? |
| OQ-3 | Final mapping of entity types to sensitivity classes and thresholds. |
| OQ-4 | How exactly is "accuracy of visual context" measured by the evaluators? |
| OQ-6 | May placeholders reveal partial values such as the last four card digits? |
| OQ-8 | May a value seen on one website be typed on another? |
| OQ-9 | Should the record of what was sent persist beyond the session? |
| OQ-10 | Which actions require confirmation? |
| OQ-11 | May the server learn which website is open, or only its category? |
| OQ-12 | Re-baselined plan given that this document is dated three days before the portal deadline. |
| OQ-14 | May the agent type literal text taken from the task (for example a search query)? |
| OQ-15 | How do judges' devices authenticate to the server? |
| OQ-16 | Which laptop is the reference for resource numbers? |
| OQ-17 | Final product name. |

---

## 12. Acceptance criteria

A build is accepted for submission when all P1 criteria below pass on the reference machine.

| ID | Criterion | Verifies |
|---|---|---|
| AC-1 | The Tier 1 demo task (DR-1) completes end to end on Chrome, three consecutive times, with the live model and with recorded responses. | FR-3, FR-4, FR-26–FR-29, FR-45 |
| AC-2 | For that task, the captured outbound payloads contain no Aadhaar number, no password characters and no unobscured face; the auditor reports 0 leaks. | FR-21–FR-24, FR-30, NFR-6 |
| AC-3 | With WebGPU disabled, the same task completes on the WASM path; latency is reported for both paths. | FR-11, NFR-11 |
| AC-4 | With the network disconnected, the panel still shows detections and the sanitized preview for the current page. | FR-14, DR-2 |
| AC-5 | A server response containing an unknown element id, a malformed action, or a placeholder typed into a mismatched field is rejected and not executed. | FR-6, FR-29, FR-44 |
| AC-6 | Forcing a detector miss on a fixture page causes the egress control to block the request; nothing is sent. | FR-30, NFR-10 |
| AC-7 | Killing the perception worker mid-step results in either no image being sent or only positively cleared regions being sent. | FR-31, NFR-10 |
| AC-8 | The harness produces all five metrics plus leak count for the fixture corpus, each with n, data source and hardware. | FR-50, FR-52, FR-54 |
| AC-9 | The payload view shows, for every step, the exact bytes sent and the redaction counts. | FR-34 |
| AC-10 | The server stack starts from saved images and pre-downloaded weights with no internet access. | FR-42, FR-46, NFR-13 |
| AC-11 | Checksum-invalid look-alikes in the hard-negative fixtures (order numbers, tracking ids) are not redacted as Aadhaar or card numbers. | FR-25, NFR-3 |
| AC-12 (P1, Tier 2 schedule) | The demo task completes on Firefox (Windows or macOS), and the WASM path works on Firefox on Linux. | FR-2, NFR-11 |

---

## 13. Risks

| Risk | Effect | Mitigation | Source |
|---|---|---|---|
| In-browser inference too slow on the reference laptop | Metric 4 and 5 collapse | Day-1 go/no-go spike; small models; WASM path designed as first-class | [SS] |
| Unseen page types at the finale | Metric 1–3 drop | Broad corpus categories; held-out split; fail-closed defaults | [SS] |
| Free-text name recall or Indic OCR recall is weak | Metric 2 drop | Measure honestly; volunteer the weakest area first; optional larger NER profile | [SS] |
| Over-redaction destroys usefulness | Metric 1 and 3 drop | Typed placeholders; labels kept; hard-negative tests | [SS] |
| Firefox platform gaps (WebGPU on Linux, no threads for WASM) | Slower or broken Firefox build | WASM single-thread path; state tested support honestly | [SS] [V] |
| Prompt injection via page text | Agent misbehaves | Untrusted-data prompt rules; type- and origin-bound rehydration; confirmations | [TD] |
| Guard misses an entity no recognizer knows | Leak | Additive image composition; independent auditor; report residual risk | [SS] [AD] |
| Time: three days to the portal deadline at the date of this document | Incomplete Tier 1 | Re-baseline (OQ-12); cut order in `architecture.md` §16 | [SS] |

---

## 14. Milestones

The strategy's roadmap [SS], dated 3 September 2026, is reproduced for reference. It must be re-baselined because this document is dated 17 September 2026 → [OQ-12].

| Window (strategy) | Milestone |
|---|---|
| Days 1–3 | De-risking spike (in-browser inference go/no-go); corpus started; scoreboard skeleton; name locked |
| Days 4–9 | Tier 1 built: dual detection, fusion, placeholders, vault, egress guard, constrained server output, one end-to-end task; harness running continuously from Day 5 |
| Days 10–13 | Full measurement, ablations, held-out split touched once; demo video recorded; repository published with an honest README; prototype deployed and tested from another network |
| Days 14–17 | Six slides exported to PDF with links tested; submit by Day 16 |
| After submission | Broaden page categories; harden the WASM path; rehearse judge questions; prepare the second demo laptop |

Team roles from the strategy [SS]: on-device ML/inference; extension and fusion layer; server/VLM and action format; evaluation harness and labelling (staffed with a strong person); demo, deck and narration; QA and reliability.

---

## 15. Traceability: problem statement → requirements

| PS statement | Requirements |
|---|---|
| "privacy-preserving vision agent which runs on browser" | FR-1, FR-2, FR-10 |
| "local Vision Transformer (ViT) or equivalent … 'reads' the user's screen and takes decision" | FR-10, FR-12 |
| "sanitize the sensitive/PII data using DOM tags or any other method, before any network request" | FR-21, FR-12, FR-30 |
| "dynamically detect and redact sensitive elements … blurring faces, blacking out passwords, masking PII" | FR-20, FR-22, FR-23, FR-24 |
| "Only this anonymized, unidentifiable data should be transmitted" | FR-40, FR-30–FR-33 |
| "central server … aware of this redaction scheme" | FR-41, FR-26 |
| "return actionable commands for the browser agent to execute" / "processed data … or an UI action" | FR-4, FR-5, FR-43 |
| "balance the trade-offs between inference latency and the accuracy" | FR-11, NFR-1, NFR-5 |
| "Client-side … running in popular browsers (chrome, Firefox)" | FR-1, FR-2, C-1 |
| "Local Vision Processing … (e.g., via WebGPU)" | FR-10, FR-11 |
| "Privacy Preserving Filter … clearly demonstrated" | FR-20–FR-34, DR-1 |
| "Server Side Integration … centralized LLM/VLM" | FR-40–FR-44 |
| "offline deployable (open-source/open-weights) model … cloud hosted version during SIH" | FR-42, FR-46, NFR-13 |
| "An end-to-end task assisting the user should be demonstrated" | FR-3, DR-1, AC-1 |
| Five evaluation metrics | NFR-1 – NFR-5, FR-50 |
