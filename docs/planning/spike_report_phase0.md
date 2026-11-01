# Phase 0 Spike Report — In-Browser Inference Go/No-Go

**Status: NOT YET MEASURED.** This document is a template with its protocol filled in and its
results empty. It must not be presented, quoted or built on until §2 and §3 contain real numbers
from a real browser on the reference laptop.

**Question:** can ONNX Runtime Web run a face detector inside a dedicated Web Worker spawned from
the extension's side panel, on both Chrome and Firefox, fast enough that metrics 4 and 5 survive?

**Why it is first:** architecture §16 puts this ahead of everything else because a "no" changes the
host context (§5.2), the model stack (§6.3) and the coverage-escalation design (§6.2). It is far
cheaper to learn it now than in Phase 4.

**Harness:** `apps/extension/entrypoints/sidepanel/main.tsx` + `src/perception/worker.ts` +
`src/shared/spike.ts`, all three deleted or superseded in Phase 2/4. This report is what remains.

**Model:** `face_detection_yunet_2023mar.onnx` — the real YuNet detector architecture §6.3 selects.
MIT (Shiqi Yu), 232,589 bytes, sha256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`,
fetched from OpenCV Zoo and verified. **Input is a random-filled tensor**, not a real frame: this
measures runtime viability, not detection accuracy. Accuracy is Phase 4's and Phase 5's problem, and
no number here may be quoted as a detection result.

---

## 0. Why this is empty

The environment the Phase-0 scaffold was built in has **no Chrome or Chromium binary and no GPU**.
A WASM number produced there would describe a headless container rather than the mid-range
integrated-GPU laptop metric 4 must be reported on, and a WebGPU number could not be produced at
all.

Fabricating or substituting numbers would be worse than having none, because a recorded number gets
trusted downstream — the 120 ms per-frame deadline, the 16/8 crop budgets and the coverage
thresholds are all supposed to be derived from this measurement. Per design.md §1 and [SS], every
figure is a target until the harness produces it, and every reported number states its hardware.

**Action required:** run §1's protocol on the candidate reference laptop and fill in §2 and §3.

---

## 1. Protocol

Run on the candidate reference laptop (OQ-16 — *"the weakest credible machine the team has,
integrated GPU"*), on mains power, no other heavy application running.

**Chrome**
1. `pnpm install`
2. `pnpm dev:chrome`, or `pnpm --filter @aegis/extension build` then load `.output/chrome-mv3`
   unpacked via `chrome://extensions` → Developer mode → Load unpacked
3. Click the AEGIS toolbar icon → the side panel opens
4. Record the **Environment** and **Backend availability** blocks verbatim
5. Press **Bench WebGPU**, then **Bench WASM**
6. Repeat from a fresh browser start **three times**; report the median run and note the spread

**Firefox**
1. `pnpm dev:firefox`, or load `.output/firefox-mv3` via `about:debugging` → This Firefox → Load
   Temporary Add-on → `manifest.json`
2. Open the sidebar; same recording procedure
3. **On Linux:** record `dom.webgpu.enabled` and run once with it on and once off — architecture
   §5.1 states Firefox on Linux still needs the preference as of 152–155, and NFR-11 depends on the
   WASM path being genuinely usable there

---

## 2. Results — Environment and backend availability

### 2.1 Reference machine

| | |
|---|---|
| Make / model | *(not recorded)* |
| CPU | *(not recorded)* |
| RAM | *(not recorded)* |
| GPU | *(not recorded)* |
| OS | *(not recorded)* |
| Chrome version | *(not recorded)* |
| Firefox version | *(not recorded)* |
| Date of run | *(not recorded)* |

### 2.2 Chrome

| Field | Observed |
|---|---|
| `hardwareConcurrency` | *(not recorded)* |
| `deviceMemory` | *(not recorded)* |
| `crossOriginIsolated` | *(expected `true` — COEP/COOP are set for the Chrome build)* |
| `SharedArrayBuffer` | *(expected present)* |
| `OffscreenCanvas` | *(expected present — Phase 4's compositor needs it)* |
| WebGPU available **in the worker** | *(not recorded)* |
| Adapter vendor / architecture | *(not recorded)* |
| WASM threads chosen | *(not recorded)* |

### 2.3 Firefox

| Field | Observed |
|---|---|
| `hardwareConcurrency` | *(not recorded)* |
| `crossOriginIsolated` | *(expected `false` — Firefox grants SAB to privileged extensions only)* |
| `SharedArrayBuffer` | *(expected absent)* |
| WebGPU available in the worker | *(not recorded)* |
| `dom.webgpu.enabled` (Linux) | *(not recorded)* |
| WASM threads chosen | *(expected 1)* |

---

## 3. Results — Face detector latency

n = 30 timed runs after one warm-up, per row. Median of three browser restarts.

| Browser | Backend | Threads | load ms | warmup ms | p50 ms | p95 ms | min | max |
|---|---|---|---|---|---|---|---|---|
| Chrome | webgpu | — | | | | | | |
| Chrome | wasm | | | | | | | |
| Firefox | webgpu | — | | | | | | |
| Firefox | wasm | 1 | | | | | | |

**Reference budget:** the per-frame perception deadline is **120 ms** (architecture §6.4, design.md
§10.2) — itself an initial tunable that this measurement is the first evidence about. The face
detector is only one of several models that must fit inside a frame.

---

## 4. Platform table verification (T-0.13)

Design.md §14's rows, checked against real browsers rather than documentation.

| Capability | Chrome — observed | Firefox — observed |
|---|---|---|
| Panel host opens from toolbar / sidebar toggles | | |
| WebGPU **inside a worker** | | |
| `crossOriginIsolated` | | |
| `SharedArrayBuffer` | | |
| `OffscreenCanvas` in the worker | | |
| Closed shadow root API reachable from a content script | | |
| `captureVisibleTab` rate-limit behaviour | | |

---

## 5. Verdict

**Not determined.**

Per phase_0 §8.4, the consequence follows from the numbers:

| Observation | Consequence |
|---|---|
| WebGPU available in the worker on both, p95 well inside the deadline | Proceed as designed |
| WebGPU unavailable *in a worker* but available on the panel main thread | Build T-0.12 — ORT on the panel main thread for that browser; the worker keeps pre/post-processing (architecture §5.2's declared fallback) |
| WebGPU unavailable entirely on the reference laptop | Not fatal — NFR-11 already makes the WASM path first-class. But the 120 ms deadline and the 16/8 crop budgets must be re-derived from the measured WASM numbers before Phase 4 |
| WASM p95 far above 120 ms even for this 227 KB model | **Go/no-go trigger.** Escalate before Phase 1: the model stack (§6.3), the escalation thresholds (§6.2) or the reference machine all come back into question |

**Consequence taken:** *(to be recorded, with the decision and its date, here and in
[../HISTORY.md](../HISTORY.md))*

---

## 6. What Phase 4 may and may not rely on

Until §2, §3 and §5 are filled in:

- **May not rely on** the 120 ms per-frame deadline, the 16 (WebGPU) / 8 (WASM) crop budgets, the
  0.92 / 0.70 coverage-escalation thresholds, or WebGPU being present in a worker context on any
  browser. All four are unvalidated guesses.
- **May rely on** the extension building as MV3 on both browsers with the correct panel host per
  browser, the model fetch-and-verify pipeline, and the fact that ORT's WASM binary is bundled
  locally rather than fetched from a CDN — those were verified mechanically during the Phase-0
  build and are recorded in [phase_0_spike_foundations.md](phase_0_spike_foundations.md) §16.
