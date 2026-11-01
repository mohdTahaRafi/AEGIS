# AEGIS — System Architecture

**SIH 2026 · Problem Statement 26171 · On-device Visual Perception for Light-weight Browser Agents (ISRO)**

| | |
|---|---|
| Document | `architecture.md` (one of three: `architecture.md`, `design.md`, `product-requirements.md`) |
| Status | Draft v1.0 for team review |
| Date | 17 September 2026 |
| Working name | AEGIS (placeholder from the solution strategy; the name is an open decision) |
| Inputs (sources of truth) | (1) SIH problem statement 26171; (2) `sih26171-solution-strategy.md`; (3) `sih26171-architecture.md` (earlier architecture draft) |

---

## 0. How to read this document

This document describes the whole system from the top down: context, components, flows, runtime placement, data movement, security, reliability, performance, observability, deployment, and the repository layout. Detailed data schemas, algorithms, API contracts and UI behaviour live in `design.md`. Product scope, requirements and acceptance criteria live in `product-requirements.md`.

Every significant statement is tagged with where it comes from, so that product facts and engineering choices are never confused.

| Tag | Meaning |
|---|---|
| **[PS]** | Stated in the SIH problem statement. Binding. |
| **[SS]** | Stated in the team's solution strategy. Binding unless flagged as a conflict. |
| **[AD]** | Stated in the earlier architecture draft. Adopted only where this document says so. |
| **[TD]** | A technical decision made in this document to make the idea implementable. Reasoning is given. |
| **[A]** | An assumption. Needs confirmation. |
| **[OQ]** | An open question or decision that the team must make. Listed in §17. |
| **[V]** | A fact that was checked against current (September 2026) documentation or releases while writing this. |

Two rules applied throughout:

1. No product behaviour is invented. Where the sources are silent, the gap is marked [A] or [OQ].
2. Where the two input documents disagree with each other, or with verified platform facts, the conflict is surfaced in §1.3 rather than silently resolved.

---

## 1. Problem framing

### 1.1 What must be built [PS]

A privacy-preserving browser agent made of two parts.

**Client** — a browser extension (or JS) that runs in Chrome and Firefox and:

- runs a local vision model (a ViT "or equivalent") in the browser (for example on WebGPU) that evaluates the current screen state;
- detects sensitive elements dynamically and sanitizes them before any network request, using DOM tags "or any other method" (examples given: blur faces, black out passwords, mask PII);
- makes the sanitization "clearly demonstrated";
- executes actions returned by the server.

**Server** — receives only anonymized context, is "aware of the redaction scheme", runs an open-weights, offline-deployable LLM/VLM (cloud-hosted versions are allowed during SIH), and returns either processed data for the client to ingest or UI actions such as "click the submit button" or "scroll down".

An end-to-end task that assists the user must be demonstrated.

### 1.2 How it is scored [PS]

| # | Metric | Weight |
|---|---|---|
| 1 | Accuracy of visual context from screen | 25% |
| 2 | Recall and precision for detection of sensitive/PII data | 20% |
| 3 | Precision of redaction | 20% |
| 4 | Client-side resource utilization | 20% |
| 5 | Overall end-to-end latency of the provided task | 15% |

The strategy notes that evaluation use cases are supplied at the finale [SS], so the system must generalise to pages the team has not seen.

The strategy's central observation [SS] shapes the whole architecture. Metrics 1, 2 and 3 pull against each other: aggressive redaction helps recall but hurts redaction precision and destroys the context the server needs. Metrics 4 and 5 punish solving that with bigger models. The architecture is therefore built around one idea from the strategy: **replace sensitive values with typed placeholders that the server can reason about but cannot resolve, and resolve them back only inside the browser** ("zero-egress task completion") [SS].

### 1.3 Conflicts found in the inputs, and how this document handles them

| # | Conflict | Handling |
|---|---|---|
| C-1 | **Can the agent type a CRITICAL value (for example an Aadhaar number) automatically?** The strategy's killer feature says yes ("the agent fills in your Aadhaar number without ever having transmitted it") [SS]. The draft says CRITICAL tokens, Aadhaar included, are "never automatic — user action only" [AD]. | Architecture supports both through a policy switch. Default proposed here: allowed only after an explicit per-action user confirmation, same origin, type-matched field. **Needs team decision → OQ-1.** |
| C-2 | **Where do passwords come from if the agent must "log in"?** The strategy demo uses "a password field with content" [SS]; the draft forbids ever reading password values [AD]. | These are compatible if the password is already in the field (typed by the user or the browser's password manager): the agent only clicks "submit". The vault never holds passwords, so `type(field, ⟪PASSWORD⟫)` has nothing to resolve and is rejected. Any other source of values (a stored user profile, for example) is **not specified anywhere → OQ-2.** |
| C-3 | **Server model topology.** Strategy: one VLM (Qwen2.5-VL-7B suggested) [SS]. Draft: a text planner LLM plus a separate VLM grounder [AD]. | [TD] One natively multimodal open-weights model, called with or without an image. This keeps the draft's latency benefit (no image tokens on most steps) without running two models on one GPU. See §8.3. |
| C-4 | **Redaction mechanism.** Strategy: detect, substitute placeholders, re-scan final bytes with an egress guard [SS]. Draft: build the outgoing image additively from positively cleared regions [AD]. | Not a real conflict. Both are adopted: additive composition makes the image fail closed; the egress guard independently re-checks the final payload. |
| C-5 | **Model training.** The strategy lists "model training from scratch" and "model fine-tuning" under *do not build* [SS]. The draft's region classifier, UI detector and distilled NER all require training or fine-tuning [AD]. | [TD] The client stack is rebuilt from pretrained, off-the-shelf models (§6.3). A zero-shot ViT image encoder replaces the fine-tuned classifier; the client-side UI detector is dropped. A lightweight linear probe on frozen embeddings is offered as an option only → **OQ-5.** |
| C-6 | **Inference host.** Strategy: Chrome offscreen document [SS]. Draft: offscreen document on Chrome, hidden background page on Firefox [AD]. | [TD] Changed: the agent runtime and inference worker live in the extension's side panel (Chrome) / sidebar (Firefox). Reasons in §5.2. The offscreen document is kept as a documented fallback for Chrome. |
| C-7 | **Placeholder format.** Strategy: `⟨AADHAAR:12⟩`, `⟨CARD:16:last4=4417⟩` [SS]. Draft: `⟪EMAIL#a7⟫` with an HMAC-derived 2-byte id [AD]. | [TD] Unified form `⟪ENTITY#n⟫` with a per-session counter id; length and other metadata travel in a structured field. Revealing the last four card digits is a partial disclosure and is **off by default → OQ-6.** HMAC ids are dropped (reasons in §7.5). |
| C-8 | **Draft claims that are no longer accurate** [V] | Corrected in place: (a) Firefox *does* expose closed shadow roots to content scripts through `Element.openOrClosedShadowRoot`; (b) extension messaging cannot transfer an `ImageBitmap` from the service worker, so the draft's "transfer neuters the source" guarantee did not hold as described; (c) browser extensions cannot pin TLS certificates; (d) extension pages on Firefox do not get `SharedArrayBuffer` (only privileged extensions do), so multi-threaded WASM cannot be assumed there; (e) an HMAC "attestation" between two modules in the same JavaScript heap does not add a security boundary. |
| C-9 | **Timeline.** The strategy was written on 3 September with 17 days to the 20 September portal deadline [SS]. This document is dated 17 September. | The roadmap in the strategy must be re-baselined → **OQ-12.** This architecture marks which parts are Tier 1 (§16) so the team can cut scope safely. |

---

## 2. Architectural principles

Each principle comes from the sources; the column on the right shows the design consequence.

| # | Principle | Source | Consequence |
|---|---|---|---|
| P1 | The rubric is the specification. | [SS] | The evaluation harness is a first-class component (§12), built before the product. |
| P2 | Structure first, pixels where structure runs out. | [AD] | The DOM/accessibility channel provides roles, names and exact geometry; the vision channel covers canvas, images, video, PDFs and frames the extension cannot read. |
| P3 | Two detection channels, fused. | [SS] [AD] | DOM detection and pixel detection run together and are merged into one redaction plan. |
| P4 | Deterministic before probabilistic. | [SS] [AD] | Input types, autocomplete tokens and checksum-validated identifiers (Verhoeff for Aadhaar, Luhn for cards) run before any model. |
| P5 | Redaction preserves meaning. | [SS] | Values become typed placeholders; labels, layout and element roles stay intact. |
| P6 | Fail closed. | [SS] [AD] | Anything not positively cleared is withheld. A crash, timeout or miss produces grey, never content. |
| P7 | One egress choke point. | [SS] | Exactly one module can reach the server, and it only accepts payloads that passed the guard. |
| P8 | The server proposes; the client decides. | [SS] [AD] | Output is a constrained action language; every action is re-validated against the live page before it runs. |
| P9 | Simplest architecture that survives questioning. | [SS] | No microservices, brokers, databases, caches or orchestration. One extension, one gateway, one model server. |
| P10 | Measure, don't assert. | [SS] | Every performance number in this document is a target until the harness produces it. |

---

## 3. System context

```
                ┌───────────────────────────────────────────────────────┐
                │                 USER'S MACHINE                         │
                │                                                        │
   User ───────►│  Browser (Chrome / Firefox)                            │
  (gives task,  │   ├─ Web page(s)  ← untrusted, may be hostile          │
   confirms     │   └─ AEGIS extension                                  │
   risky        │        • sees the real screen                          │
   actions)     │        • detects + substitutes sensitive data          │
                │        • holds the only copy of real values (vault)    │
                │        • executes actions on the real page             │
                └───────────────────────────┬────────────────────────────┘
                                            │ HTTPS: sanitized context only
                                            │ (placeholders, geometry, roles,
                                            │  optional sanitized image)
                                            ▼
                ┌───────────────────────────────────────────────────────┐
                │           AEGIS SERVER (open-weights, offline-capable)│
                │   Agent Gateway  ──►  Model server (VLM)               │
                │   returns: actions in a constrained DSL, or data       │
                └───────────────────────────────────────────────────────┘

   Evaluation harness (development/finale only): drives the browser with the
   extension loaded, records payloads and timings, scores the five metrics.
```

**Actors**

- *User* — the person using the browser who gives the agent a task [PS]. No other user types, roles or tenants are specified [A]; see `product-requirements.md`.
- *Web page* — treated as untrusted input, including its text (which reaches the model and may contain injected instructions) [TD].
- *Server operator* — runs the gateway and model. Assumed to be the team during SIH [A].
- *Evaluator* — SIH judges running the finale use cases [PS].

**Trust boundary.** Raw screen content, DOM values and the vault never cross the line between the user's machine and the server. This is the property the whole design protects [PS].

---

## 4. High-level architecture

### 4.1 Component map

```
┌──────────────────────────── BROWSER EXTENSION (MV3, Chrome + Firefox) ─────────────────────────────┐
│                                                                                                    │
│  WEB PAGE TAB (untrusted)                                                                          │
│  ┌──────────────────────────────────────────────┐                                                  │
│  │ CONTENT SCRIPT  (isolated world, every frame) │                                                 │
│  │  • Screen Graph extractor (DOM + a11y + geom) │                                                 │
│  │  • DOM-channel sensitive-data signals         │                                                 │
│  │  • Text recognizers (patterns + checksums)    │                                                 │
│  │  • Mutation / scroll / focus observers        │                                                 │
│  │  • Action executor + pre-flight checks        │                                                 │
│  │  • NO network code                            │                                                 │
│  └───────────────────────┬──────────────────────┘                                                  │
│                          │ runtime.Port (structured messages, per frame)                           │
│                          ▼                                                                         │
│  AGENT HOST = side panel page (Chrome) / sidebar page (Firefox) — lives while a task runs          │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  Agent Controller (step loop, state machine, budgets)                                       │   │
│  │  Capture Service  (tabs.captureVisibleTab, rate-limited)                                    │   │
│  │  ┌───────────────────────────────┐   ┌────────────────────────────────────────────────┐     │   │
│  │  │ PERCEPTION WORKER (dedicated  │   │ PRIVACY CORE                                     │   │   │
│  │  │ Web Worker; only place raw    │◄─►│  • Fusion + arbitration + policy engine          │   │   │
│  │  │ pixels live)                  │   │  • Placeholder minting                           │   │   │
│  │  │  • ONNX Runtime Web           │   │  • VAULT (placeholder → real value), in memory   │   │   │
│  │  │    (WebGPU → WASM fallback)   │   │  • Sanitized Context builder                     │   │   │
│  │  │  • face detector              │   └───────────────────────┬────────────────────────┘     │   │
│  │  │  • ViT region encoder         │                           ▼                              │   │
│  │  │  • OCR det + rec              │   ┌════════════════════════════════════════════════┐     │   │
│  │  │  • PII token classifier (NER) │   ║ EGRESS GUARD (independent re-scan, fail-closed)║     │   │
│  │  │  • additive compositor        │   ╚═══════════════════════╤════════════════════════╝     │   │
│  │  │  • image re-scan for guard    │                           ▼                              │   │
│  │  └───────────────────────────────┘   ┌────────────────────────────────────────────────┐     │   │
│  │                                      │ EGRESS CLIENT — the only code that calls fetch │     │   │
│  │  Action Validator + Rehydrator ◄──── │ to the server                                   │     │   │
│  │  Privacy Ledger (what left, when)    └────────────────────────────────────────────────┘     │   │
│  │  Panel UI (task input, timeline, "what the server saw", confirmations, metrics)             │   │
│  └─────────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                                    │
│  BACKGROUND (service worker on Chrome / event page on Firefox): tiny — opens the panel,            │
│  handles install/permission events. No inference, no pixels, no vault.                             │
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                   │ HTTPS POST (JSON), one request per agent step
                                                   ▼
┌──────────────────────────────────────── SERVER HOST (single GPU) ──────────────────────────────────┐
│  Reverse proxy (TLS)  ──►  AGENT GATEWAY (Python, FastAPI)                                         │
│                              • schema validation of sanitized context                               │
│                              • placeholder-aware prompt builder                                     │
│                              • session history (in memory, TTL)                                     │
│                              • action/output schema + post-validation                               │
│                              • record/replay mode for demo reliability                              │
│                            ──►  MODEL SERVER (vLLM, OpenAI-compatible, structured outputs)         │
│                                   • one open-weights multimodal model                               │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Responsibilities

| Component | Owns | Must never |
|---|---|---|
| Content script | Reading the page's structure and geometry; DOM-channel detection; cheap text recognizers; executing actions with pre-flight checks | Hold network code; read `.value` of password/OTP/CVV-class fields; accept instructions from the page |
| Background | Opening the panel; permission and install events | Run models, hold pixels, hold vault values |
| Agent Controller | Step loop, budgets, retries, cadence, cancellation | Send anything except through the guard and egress client |
| Capture Service | Screenshots of the visible tab, respecting the browser rate limit | Store captures; send them anywhere but the perception worker |
| Perception Worker | All model inference; composing the sanitized image; image re-scan | Talk to the network (worker CSP and code review) |
| Privacy Core | Merging detections, applying policy, minting placeholders, the vault, building the sanitized context | Serialize vault contents |
| Egress Guard | Independent re-check of the final payload bytes; blocking | Be bypassed (the egress client only accepts guard output) |
| Egress Client | The one HTTPS call per step; retries; timing capture | Accept anything that is not a guard-approved payload |
| Action Validator / Rehydrator | Checking server actions against schema, policy and the live page; resolving placeholders from the vault locally | Resolve a placeholder into a field of a different type, a different origin, or without a required confirmation |
| Privacy Ledger | Recording exactly what was sent, for the user and for evaluation | Upload itself anywhere |
| Agent Gateway | Validating input, building prompts, calling the model, validating output, short-lived session history | Receive or store raw user data (by construction it never gets any) |
| Model server | Inference with grammar-constrained output | Be exposed directly to the internet |
| Evaluation harness | Corpus, scoring of the five metrics, ablations, leak audit | Ship in the extension |

---

## 5. Client architecture

### 5.1 Browser platform facts that constrain the design [V]

| Fact | Consequence |
|---|---|
| Chrome MV3 background is a service worker; it is terminated after roughly 30 s idle and dynamic `import()` is disallowed there. | Heavy libraries and long-lived model sessions cannot live in the service worker. |
| Chrome offscreen documents expose only `chrome.runtime` messaging among extension APIs. | An offscreen document cannot call `tabs.captureVisibleTab` itself; screenshots would have to be taken elsewhere and moved into it. |
| Firefox MV3 background is an event page with an idle timer (default ~30 s, reset by extension events). | Keeping multi-megabyte model sessions loaded there needs keep-alive tricks. |
| Chrome side panel (Chrome 114+) and Firefox sidebar are extension pages with full extension API access; both are opened by a user gesture. WXT maps one `sidepanel` entrypoint to Chrome `side_panel` and Firefox `sidebar_action`. | One page type exists on both browsers, stays alive while open, and can capture, run workers, and call the server. |
| A click inside the side panel does not grant `activeTab`. | Capturing and scripting the page needs host permissions; they are requested as optional permissions at task start (§10.4). |
| `captureVisibleTab` is limited to 2 calls per second in Chrome (since Chrome 92) and returns a data URL. | Capture is event-driven and rate-limited by design; the image is decoded inside the agent host. |
| WebGPU: default on in Chrome/Edge on Windows, macOS, ChromeOS, Android; in Firefox on Windows and macOS; **Firefox on Linux still needs a preference as of Firefox 152–155** (Mozilla expects to ship Linux in 2026). | WebGPU is an accelerator, never a requirement. The WASM path must be fully usable. |
| Chrome lets extensions opt into cross-origin isolation (COEP/COOP manifest keys) → `SharedArrayBuffer` → multi-threaded WASM. Firefox enables this only for privileged extensions. | Chrome WASM path: multi-threaded. Firefox WASM path: plan for single-threaded SIMD. |
| Closed shadow roots: Chrome `chrome.dom.openOrClosedShadowRoot()`, Firefox `Element.openOrClosedShadowRoot` in content scripts. | Closed shadow DOM is readable on both browsers; the draft's Firefox limitation does not apply. |

### 5.2 Decision: where the agent runtime and models run [TD]

| Option | For | Against | Verdict |
|---|---|---|---|
| A. Background service worker (Chrome) / event page (Firefox) | Always available | Chrome: 30 s idle kills, no dynamic import, awkward for multi-MB WASM. Firefox: idle termination. Would reload models repeatedly (hurts metric 4 and 5). | Rejected |
| B. Chrome offscreen document + Firefox background page (strategy / draft) | Survives panel close; established Chrome pattern | Two different hosts to build and debug. Offscreen cannot capture, so pixels must pass through the service worker as a JSON-serialized data URL, which breaks the draft's "pixels only exist in one place" claim. Firefox host still suffers idle termination. | Kept as a Chrome fallback only |
| C. Content script | Closest to the page | Runs inside a hostile page's process and is subject to page CSP for some resources; loading WASM/WebGPU per tab and per frame multiplies memory | Rejected |
| **D. Side panel (Chrome) / sidebar (Firefox) page, with a dedicated inference Web Worker** | One host on both browsers; full extension API access, so capture, inference, vault and egress sit in one context and pixels never cross extension messaging; lifetime equals "the user has the agent open", which is exactly when work is needed; the same page is the UI the strategy's demo needs ("the panel shows the outbound payload live") | Closing the panel stops the task (acceptable and arguably correct: the user can always stop the agent); side panel narrows the page viewport slightly | **Selected** |

**Verification item (Day-1 spike):** confirm WebGPU and ONNX Runtime Web run inside a dedicated worker spawned from the side panel on Chrome and from the sidebar on Firefox. If WebGPU is unavailable in the worker on either browser, run ORT on the panel's main thread for that browser (the panel UI is light) and keep the worker for pre/post-processing.

### 5.3 Execution contexts and what each may touch

| Context | Raw pixels | DOM text | Vault values | Network to server |
|---|---|---|---|---|
| Content script | No | Yes (its own frame) | Receives one value at the moment of a confirmed `type` action only | No |
| Background | No | No | No | No |
| Agent host main thread | Only as an undecoded data URL for milliseconds, handed straight to the worker | Receives candidate spans for analysis | Yes (vault lives here) | Only via Egress Client |
| Perception worker | Yes | Receives text spans for NER | No | No |

The data URL from `captureVisibleTab` is decoded with `createImageBitmap` in the host and the resulting `ImageBitmap` is **transferred** (a real transfer, same agent cluster) into the worker, which closes it after use [TD]. This is the corrected version of the draft's single-owner pixel rule (C-8b).

### 5.4 Content script subsystem

Injected into all frames (`all_frames: true`) of pages the user has granted [TD]. Responsibilities:

1. **Screen Graph extraction** [AD] — interactive and text-bearing nodes with role, accessible name (AccName order), visible box in top-level viewport coordinates, state (focused, disabled, required, has-value, value length), affordances and frame id. Node ids are random per session, never selectors or URLs, because selectors and paths can themselves contain PII [AD].
2. **Visibility** — computed style, `inert`, `aria-hidden`, viewport intersection and an occlusion probe with `elementsFromPoint`. Hidden DOM is excluded entirely because it is not visual context and dumping hidden values is a known exfiltration path [AD].
3. **Exact text geometry** — `Range.getClientRects()` for arbitrary character spans, so a detected phone number inside a paragraph gets its exact pixel rectangle [AD]. This is the main lever on metric 3.
4. **DOM-channel detection (Channel D)** — `input[type=password]`, `-webkit-text-security`, `autocomplete` tokens (`one-time-code`, `cc-*`, `email`, `tel`, `bday`, …), `inputmode`, and name/id heuristics [AD]. For password, OTP, CVV and card-number fields, **the value is never read**; only presence and length [AD].
5. **Text recognizers (Channel T, deterministic part)** — Indian and generic identifiers with validators: Aadhaar (Verhoeff), PAN, GSTIN, IFSC, UPI VPA, cards (Luhn), phone, email [SS] [AD]. These are pure functions in `packages/recognizers`, also usable by the harness (§15.2).
6. **Change detection** — `MutationObserver`, `ResizeObserver`, `scrollend`, focus changes; classified into cosmetic / semantic / privacy-relevant changes with container-scoped counters [AD] (details in `design.md`).
7. **Action execution** — synthetic events with correct focus and input-event sequencing; an atomic pre-flight check (resolve node → check facets → hit-test → dispatch) in one synchronous task [AD]. `chrome.debugger`/CDP is not used, to avoid its permission and trust surface [AD].
8. **Frames and shadow DOM** — child frames report their own sub-graphs; offsets are established by a nonce handshake [AD]. Closed shadow roots are read with the browser-specific API (§5.1). Frames that cannot be injected become *unexplained regions* for the vision channel [AD].

The content script never contains the server URL or any `fetch`/`XMLHttpRequest`/`WebSocket` call [SS] [AD]. This is enforced by a lint rule and a build-time check (§13.4, §15.3).

### 5.5 Agent host subsystem

- **Agent Controller** — runs the observe → sanitize → send → validate → act → settle loop (§7.1) as an explicit state machine, with per-step and per-task budgets, cancellation from the UI, and bounded reconciliation [AD].
- **Capture Service** — requests a capture only when the controller needs pixels (§6.5); enforces ≤ 2 captures/s; asks the content script for a *redaction-geometry digest* in the same animation frame and discards the capture if the digest changed by the time it returns [AD].
- **Privacy Core** — fusion, policy, placeholders, vault, sanitized-context builder (§7).
- **Egress Guard and Egress Client** — §7.8 and §8.1.
- **Action Validator / Rehydrator** — §7.9.
- **Privacy Ledger** — an in-memory, per-session record of every payload as sent plus timings and detection statistics; viewable in the panel and exportable for the harness [SS] [AD]. Persistence beyond the session is not required by any source → **OQ-9**.
- **Panel UI** — task entry, step timeline, the "what the server saw" view next to the live page, confirmation prompts, and live resource/latency counters (the strategy's "scoreboard on screen") [SS].

### 5.6 Background subsystem

Opens the panel on toolbar click (Chrome `sidePanel.setPanelBehavior`, Firefox `sidebarAction.toggle`), relays permission-change events, and nothing else [TD]. Keeping it trivial means its termination never affects a task.

---

## 6. On-device perception

### 6.1 Two channels and why both [SS]

| Channel | Sees | Blind to | Cost |
|---|---|---|---|
| DOM / accessibility | Exact text, roles, labels, input types, geometry | Canvas, `<img>`, `<video>`, WebGL, PDF viewers that render to canvas, frames the extension cannot enter | Very low |
| Pixels (vision) | Everything rendered | Types and semantics; small or low-contrast text is error-prone | Higher |

The fused channel is the contribution the strategy's ablations are designed to prove: DOM-only leaks on canvas/PDF/image pages; pixel-only is slower and type-blind [SS].

### 6.2 Coverage-driven escalation [AD]

The content script reports what fraction of the viewport has structural provenance (`coverage.explained`). The controller uses it to decide how much vision to run and whether an image is attached to the payload:

| Coverage (initial thresholds, to be tuned with the harness) | Vision work | Payload level |
|---|---|---|
| ≥ 0.92 | Only on `<img>`, `<video>`, `<canvas>` and avatar regions (faces, ID documents, cards) | **L0** — structured only, no image |
| 0.70 – 0.92 | Plus OCR on unexplained regions | L0, or **L1** if the server asked for pixels |
| < 0.70 (canvas apps, PDF viewers, remote desktops) | Full-frame | **L1** — structured + sanitized image |
| Server asks for a specific region | Crop only | **L2** — sanitized crop |

Whether "vision only where needed" satisfies the PS's requirement that the local model "evaluates the current screen state" is an interpretation. To keep the PS requirement visibly met, the ViT encoder runs on every captured frame at low resolution for screen-state classification and region screening (§6.3), and vision is always visible in the panel → **OQ-4** confirms this reading.

### 6.3 Decision: client model stack [TD]

Constraints: no training from scratch and no fine-tuning (C-5) [SS]; small footprint (metric 4); must run on WASM when WebGPU is absent (§5.1); models ship inside the extension, no CDN fetch [AD].

| Role | Candidates considered | Selected | Why |
|---|---|---|---|
| Face detection | YuNet (OpenCV), BlazeFace, SCRFD, large detectors | **YuNet-class ONNX** (sub-megabyte) | Tiny, fast on WASM, pretrained, adequate for screen faces; faces are never dropped from the pipeline [AD]. |
| "The ViT" — screen-state and region screening | Fine-tuned MobileViT/ViT-Tiny classifier [AD]; zero-shot CLIP-family image encoder with text prompts; running a small local VLM | **Small CLIP-family ViT image encoder, zero-shot** against a fixed set of text prompts (for example "an identity card", "a payment card", "a handwritten signature", "a QR code", "a photo of a person", "a login form", "a document page") | Satisfies the "ViT or equivalent" requirement [PS] without training [SS]. Embeddings are computed once per crop and cached. Text-prompt embeddings are precomputed at build time, so the text encoder does not ship. Exact variant chosen in the spike against the size budget. Optional linear probe on frozen embeddings → OQ-5. |
| OCR | Tesseract.js; PaddleOCR PP-OCRv5 mobile (det ≈ 4.6–4.8 MB, multilingual rec ≈ 16 MB ONNX [V]); VLM OCR | **PP-OCRv5 mobile detection + recognition, ONNX** | Purpose-built, small, pretrained, Apache-2.0 [V]. Language-specific recognizers exist, including Devanagari [V], which matches the strategy's Indic test category [SS]. A Latin/English recognizer may be smaller than the multilingual one — measure. |
| Free-text PII (names, addresses, etc.) | Rules only; a small pretrained PII token classifier; **OpenAI Privacy Filter** (Apache-2.0, 1.5 B total / 50 M active parameters, Transformers.js support, eight categories including names, contact details, account numbers, dates and secrets) [V]; server-side NER (forbidden by the PS) | **Two profiles, chosen by the harness:** *S (default)* — a small pretrained PII token classifier within the size budget; *L (opt-in, WebGPU only)* — OpenAI Privacy Filter at q4 | Privacy Filter is likely the strongest recall option, but a community browser demo reports roughly 770 MB of weights on first load [V], which is heavy for metric 4. Shipping both and measuring is the honest way to decide → **OQ-7**. |
| UI element detection for DOM-less regions | YOLO/RT-DETR fine-tuned on UI datasets [AD] | **Not on the client in the first build** | Requires fine-tuning (C-5); OCR text lines plus the server VLM grounding on the sanitized L1 image cover canvas and PDF pages. Revisit only if the harness shows a gap. |
| Optional local small VLM ("Tier-P") [AD] | Florence-2, SmolVLM | **Not built** | Hundreds of MB; not needed by any source requirement; conflicts with metric 4. |

Runtime: **ONNX Runtime Web** for the CNN/ViT/OCR models, and **Transformers.js v4** (whose new WebGPU runtime was built with the ONNX Runtime team [V]) for the token classifier and CLIP-family encoder, sharing one ORT instance where the versions allow it [TD]. Execution-provider order `webgpu` → `wasm`, probed once at startup with a timeout and cached [AD]. `env.allowRemoteModels = false` so nothing is fetched from the Hugging Face Hub at runtime [TD].

Quantisation: int8 for CNN/ViT encoders on WASM; fp16 where WebGPU supports it; keep the OCR recognizer at higher precision if int8 hurts accuracy, because accuracy is worth more points than a few megabytes [AD].

### 6.4 Resource governor [AD]

- One inference at a time, strict queue, per-frame deadline (initial 120 ms). Work that misses the deadline is abandoned and its regions stay grey (fail-closed, not fail-slow).
- Lazy load; evict large sessions (OCR, NER-L) after idle; face detector and ViT encoder stay resident.
- Perceptual-hash cache for image crops and normalized-text hash cache for text analysis, so logos, avatars and static text are analysed once per session.
- Decode at reduced size (`createImageBitmap` with `resizeWidth`) to avoid full-resolution intermediates.
- Degradation ladder driven by measured frame times, `navigator.deviceMemory` and `hardwareConcurrency`: fewer crops → skip OCR on low-priority regions → structured-only mode. Face detection is never dropped.
- WASM threads: Chrome `min(4, hardwareConcurrency/2)`; Firefox single-threaded (§5.1).

### 6.5 Capture cadence [AD]

Event-driven, never a fixed frame rate: capture on navigation commit, mutation quiet period after a burst, `scrollend`, focus change, step boundary, or a server request for pixels. On a static page with high coverage the steady-state capture rate is zero. Browser limit of two captures per second is respected [V].

---

## 7. Privacy architecture (the hard core)

The strategy identifies this layer — fusion, typed substitution, reverse mapping and the egress choke point — as where 70% of the engineering effort belongs [SS].

### 7.1 End-to-end step flow

```
 USER: "log in and submit the form" (strategy demo task)(task text is sanitized too; see §7.10)
   │
   ▼
 1  OBSERVE      content script → Screen Graph + DOM-channel detections + coverage
 2  CAPTURE?     controller decides by coverage / server request → capture → worker
 3  PERCEIVE     worker: faces, ViT screening, OCR on unexplained regions, NER on text spans
 4  FUSE         privacy core merges D + T + V candidates into one redaction plan
 5  SUBSTITUTE   values → vault; placeholders ⟪ENTITY#n⟫ into the graph and text
 6  COMPOSE      (L1/L2 only) worker builds image from positively cleared regions only
 7  GUARD        independent re-scan of serialized JSON + image halos → pass or BLOCK
 8  SEND         egress client → gateway (HTTPS)
 9  REASON       gateway builds placeholder-aware prompt → model → constrained output
10  VALIDATE     client: schema, policy, live-page pre-flight, confirmation if risky
11  REHYDRATE    placeholder → real value from vault, only into a type-matched field
12  ACT          content script dispatches synthetic events
13  SETTLE       wait for page quiet (bounded) → back to 1 with a delta
```

### 7.2 Detection channels [AD] [SS]

- **Channel D (DOM signals)** — near-certain, zero cost, never reads protected values.
- **Channel T (text)** — patterns + checksums + context boost from the field's own label and autocomplete token, then the PII token classifier for names/addresses/free text. Sources: DOM text (exact spans) and OCR text (word/line boxes with confidence).
- **Channel V (vision)** — face detector over image/video/canvas regions; ViT screening for ID documents, payment cards, signatures, QR codes. An ID document or card image is redacted whole without attempting to read it [AD].

### 7.3 Fusion and policy [AD]

- Merge candidates into `SensitiveRegion { box, entity, class, score, sources[] }`.
- Escalation by any channel is allowed; de-escalation needs an explicit, versioned allow-rule or a user "un-redact" for the session.
- Overlaps: same entity → union; different entities → keep the highest class; then rectangle decomposition so boxes do not swallow neighbours (metric 3).
- Controlled dilation (+2 CSS px and a fraction of line height), capped at neighbouring node boxes.
- Partial matches expand to the whole token; low-confidence OCR matches expand to the whole line.
- Class-asymmetric thresholds with a fail-closed uncertainty band (CRITICAL low threshold, LOW high threshold). Initial values come from the draft and are **tunables** for the harness, not facts.

Sensitivity classes (from the draft; the mapping of entities to classes is a policy decision the team should confirm → OQ-3):

| Class | Examples | Default operator |
|---|---|---|
| CRITICAL | password, OTP, CVV, card number, Aadhaar, face, ID document image, private key | Opaque fill + placeholder (value never read for password/OTP/CVV/card-number fields) |
| HIGH | email, phone, full address, DOB, bank account number, PAN, GSTIN, passport number | Opaque fill + placeholder |
| MEDIUM | person name, username, partial address | Opaque fill + placeholder |
| LOW | city, country, generic dates, amounts | Pass through |

Faces use a solid fill, not blur or pixelation, because blur and pixelation are partially invertible [AD]. The PS lists "blurring faces" as an *example* [PS]; solid fill is a stronger variant of the same intent [TD].

### 7.4 Typed placeholders [SS]

A redacted value is replaced by a placeholder that keeps **type and structure** and drops the **value**:

```
In text:          "Signed in as ⟪EMAIL#1⟫"
In a node value:  { "kind": "placeholder", "ref": "⟪AADHAAR#2⟫", "entity": "AADHAAR", "len": 12 }
In an image:      opaque box with the placeholder label drawn inside it
Presence-only:    { "kind": "presence", "entity": "PASSWORD", "len": 9 }   (no ref; nothing to resolve)
```

Labels, roles and layout remain untouched ("Aadhaar number: ⟪AADHAAR#2⟫" is fully actionable for the model). This is how the design improves metric 1 and metric 3 together instead of trading one for the other [SS].

### 7.5 Decision: placeholder identity [TD]

| Option | Behaviour | Verdict |
|---|---|---|
| Random id per occurrence | Server cannot tell that two occurrences are the same value | Rejected — loses coreference |
| HMAC(session key, value) truncated to 2 bytes [AD] | Stable, but 16-bit ids can collide inside a session (a correctness bug) and a truncated keyed hash adds no protection the vault does not already give | Rejected |
| **Per-session counter via the vault's value→ref map** | Same value → same ref within a session; different values never collide; new session → new numbering, so refs are not linkable across sessions | **Selected** |

### 7.6 The vault [SS] [AD]

- In-memory `Map` in the agent host; never serialized, never written to storage, never logged; cleared on task end, panel close, and idle timeout [TD].
- Each entry records: real value, entity, class, origin where it was seen (as an internal origin value that is not transmitted), first-seen step, and source channel.
- Values from password, OTP, CVV and card-number *fields* are never read, so they never enter the vault [AD].
- Values seen as visible text (a displayed Aadhaar or email, for example) do enter the vault, which is what makes rehydration possible [SS].

### 7.7 Additive image composition [AD]

For L1/L2 payloads the worker builds the outgoing image on a fresh canvas pre-filled with a neutral colour, copies in only regions with positive clearance (structural node whose text passed analysis, vision-analysed region with no detection, or known browser/page chrome), then draws labelled opaque boxes for redactions. A timeout, crash or model failure therefore leaves grey, not content. Cleared siblings are merged up to their common container to avoid a "swiss-cheese" image that would hurt metric 1. The resulting `coverage = {cleared, redacted, unanalysed}` is reported in the payload and shown in the panel.

### 7.8 Egress guard — the single choke point [SS]

Runs on the **final serialized bytes**, independently of the detectors that produced them:

1. **Schema and shape check** — payload validates against the protocol schema; ids are opaque session ids; no URL, selector or path fields.
2. **Vault-leak check** — every value currently in the vault is searched for in the serialized JSON (normalized for whitespace and digit grouping). Any hit → block.
3. **Pattern sweep** — the checksum-validated recognizers run again over every string in the payload. Any CRITICAL/HIGH survivor → block.
4. **Image re-scan (L1/L2)** — face detection on the composed image and OCR in a halo around each redaction box; a hit triggers one recompose with larger dilation, then the image is dropped and the step falls back to L0 [AD].
5. **Canary check (debug and harness builds)** — known high-entropy canary strings planted in the corpus must never appear [AD].

**Fail-closed:** on any block the request is not sent, the event is recorded in the ledger (with counts, not values) and shown in the panel [SS].

**Structural enforcement [TD]:** the egress client's `send()` accepts only objects produced by the guard (a branded TypeScript type plus a runtime `WeakSet` membership check). This replaces the draft's same-heap HMAC attestation (C-8e), which added complexity without a real boundary.

**Honest limit:** the guard can only find what its recognizers and detectors can find. A PII type none of them knows can pass. The additive compositor limits this for images; the harness's independent auditor (§12.3) measures it.

### 7.9 Action validation and rehydration [SS] [AD]

Before anything runs on the page:

1. **Schema** — the action parses against the action language (§8.4). A hallucinated action is a parse error, not a click [SS].
2. **Step lease** — the plan is valid only for the step that requested it [AD].
3. **Target resolution and pre-flight** — node still exists, is visible and un-occluded, and matches the expected role and name; geometry drift within tolerance is repaired, semantic change is rejected; hit-test at the click point is mandatory (clickjacking guard) [AD].
4. **Rehydration policy** — a placeholder resolves only from this device's vault, only into an element whose detected type matches the placeholder's entity, only on the origin where the value was seen (→ OQ-8 for cross-origin use), and for CRITICAL class only under the policy chosen in OQ-1.
5. **Risk gating** — form submission on login/payment pages, send, delete, purchase, download and cross-origin navigation require an explicit confirmation in the panel showing exactly what will happen [SS] [AD]. The exact list of "destructive actions" is not defined in the sources → OQ-10.
6. **Hard denials** — no reading of protected field values, no CAPTCHA solving, no disabling of the extension's own controls, no execution of server-supplied code [AD].
7. **Bounded reconciliation** — local re-resolution first; at most a small fixed number of server re-observations per step; then stop and tell the user [AD].

### 7.10 What the task text is allowed to contain [TD]

The user's task instruction is sent to the server so the model knows the goal. The user may type PII into it. The task text therefore goes through the same Channel T analysis and placeholder substitution before sending. (Neither source discusses this; it is a necessary technical consequence of the PS's "no sensitive data to the server" rule.)

### 7.11 What may leave the device [AD]

| Leaves (sanitized) | Never leaves |
|---|---|
| Opaque node ids, roles, accessible names (after analysis), boxes, states, affordances | Raw screenshots, DOM values, the vault |
| Visible text with placeholders | URLs, paths, selectors, page titles containing entities (an origin *category* only, if needed → OQ-11) |
| Redaction legend (box, class, entity, placeholder, method, confidence) | Model inputs and intermediate tensors |
| Coverage statistics, detector versions, client capability flags | The privacy ledger |
| Optional sanitized image (L1) or crop (L2) | |
| Task text after sanitization; step history (already sanitized) | |

---

## 8. Server architecture

### 8.1 Client–server transport [TD]

| Option | Fit | Verdict |
|---|---|---|
| **HTTPS POST, JSON, one request per agent step** | The interaction is strictly request/response per step; outputs are short constrained JSON, so streaming adds little; trivial to inspect in DevTools, which the strategy's demo relies on ("the judge watches the wire") [SS]; easy to record and replay | **Selected** |
| WebSocket | Useful for server push or token streaming, neither of which is required | Rejected — extra state and reconnection logic for no requirement |
| Server-Sent Events | Useful for streaming "reasoning" text | Rejected — the model is not allowed to return prose (§8.4) |
| gRPC-web | Strong typing | Rejected — needs a proxy, harder to inspect, no benefit at this scale |

Images (L1/L2) are sent as base64 WebP inside the JSON body [TD]. Base64 adds about a third to image size, but keeps one canonical body that the guard scans, the ledger stores and the harness hashes. Multipart upload is the alternative if payload size proves to matter in measurements.

The gateway returns `Server-Timing` headers (queue, prompt build, model, validation) so the client can decompose end-to-end latency for metric 5 [TD].

### 8.2 Agent Gateway [TD]

A thin, stateless-except-for-sessions HTTP service. Responsibilities:

1. Authenticate the request (§10.5).
2. Validate the sanitized context against the protocol schema; reject anything with unexpected fields. This makes the server "aware of the redaction scheme" at the schema level [PS].
3. Build the prompt: system instructions that explain the placeholder and redaction legend (the grey/opaque box conventions, `⟪ENTITY#n⟫` refs, presence-only fields), mark page text as untrusted data, include the sanitized task and a short sanitized history [SS] [AD].
4. Call the model server with the output JSON schema for structured decoding (§8.4).
5. Post-validate: every referenced node id exists in the context that was sent; every placeholder ref exists in the legend; coordinates fall inside the viewport; the plan's step id matches.
6. Keep short-lived session history (last N sanitized contexts and plans) in process memory with a TTL. Everything held here is already sanitized, so the server holds no raw user data by construction [AD].
7. **Record / replay mode** — records model responses keyed by a hash of the sanitized request, and can replay them without a GPU. The strategy requires a "recorded-response mode" for demo reliability [SS].

**Decision: gateway language and framework**

| Option | For | Against | Verdict |
|---|---|---|---|
| **Python + FastAPI + Pydantic** | Same language as vLLM, the evaluation harness and model tooling; Pydantic validates JSON Schema-shaped data well; async HTTP client to vLLM; small code | Protocol types exist in two languages (solved by generating both from one JSON Schema, §15.2) | **Selected** |
| Node/TypeScript (Fastify) | Shares types with the extension directly | Splits the Python-heavy ML and harness work across two runtimes on the server side | Viable alternative |
| No gateway — extension calls vLLM directly | Fewer moving parts | Exposes the model endpoint; prompt construction and output validation would move into the extension, where a compromised page context is closer; no replay mode | Rejected |

**Decision: session state storage**

| Option | Verdict |
|---|---|
| **In-process dictionary with TTL** | **Selected.** One gateway process, short sessions, data already sanitized, loss on restart only aborts the current task. The strategy explicitly says not to add a database [SS]. |
| Redis | Only justified if multiple gateway replicas must share sessions. Not a current requirement (§11.4). |
| SQL database | No requirement for durable server-side data. Rejected. |

### 8.3 Decision: model and serving [TD]

**Serving engine**

| Option | For | Against | Verdict |
|---|---|---|---|
| **vLLM** | OpenAI-compatible server; grammar-constrained structured outputs (xgrammar / guidance backends, with the older `guided_*` parameters deprecated in favour of `response_format` JSON schema / `structured_outputs`) [V]; first-class multimodal support; recipes for current Qwen models on a single 24 GB GPU [V] | Needs a GPU for good latency | **Selected** |
| SGLang | Comparable features and speed | Team familiarity and recipe coverage favour vLLM; either would work | Alternative |
| llama.cpp / Ollama | Runs on CPU or small GPUs; GGUF builds of Qwen3-VL exist [V] | Weaker structured-output and batching story; slower | Offline/no-GPU fallback only |
| Hosted closed API | Easy | Violates "open-source/open-weights, offline deployable" [PS] | Rejected |

**Model** — one natively multimodal open-weights model handles both text-only steps (L0) and image steps (L1/L2) (C-3). Candidates to evaluate on the harness:

| Candidate | Notes [V] | Role |
|---|---|---|
| **Qwen3-VL-8B-Instruct** | Apache-2.0; advertised GUI-agent ability ("operates PC/mobile GUIs"); official FP8 weights; vLLM/SGLang recommended; non-thinking "Instruct" variant gives predictable latency | **Default** |
| Qwen3.5-9B | Natively multimodal dense model; vLLM ≥ 0.17 recipe for a single 24 GB GPU; reasoning parser in the recipe suggests a thinking mode that must be disabled or bounded for latency; confirm licence | Challenger |
| Qwen3-VL-4B-Instruct | Smaller, lower latency, lower quality | Fallback for smaller GPUs or latency |
| Qwen2.5-VL-7B (strategy's suggestion) | Older generation | Baseline for comparison only |

Final choice depends on the GPU the team can actually access → **OQ-13** (also open decision 3 in the strategy [SS]).

Coordinate conventions for image grounding differ between model families; a small model adapter in the gateway converts model coordinates to viewport CSS pixels [TD]. Verify the exact convention for the chosen model during integration.

### 8.4 Output language (action DSL) [SS]

The model's output space is a JSON schema enforced by structured decoding. Operations:

| Op | Source | Purpose |
|---|---|---|
| `click(node)` | [SS] | Click an element by opaque id |
| `type(node, text \| ref)` | [SS] (ref); literal text from the task → **OQ-14** | Type a placeholder (resolved locally) or literal text |
| `scroll(direction[, amount])` | [SS] [PS] | Scroll the viewport |
| `wait(ms)` | [SS] | Wait for the page |
| `done(summary)` | [SS] | Finish the task |
| `report(data)` | [PS] ("processed data to be again ingested by local client") | Return processed data; placeholders inside are resolved locally for display only |
| `request_observation(level, region?)` | [AD] (`need_visual`) | Ask for an L1 image or L2 crop |
| `click_point(x, y)` | [TD] | Needed for canvas/PDF targets with no DOM node; validated against a sanitized-image region and always shown to the user |
| `ask_user(question)` / `stop(reason)` | [AD] (CAPTCHA → hand to user; budget exhausted) | Hand control back |

Each action carries `expect` (role, name, box tolerance) and the plan carries a `step_id` and a `risk` hint; the client treats the model's risk hint as advisory and applies its own risk rules [AD]. Full schema in `design.md`.

### 8.5 Server data flow

```
POST /v1/sessions/{sid}/steps
  └─ auth → size limits → schema validate → session lookup (TTL)
       └─ prompt build (system + legend + task + history + context [+ image])
            └─ vLLM chat.completions (response_format = action schema)
                 └─ parse → post-validate (ids, refs, bounds, step lease)
                      ├─ valid   → 200 { plan } + Server-Timing
                      └─ invalid → one constrained retry → else 422 { error }
```

---

## 9. Runtime flows

### 9.1 Task start

1. User opens the panel from the toolbar (user gesture) [V].
2. Panel checks optional host permission for the current site; if missing, requests it (user prompt) [TD].
3. Panel probes WebGPU, picks execution providers, lazy-loads the resident models (face, ViT encoder).
4. Panel creates a session on the gateway (`POST /v1/sessions`) with client capabilities (backend, model versions, policy version) — no page data.
5. User enters the task; Channel T sanitizes it; the loop starts.

### 9.2 Normal step (structured only, L0)

Observe → fuse → substitute → guard → send → plan → validate → act → settle → delta observe. No capture if coverage is high and there are no image/video/canvas regions that changed.

### 9.3 Step with pixels (L1)

As above, plus capture with geometry-digest check, perception in the worker, additive composition, image re-scan in the guard. If the digest changed between snapshot and capture, the frame is discarded; after a bounded number of tries the step degrades to L0 [AD].

### 9.4 Action needing a real value (zero-egress task completion) [SS]

```
server plan:  type(n-12, ref=⟪AADHAAR#2⟫)
client:       schema ok → lease ok → n-12 exists, visible, role=textbox, name≈"Aadhaar"
              → field type matches AADHAAR (label/autocomplete/pattern evidence)
              → origin matches where #2 was seen
              → CRITICAL: policy (OQ-1) → show confirmation "Type your Aadhaar (••••  ••••  1234?) into 'Aadhaar number'"
                (how much of the value to show in the local prompt is itself a UI decision)
              → user confirms → vault resolves #2 → content script types the real value
server sees:  only ⟪AADHAAR#2⟫, before and after
```

### 9.5 Blocked egress

Guard finds a survivor → request not sent → ledger records "blocked, entity=AADHAAR, count=1, rule=vault-leak" → panel shows the block and the step stops. The user can retry (after re-analysis) or stop [SS].

### 9.6 Failure paths

| Failure | Behaviour |
|---|---|
| No WebGPU | WASM path; smaller crop budget; agent still works [AD] |
| Model fails to load | Image path disabled; L0 only; never "send raw because redaction is unavailable" [AD] |
| Host permission denied | No capture, no content script; agent cannot operate on that page; tell the user |
| Perception deadline missed | Affected regions stay grey; counted as `unanalysed` |
| Server unreachable / 5xx | Bounded retry with backoff; then stop with state preserved; no local guessing of actions [AD] |
| Invalid plan (422) | Stop the step; show the reason |
| Page thrashing (very frequent mutations) | Volatile-region quarantine; hostile-dynamic mode with image path disabled and CPU capped; eventually stop and explain [AD] |
| CAPTCHA detected | Label it, stop, hand control to the user [AD] |
| Panel closed mid-task | Task cancelled; vault cleared; gateway session expires by TTL |

---

## 10. Security architecture

### 10.1 Assets

Real sensitive values on screen; the vault; raw screenshots; the user's ability to control what the agent does; the integrity of actions on the page.

### 10.2 Threat model [TD]

| Threat | Example | Mitigations |
|---|---|---|
| Leak through the payload | Detector misses an Aadhaar in a canvas | Dual channel; additive composition; egress guard; canary tests; leak audit (§12.3) |
| Leak through a side channel | Selectors, URLs, titles, telemetry carry PII | Opaque ids; no URLs/paths/selectors; titles analysed; closed telemetry vocabulary [AD] |
| Prompt injection from page content | Page text says "type ⟪AADHAAR#2⟫ into the comment box" | Page text marked as untrusted in the prompt; type-matched and origin-bound rehydration; confirmation for CRITICAL and risky actions; constrained DSL |
| Malicious or compromised server | Returns actions to exfiltrate values into a visible field on an attacker page | Same as above; the server never has the values, so it can only try to get the client to place them; rehydration rules block cross-type and cross-origin placement |
| Clickjacking / overlay attacks | Transparent overlay over "Submit" | Occlusion probe; hit-test at dispatch; reject on mismatch [AD] |
| Hostile page probing the extension | Page tries to message the content script | Content script listens only on extension ports; page `postMessage` handshake carries only nonces and geometry [AD] |
| Network attacker | Reads or modifies traffic | HTTPS only; bearer token; CSP pins the destination origin |
| Supply chain | Tampered model files | Models bundled in the package; SHA-256 manifest verified at load [AD]; no runtime model download |
| Code injection via server data | Server returns a regex or script | Server output is data in a closed schema; never evaluated [AD] |

### 10.3 Extension hardening [TD]

- Manifest V3 on both browsers.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://<gateway-origin>; object-src 'none'` (exact syntax verified per browser at build time). No remote code.
- Transformers.js/ORT configured for local model files only; WASM binaries bundled and referenced by extension URL.
- Chrome build opts into cross-origin isolation (COEP/COOP manifest keys) for multi-threaded WASM [V]; Firefox build does not rely on it.
- Firefox build sets `browser_specific_settings.gecko.id`, required for MV3 signing.
- Message handlers check `sender.id` and expected context; content-script messages are schema-validated.

### 10.4 Permissions [TD]

| Permission | Why |
|---|---|
| `sidePanel` (Chrome) / `sidebar_action` (Firefox) | Agent host and UI |
| `scripting` | Inject content scripts into granted sites |
| `tabs` | Identify the active tab and window the agent is operating on |
| `storage` | Settings and policy selection only (never vault or captures) |
| Optional host permissions (`<all_urls>`, requested per site at task start) | Required for `captureVisibleTab` and content scripts, because a click in the side panel does not grant `activeTab` [V] |

No `debugger`, `webRequest`, `history`, `cookies` or `clipboardRead` permissions [AD] [TD].

### 10.5 Server hardening [TD]

- Reverse proxy terminates TLS; gateway and vLLM listen on a private network only.
- Authentication: a per-deployment bearer token configured in the extension build or settings. The strategy rules out "auth beyond a session" [SS]; multi-user accounts are out of scope. Whether judges' devices need individual tokens → OQ-15.
- Request size limits; rate limit per token; schema-strict parsing (unknown fields rejected).
- Logs contain request ids, timings, counts and errors. Sanitized payloads are logged only in an explicit debug/record mode.

### 10.6 Privacy posture statement

The server can be assumed hostile and the user's sensitive values still do not leave the device, provided the client's detectors find them. What the guard cannot detect is the residual risk, and it is measured, not claimed away [SS].

---

## 11. Reliability, performance and scalability

### 11.1 Reliability [SS] [TD]

- Every failure path defaults to not sending and not acting (§9.6).
- Bounded retries everywhere: capture consistency, reconciliation, server calls.
- Demo reliability requirements from the strategy: primary path fully local; server on localhost or a pinned VM with record/replay; a second configured laptop; a pre-recorded narrated video [SS]. The architecture supports these through replay mode and a single-host Docker deployment that can run on a laptop GPU or replay without one.

### 11.2 Latency budget (targets, to be measured) [AD]

| Stage | L0 target | L1 target |
|---|---|---|
| Screen Graph extraction (delta) | ≤ 10 ms | ≤ 10 ms |
| Text analysis (cached) | ≤ 10 ms | ≤ 10 ms |
| Capture + decode | — | ≤ 30 ms |
| Face + ViT screening | ≤ 15 ms | ≤ 30 ms |
| OCR on unexplained regions | — | ≤ 60 ms |
| Compose + guard + encode | ≤ 5 ms | ≤ 60 ms |
| Network (one way, LAN/near region) | tens of ms | tens of ms plus image |
| Model inference | dominant; measured per model/GPU | larger (image tokens) |
| Validate + act | ≤ 10 ms | ≤ 10 ms |
| Settle wait | bounded (e.g. ≤ 1.5 s, usually far less) | same |

The main latency levers are: L0 by default, deltas after the first frame, short constrained outputs, a non-thinking model variant, and prefix caching of the fixed system prompt in vLLM [TD].

### 11.3 Client resource targets (to be measured on the weakest credible reference laptop) [SS] [AD]

| Resource | Target | How it is controlled |
|---|---|---|
| Bundled model size, profile S | Keep as small as the harness allows; report the exact MB | Model choice (§6.3); int8 |
| Peak memory of the agent host + worker | Report; draft target ≤ 250 MB | Lazy load, eviction, one inference at a time |
| CPU while idle on a static page | ~0% | Event-driven cadence |
| CPU during an active task | Report average and peak | Crop budgets, caching, degradation ladder |
| GPU time | Report | WebGPU EP, fp16 where valid |

The reference machine is an open decision in the strategy [SS] → **OQ-16**.

### 11.4 Scalability [TD]

- **Client side:** work scales with page complexity, not with user count; the budgets above bound it.
- **Server side:** one GPU running vLLM serves several concurrent sessions through continuous batching. No stated requirement exists for concurrent users or throughput [A]; the strategy asks for any at-scale claim to be a measured load test, not a live demo [SS].
- **If scale is ever required:** run N identical gateway + vLLM pairs behind the reverse proxy with sticky routing by session id (sessions are short and in memory). Only if sticky routing is not possible does a shared session store (Redis) become justified. None of this is built now.

---

## 12. Observability and evaluation

### 12.1 On the client

- **Privacy Ledger** — per step: timestamp, payload level, the exact bytes sent (viewable), entity counts by class and channel, coverage triple, guard verdict, per-stage timings, detector versions [SS] [AD].
- **Live counters in the panel** — per-step latency breakdown, models loaded and their size, backend (WebGPU/WASM), memory estimate [SS].
- **Debug logs** use a closed vocabulary: numbers, enums and version strings only; never free text from pages [AD].

### 12.2 On the server

Structured JSON logs with request id and timings; vLLM's built-in metrics endpoint for model-side metrics; `Server-Timing` headers back to the client. No external observability stack is required by any source [TD].

### 12.3 Evaluation harness (built first) [SS]

```
eval/
  corpus  ── 200–300 labelled screens across the strategy's categories
             (gov portals, banking, email/chat, social, healthcare, canvas apps,
              PDF.js, video/camera, Indic scripts, hard negatives), 20% held out
  labels  ── ground-truth boxes + entity types per screen, canary strings
  runner  ── Playwright (Chromium with the unpacked extension; Firefox run
             separately), drives tasks and scripted pages, collects ledger exports
  scorers ── metric 1: task success on sanitized vs raw context (strategy's definition)
             metric 2: per-entity precision/recall
             metric 3: over-redaction rate on hard negatives + box IoU
             metric 4: model MB, memory, CPU/GPU on the reference laptop
             metric 5: p50/p95 per stage and full round trip
             + leak count from an independent auditor
  ablations ── DOM-only vs pixel-only vs fused; black-box vs typed placeholders
  reports  ── CSV + a single HTML/Markdown scoreboard with n, hardware, data source
```

The **independent auditor** re-implements recognizers in Python (not a copy of the TypeScript code) and adds a stronger server-grade OCR/NER pass over captured payloads to estimate leaks the client could not see [SS] [TD]. Using a different implementation is what makes the leak count meaningful.

Metric 1's official definition is not given in the PS; the strategy's interpretation (task success retained versus raw context) is used, and a per-element perception accuracy score is also recorded in case the judges mean the local model's own understanding → **OQ-4**.

Playwright loads unpacked extensions into its bundled Chromium via a persistent context; branded Chrome builds have removed the side-loading flags, so the harness uses Playwright's Chromium [TD, verify at setup]. Resource sampling uses the harness side (OS process statistics, and CDP from the harness process where needed) rather than giving the extension the `debugger` permission.

---

## 13. Deployment architecture

### 13.1 Client distribution [TD]

| Target | Artifact | How it is installed during SIH |
|---|---|---|
| Chrome / Chromium | Unpacked build folder and a `.zip` | "Load unpacked" in developer mode |
| Firefox | `.xpi` / `.zip` | Temporary add-on via `about:debugging`; signed build only if store publication is wanted |

Models are inside the package; no first-run download [AD]. Store publication is not required by any source → out of scope unless decided otherwise.

### 13.2 Server deployment [TD]

```
single GPU host (cloud VM during SIH, on-prem box for offline deployment)
└─ docker compose
   ├─ proxy     (Caddy: automatic HTTPS, simple config)         :443 public
   ├─ gateway   (FastAPI + Uvicorn)                             :8080 private
   └─ vllm      (official vLLM image, model weights on a volume) :8000 private
```

- **Why Docker Compose and not Kubernetes:** one host, three processes, no autoscaling requirement; the strategy lists Kubernetes under "do not build" [SS].
- **Why Caddy over Nginx:** automatic certificate management with a few lines of config; Nginx is equally valid if the team already has it.
- **Offline deployment path [PS]:** model weights pre-downloaded into the volume, container images saved with `docker save`, Hugging Face offline mode enabled, TLS with an internal certificate. The same compose file runs air-gapped.
- **Replay-only mode:** the gateway runs without vLLM and serves recorded responses, for rehearsals and as a demo fallback [SS].
- **Hardware:** a single 24 GB GPU is the documented fit for 8–9 B multimodal models in BF16 [V]; FP8/quantized weights reduce memory. Exact GPU availability → OQ-13.

### 13.3 Environments

| Environment | Purpose |
|---|---|
| `local` | Developer laptop; gateway in replay mode or pointed at a shared GPU |
| `gpu-dev` | Shared cloud GPU for integration and harness runs |
| `demo` | Pinned VM used at SIH, plus the replay fallback on the demo laptop |

### 13.4 Continuous integration [TD]

On every push: lint (including the no-network-outside-egress rule), type-check, unit tests for recognizers and fusion, protocol schema compatibility check (TS and Python generated types in sync), build both browser targets, and the canary leak test on the fixture corpus. GitHub Actions is sufficient; nothing heavier is needed.

---

## 14. Technology stack summary

| Layer | Choice | Key reason |
|---|---|---|
| Extension language | TypeScript (strict) | Shared types with the protocol; safety for the privacy core |
| Extension framework/build | **WXT** (Vite-based) | One codebase → Chrome and Firefox MV3 manifests; maps a single `sidepanel` entrypoint to Chrome side panel and Firefox sidebar [V] |
| Panel UI | Preact | Small runtime (metric 4); familiar component model; the panel is simple |
| Cross-browser API | `browser.*` namespace via WXT's polyfilled API | Promise-based API on both browsers |
| Inference runtime | ONNX Runtime Web (WebGPU → WASM) + Transformers.js v4 | PS names both; v4 WebGPU runtime built with the ORT team [V] |
| Client models | YuNet-class face detector; small CLIP-family ViT encoder (zero-shot); PP-OCRv5 mobile det/rec; small PII token classifier (profile S) / OpenAI Privacy Filter (profile L) | §6.3 |
| Validation | JSON Schema (source of truth) → generated TS types + a runtime validator in the extension | One contract, two languages |
| Gateway | Python 3.12, FastAPI, Pydantic v2, httpx | §8.2 |
| Model serving | vLLM (OpenAI-compatible, structured outputs) | §8.3 |
| Server model | Qwen3-VL-8B-Instruct (default), Qwen3.5-9B (challenger) | §8.3 |
| Packaging | Docker Compose, Caddy | §13.2 |
| Evaluation | Python, Playwright, pandas; `uv` for Python environments | §12.3 |
| Monorepo tooling | pnpm workspaces (JS/TS) + uv (Python) | Two ecosystems, one repository, no heavy build orchestrator |
| CI | GitHub Actions | §13.4 |

Versions are pinned in lockfiles at project start; re-check current releases of WXT, ONNX Runtime Web, Transformers.js and vLLM on that day rather than trusting this document.

---
## 15. Repository structure

### 15.1 Layout

One monorepo. The top level separates the four things that are built and run differently: the extension, the server, shared contracts and pure logic, and the evaluation harness.

```
AEGIS/
├── README.md                         # what it is, how to run, honest limitations (strategy asks for this)
├── LICENSE
├── NOTICE                            # third-party model and library attributions (Apache-2.0 etc.)
├── package.json                      # pnpm workspace root (scripts only)
├── pnpm-workspace.yaml
├── pyproject.toml                    # uv workspace root (server + eval)
├── uv.lock
├── .github/
│   └── workflows/
│       ├── ci.yml                    # lint, typecheck, unit tests, schema sync, builds, canary test
│       └── eval-nightly.yml          # optional: harness on the dev split
│
├── docs/
│   ├── architecture.md               # this file
│   ├── design.md
│   ├── product-requirements.md
│   ├── decisions/                    # one short ADR per decision in §17 once made
│   │   └── 0001-agent-host-in-side-panel.md
│   └── demo/
│       ├── demo-script.md            # the 30-second wow and follow-ups (from the strategy)
│       └── judge-qa.md
│
├── packages/                         # shared, framework-free TypeScript
│   ├── protocol/                     # THE CONTRACT between client and server
│   │   ├── schema/                   # JSON Schema — single source of truth
│   │   │   ├── sanitized-context.schema.json
│   │   │   ├── action-plan.schema.json
│   │   │   ├── session.schema.json
│   │   │   └── error.schema.json
│   │   ├── src/
│   │   │   ├── generated/            # TS types generated from schema (committed)
│   │   │   ├── validate.ts           # runtime validators (compiled from schema)
│   │   │   └── index.ts
│   │   ├── scripts/generate.ts       # schema → TS; also triggers Python generation
│   │   └── package.json
│   │
│   ├── recognizers/                  # pure functions, no DOM, no browser APIs
│   │   ├── src/
│   │   │   ├── checksums/            # verhoeff.ts, luhn.ts, gstin.ts, ...
│   │   │   ├── patterns/             # aadhaar.ts, pan.ts, ifsc.ts, upi.ts, card.ts, phone.ts, email.ts
│   │   │   ├── context/              # label / autocomplete context lexicons
│   │   │   ├── registry.ts           # RecognizerRegistry (Presidio-style)
│   │   │   └── index.ts
│   │   ├── test/                     # table-driven tests incl. hard negatives
│   │   └── package.json
│   │
│   └── policy/                       # sensitivity classes, thresholds, operators, rehydration rules
│       ├── policies/
│       │   └── default.policy.json   # versioned data, never code
│       ├── src/                      # loader + typed accessors + validation
│       └── package.json
│
├── apps/
│   └── extension/                    # WXT project → Chrome and Firefox builds
│       ├── wxt.config.ts             # manifest per browser, CSP, permissions, COEP/COOP (Chrome)
│       ├── package.json
│       ├── tsconfig.json
│       ├── eslint.config.js          # includes the no-network-outside-egress rule
│       ├── public/
│       │   ├── icons/
│       │   ├── models/               # bundled ONNX files (fetched by scripts/, not hand-committed if large)
│       │   │   └── models.manifest.json   # name, version, sha256, size, license
│       │   └── ort/                  # ONNX Runtime WASM binaries
│       ├── entrypoints/              # WXT file-based entrypoints (thin: wire up src/)
│       │   ├── background.ts         # open panel, permission events; nothing else
│       │   ├── content.ts            # boots src/content
│       │   └── sidepanel/            # → Chrome side_panel, Firefox sidebar_action
│       │       ├── index.html
│       │       └── main.tsx          # boots src/host and src/ui
│       ├── src/
│       │   ├── content/              # runs in page frames (isolated world)
│       │   │   ├── screen-graph/     # extractor, accname, visibility, geometry, frames, shadow-dom
│       │   │   ├── detect/           # DOM-channel signals + calls into packages/recognizers
│       │   │   ├── observe/          # mutation/resize/scroll observers, change classification, epochs
│       │   │   ├── execute/          # pre-flight, synthetic event sequences, settle detection
│       │   │   └── port.ts           # typed port endpoint (content side)
│       │   │
│       │   ├── host/                 # runs in the side panel page (agent host)
│       │   │   ├── controller/       # step state machine, budgets, reconciliation
│       │   │   ├── capture/          # captureVisibleTab wrapper, rate limit, digest check
│       │   │   ├── privacy/
│       │   │   │   ├── fusion/       # merge, arbitration, rectangle decomposition, dilation
│       │   │   │   ├── placeholders/ # ref minting, text substitution
│       │   │   │   ├── vault/        # in-memory vault (no serialization methods exist)
│       │   │   │   ├── context/      # SanitizedContext builder, deltas
│       │   │   │   └── guard/        # egress guard (JSON sweep, vault-leak, image re-scan request)
│       │   │   ├── egress/           # the ONLY module allowed to call fetch; accepts GuardedPayload only
│       │   │   ├── actions/          # validator, rehydrator, risk rules, confirmation requests
│       │   │   ├── ledger/           # privacy ledger + export for the harness
│       │   │   ├── platform/         # browser differences (shadow-root API, sidebar vs side panel, COI)
│       │   │   └── port.ts           # typed port endpoint (host side)
│       │   │
│       │   ├── perception/           # runs in the dedicated Web Worker
│       │   │   ├── worker.ts         # message loop, queue, deadlines
│       │   │   ├── runtime/          # ORT/Transformers.js init, EP probe, session cache, eviction
│       │   │   ├── models/           # face.ts, vit-encoder.ts, ocr-det.ts, ocr-rec.ts, pii-ner.ts
│       │   │   ├── preprocess/       # resize, crop, tensor conversion, pHash
│       │   │   ├── compose/          # additive compositor on OffscreenCanvas
│       │   │   └── rescan/           # halo OCR + face re-check for the guard
│       │   │
│       │   ├── ui/                   # Preact components for the panel
│       │   │   ├── TaskInput.tsx
│       │   │   ├── StepTimeline.tsx
│       │   │   ├── PayloadViewer.tsx # "what the server saw"
│       │   │   ├── ConfirmAction.tsx
│       │   │   ├── MetricsBar.tsx    # latency, backend, model sizes, memory
│       │   │   └── Settings.tsx      # server URL/token, policy profile, NER profile
│       │   │
│       │   └── shared/               # message types, logger (closed vocabulary), errors, utils
│       │
│       ├── scripts/
│       │   ├── fetch-models.ts       # download pinned models, verify sha256, write manifest
│       │   └── check-no-network.ts   # build-time scan: fetch/XHR/WebSocket only in host/egress
│       └── test/
│           ├── unit/                 # fusion, vault, guard, validator (Vitest)
│           ├── fixtures/             # static HTML pages with planted PII and canaries
│           └── e2e/                  # Playwright smoke tests with the built extension
│
├── server/
│   ├── gateway/                      # Python package: AEGIS_gateway
│   │   ├── pyproject.toml
│   │   ├── src/AEGIS_gateway/
│   │   │   ├── main.py               # FastAPI app factory
│   │   │   ├── config.py             # settings from env
│   │   │   ├── api/                  # routes: sessions, steps, health
│   │   │   ├── protocol/             # Pydantic models generated from packages/protocol/schema
│   │   │   ├── prompt/               # system prompt, legend rendering, history windowing
│   │   │   ├── model_client/         # vLLM client, model adapters (coordinate conventions)
│   │   │   ├── validation/           # post-validation of plans against the sent context
│   │   │   ├── sessions/             # in-memory TTL store
│   │   │   ├── replay/               # record / replay store (files on disk)
│   │   │   └── auth.py
│   │   └── tests/
│   ├── deploy/
│   │   ├── docker-compose.yml        # proxy + gateway + vllm
│   │   ├── docker-compose.replay.yml # gateway only, replay mode
│   │   ├── Caddyfile
│   │   ├── gateway.Dockerfile
│   │   ├── vllm.env                  # model id, max length, structured-output backend
│   │   └── offline/                  # scripts: save images, pre-download weights, offline env
│   └── recordings/                   # recorded model responses for demo replay (gitignored or LFS)
│
├── eval/                             # the scoreboard (Python)
│   ├── pyproject.toml
│   ├── corpus/
│   │   ├── dev/                      # 80% — used during development
│   │   ├── heldout/                  # 20% — touched once (strategy rule)
│   │   └── README.md                 # categories, quotas, sources, licensing of assets
│   ├── labels/                       # ground truth (boxes, entities), label schema
│   ├── tasks/                        # scripted end-to-end tasks for metric 1 and 5
│   ├── src/AEGIS_eval/
│   │   ├── runner/                   # Playwright driver, ledger collection, resource sampling
│   │   ├── scorers/                  # metric1.py … metric5.py, leak.py
│   │   ├── auditor/                  # independent recognizers + stronger OCR/NER
│   │   ├── ablations/                # dom_only, pixel_only, fused, blackbox_vs_placeholder
│   │   └── report/                   # CSV + scoreboard rendering
│   ├── reports/                      # generated outputs (gitignored except tagged runs)
│   └── tests/
│
└── tools/
    ├── labeler/                      # minimal box-labelling helper for the corpus (if needed)
    └── models/                       # export / quantize scripts, prompt-embedding precompute
        ├── export_vit_prompts.py     # precompute text-prompt embeddings for zero-shot ViT
        └── quantize.py
```

### 15.2 How the codebase is organised, and why

- **By runtime context, not by feature, inside the extension.** `content/`, `host/` and `perception/` correspond to the three JavaScript contexts that cannot share memory. A file's folder tells you what it may touch (§5.3). This makes privacy review tractable: raw pixels can only appear under `perception/`; network calls only under `host/egress/`.
- **Pure logic in `packages/`.** Recognizers and policy have no browser dependencies, so they are unit-tested in Node and reused by the harness when it needs to reproduce client behaviour for ablations.
- **One contract.** JSON Schemas in `packages/protocol/schema/` generate TypeScript types for the extension and Pydantic models for the gateway. CI fails if the generated code is out of date. The server's "awareness of the redaction scheme" [PS] is literally this schema plus the prompt builder.
- **Policy is data.** Classes, thresholds and rehydration rules live in versioned JSON so a threshold change does not require a code change, and every payload records the policy version [AD].
- **Entrypoints are thin.** WXT entrypoints only boot modules from `src/`, so the same code is testable outside the extension runtime.
- **The harness is a peer, not an afterthought.** `eval/` sits at the top level with its own environment, as the strategy requires [SS].

### 15.3 Dependency rules (enforced by lint)

```
packages/recognizers, packages/policy   → no imports from apps/ or browser APIs
packages/protocol                        → no runtime dependencies beyond the validator
apps/extension/src/content               → may import packages/*, src/shared; NOT host/ or perception/
apps/extension/src/perception            → may import packages/*, src/shared; NOT host/ or content/
apps/extension/src/host                  → may import packages/*, src/shared; talks to others by messages only
apps/extension/src/host/egress           → the only place fetch() is allowed; imports guard types only
apps/extension/src/host/privacy/vault    → exports no serialize/toJSON; imported only by privacy/ and actions/
server/*                                 → imports generated protocol models; never imports eval/
eval/*                                   → may import server protocol models; never imported by product code
```

---

## 16. Build order and scope tiers

Mapped from the strategy's tiers [SS] onto this architecture. The strategy's Tier 1 is the minimum that must work flawlessly.

| Tier | Contents | Components |
|---|---|---|
| **Tier 1 — must work** | One end-to-end task on one real page with capture → dual detection → fusion → placeholders → egress guard → server → action → local resolution → execution; face + password + Aadhaar/card detection; vault and reverse mapping; payload view; scoreboard computing the five metrics from a local fixture | protocol, recognizers, policy; content (graph, detect, execute); host (controller, capture, privacy, guard, egress, actions, ledger); perception (face, ViT, compose); gateway; vLLM; eval (runner, scorers on fixtures) |
| **Tier 2 — if time permits** | Canvas and PDF.js categories; ablation runner; Firefox build; settings UI and per-type policy | perception (OCR), eval ablations, platform shims, ui/Settings |
| **Tier 3 — simulated, labelled** | Cloud-hosted model during SIH with the offline path documented; any scale claim as a measured load test | deploy/offline, a load-test script |
| **Tier 4 — do not build** | Mobile, multi-language UI, payments, RBAC, fine-tuning, anything not in the demo script [SS]; blockchain, second database, Kubernetes, training from scratch [SS] | — |

Suggested sequence inside Tier 1 (keeps something demoable at each point):

1. **Spike (go/no-go):** ORT Web on WebGPU and WASM inside the side-panel worker on the reference laptop; measure [SS].
2. **Contract + harness skeleton:** protocol schemas; corpus started; scorers running on fixtures [SS].
3. **Spine:** Screen Graph → L0 payload → gateway → constrained plan → validated action. A working agent without privacy.
4. **Privacy core:** Channel D + recognizers + policy + placeholders + vault + guard + ledger view. The differentiator exists.
5. **Vision:** capture, face, ViT screening, additive compositor, L1 payload, image re-scan. The PS's CV requirement is visibly met.
6. **Measurement:** full harness run, ablations, held-out split once [SS].

If time runs out, cut in this order: OCR on low-priority regions → NER profile L → deltas → Firefox parity. **Never cut** the additive compositor, the vault-leak check or the canary test — they are what make the privacy claim true rather than asserted [AD].

---

## 17. Open decisions and questions

| ID | Question | Why it matters | Proposed default |
|---|---|---|---|
| OQ-1 | May the agent type CRITICAL-class values (e.g. Aadhaar) from the vault, and under what control? (C-1) | Core of the killer feature vs. the draft's safety rule | Allowed with per-action confirmation, same origin, type-matched |
| OQ-2 | Besides values visible on the current page, is there any other source of values for form filling (e.g. a user profile)? (C-2) | Not in any source; would add storage and consent design | No other source |
| OQ-3 | Final entity → class mapping and thresholds | Directly moves metrics 2 and 3 | Draft's table as the starting point, tuned by harness |
| OQ-4 | What exactly does metric 1 measure: server task success on sanitized context, or the local model's perception accuracy? Does coverage-based vision satisfy "evaluates the current screen state"? | Determines what to optimise and report | Report both; ViT screening on every capture |
| OQ-5 | Is a linear probe on frozen ViT embeddings acceptable under "no fine-tuning"? | Could raise region-classification accuracy cheaply | Zero-shot first; probe only if approved |
| OQ-6 | May placeholders reveal partial values (e.g. last four card digits)? | Utility vs. disclosure | No |
| OQ-7 | NER profile S vs. L as default | Recall vs. client resources | Decide from harness numbers |
| OQ-8 | May a value seen on one origin be typed on another origin? | Common in real tasks; also the main exfiltration path | No, unless confirmed per action |
| OQ-9 | Should the privacy ledger persist beyond the session? | Storage of metadata about sensitive screens | Session-only, exportable |
| OQ-10 | Which actions count as destructive / need confirmation? | PS mentions none; strategy says "destructive actions require confirmation" | Submit on login/payment forms, send, delete, purchase, download, cross-origin navigation |
| OQ-11 | May the server receive the site's origin or only a category? | Origin can help planning but is itself identifying | Category only |
| OQ-12 | Re-baselined plan given the date (17 Sept) vs. the 20 Sept portal deadline | Scope realism | Submit with Tier 1 evidence; Tier 2 for the finale |
| OQ-13 | Which GPU is available, and therefore which server model? | Latency and quality | Qwen3-VL-8B-Instruct on a 24 GB GPU |
| OQ-14 | May `type` carry literal text from the user's task (e.g. a search query)? | Needed for many tasks; literal text passes through the guard | Yes, after sanitization |
| OQ-15 | Authentication model for judges' devices during the finale | Security vs. setup friction | Single deployment token |
| OQ-16 | Reference laptop for metric 4 | Numbers are meaningless without it | The weakest credible machine the team has, integrated GPU |
| OQ-17 | Project name (AEGIS / DRISHTI / BLINDFOLD) | Branding only | AEGIS |

---

## 18. References

Problem and team inputs: SIH 2026 PS 26171; `sih26171-solution-strategy.md`; `sih26171-architecture.md`.

Platform and tooling facts checked for this document (September 2026):

- WebGPU implementation status (gpuweb wiki) and Firefox 152 Linux flag issue — Firefox Linux still behind a preference.
- Chrome extension docs: `chrome.sidePanel` (Chrome 114+, `open()` from 116 with a user gesture), `chrome.tabs.captureVisibleTab` (rate limit constant), offscreen documents (only `runtime` messaging), cross-origin isolation manifest keys.
- Mozilla: event-page idle termination behaviour (Bugzilla 1771203, 1851373); `Element.openOrClosedShadowRoot`; SharedArrayBuffer for extension pages limited to privileged extensions (Bugzilla 1673477); `sidebarAction`.
- WXT docs: side panel entrypoint maps to Chrome `side_panel` and Firefox `sidebar_action`.
- ONNX Runtime Web docs (WebGPU EP); Transformers.js v4 release notes (new WebGPU runtime; v4.2 adds OpenAI Privacy Filter support).
- OpenAI Privacy Filter announcement and model card (Apache-2.0, 1.5 B total / 50 M active, eight PII categories).
- PaddleOCR PP-OCRv5 mobile (paper and ONNX exports; Devanagari recognizer available).
- Qwen3-VL model cards (Apache-2.0, GUI-agent capability, vLLM/SGLang deployment); Qwen3.5 release notes and vLLM recipe (single 24 GB GPU for 9B).
- vLLM structured outputs documentation (xgrammar/guidance backends; `guided_*` deprecated in favour of `response_format` / `structured_outputs`).
