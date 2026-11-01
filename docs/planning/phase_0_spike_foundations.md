# Phase 0 — Foundations, the Extension Shell & the In-Browser Inference Spike

**Document type:** Phase 0 execution document
**Requirements basis:** FR-1, FR-2, FR-10, FR-11, FR-13; NFR-4, NFR-11; AC-3 (prepares)
**Architecture basis:** `architecture.md` §5.1 (platform facts), §5.2 (where the runtime lives), §6.3 (client model stack), §13.1 (distribution), §15.1 (repository layout), §16 (build order step 1), §17 OQ-12/OQ-13/OQ-16
**Design basis:** `design.md` §11.2 (backend selection), §11.3 (model registry), §14 (platform abstraction)
**Depends on:** Nothing. This is the first execution phase; it operates on an empty repository.
**Status:** **In progress.** Scaffold, extension shell, worker and spike harness are built and verified. The spike *measurements* (T-0.8…T-0.11, T-0.13) are outstanding and blocked on real hardware.

---

## 1. Objective

At the end of this phase the repository is a foundation the rest of AEGIS can be built on, and the
single question that can invalidate the whole architecture has a measured answer.

The architecture bets that a browser extension can run a vision model on the user's own machine
fast enough that metrics 4 (client resource utilization, 20%) and 5 (end-to-end latency, 15%) do
not collapse. If ONNX Runtime Web cannot hit the latency budget inside a side-panel worker on the
weakest credible laptop, then the host context, the model stack, or the coverage-escalation design
all change — and it is far cheaper to learn that now than in Phase 4. Architecture §16 therefore
puts this spike first, before the contract, before the harness, before any product code.

**By the end of this phase:** a developer runs `pnpm install && pnpm dev:chrome`, loads the
unpacked build, clicks the toolbar icon, and a side panel opens. It reports the machine's
`hardwareConcurrency`, whether the page is cross-origin isolated, and whether WebGPU produced an
adapter inside a *dedicated Web Worker* — with the adapter's vendor and architecture if it did.
They press **Bench WebGPU** and **Bench WASM**, and get load, warm-up, p50, p95, min and max over
30 real inferences of a real face detector. They repeat the exercise on Firefox via
`pnpm dev:firefox`. Those numbers land in
[spike_report_phase0.md](spike_report_phase0.md), and with them the team decides go/no-go and
closes OQ-16 (which machine is the reference) and OQ-13 (which GPU, therefore which server model).

**No agent, no perception of real pages, no privacy layer, no server, no protocol.** This phase
creates no product capability whatsoever. It does not read a page, does not take a screenshot, does
not detect anything, and does not send a byte anywhere. The side panel it ships is a throwaway
measurement instrument that Phase 2 replaces. The one thing it produces that survives is the
repository skeleton, the build that targets both browsers, the verified-model pipeline, and a
number.

---

## 2. What exists today, verified in source

Verified by reading the files and running the commands, on 2026-09-17.

| Path | State | Notes |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml` | `[built]` | pnpm workspace over `packages/*` and `apps/*`; root scripts for dev/build/test/lint/typecheck/gen. `allowBuilds` approves `esbuild` and `protobufjs` postinstalls |
| `pyproject.toml` | `[built]` | uv workspace root naming `server/gateway` and `eval` as members; ruff config. **Valid TOML (checked with `tomllib`) but never exercised by `uv` — the CLI is not installed in the dev environment** |
| `tsconfig.base.json`, `tsconfig.json` | `[built]` | Strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. The extension does *not* extend this — see §4.3 |
| `LICENSE`, `NOTICE` | `[built]` | MIT for original code; NOTICE carries the YuNet MIT attribution and a table of models still to arrive |
| `.gitignore` | `[built]` | Excludes `node_modules/`, `.venv/`, `.output/`, `.wxt/`, `*.onnx`, `eval/reports/`, `server/recordings/`. **Also excludes `docs` — added outside this session; see §9.3** |
| `apps/extension/wxt.config.ts` | `[built]` | `manifestVersion: 3` forced for both browsers; Chrome gets COEP/COOP, Firefox gets the gecko id; CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'` |
| `apps/extension/entrypoints/background.ts` | `[built]` | ~14 LOC. `sidePanel.setPanelBehavior` on Chrome; `action.onClicked → sidebarAction.toggle()` on Firefox via a narrow cast. Nothing else |
| `apps/extension/entrypoints/sidepanel/{index.html,main.tsx}` | `[built-spike]` | Preact measurement panel. **Deleted in Phase 2** when the real panel (F-H01…F-H08) replaces it |
| `apps/extension/src/perception/worker.ts` | `[built-spike]` | Dedicated worker: ORT import, `probeWebGPU()`, `probeWasm()`, `bench()`. **Superseded in Phase 4** by the real worker message interface (design.md §11.1); the probe logic is kept |
| `apps/extension/src/shared/spike.ts` | `[built-spike]` | Spike message protocol. Deleted with the panel in Phase 2 |
| `apps/extension/scripts/fetch-models.ts` | `[built]` | Downloads models named in the manifest, verifies sha256 **and** byte length, refuses to write on mismatch. Handles GitHub's LFS media endpoint. **Survives — this is F-C03's mechanism** |
| `apps/extension/scripts/check-no-network.ts` | `[built]` | Scans `src/` and `entrypoints/` for `fetch(`/`new XMLHttpRequest`/`new WebSocket` outside `src/host/egress/`. Exits 1 with the offending paths. **Survives** |
| `apps/extension/public/models/models.manifest.json` | `[built]` | One entry: `face-yunet-2023mar`, sha256, 232589 bytes, MIT, source URL, `resident: true` |
| `apps/extension/public/models/face_detection_yunet_2023mar.onnx` | `[built]` | 232,589 bytes, sha256 `8f2383e4…52fa4`, verified. Gitignored — reproduced by `fetch-models.ts` |
| `apps/extension/test/unit/percentile.test.ts` | `[built]` | 5 assertions over the percentile/bounds helpers |
| `apps/extension/vitest.config.ts` | `[built]` | `passWithNoTests: true` so a clean checkout with no suites yet is not a false CI failure |
| `packages/{protocol,recognizers,policy}` | `[scaffold]` | `package.json`, `tsconfig.json`, an `export {}` index, a README naming the owning phase. No behaviour |
| `server/gateway` | `[scaffold]` | FastAPI `create_app()` with `/healthz`; one passing pytest; module folders with `__init__.py` stubs |
| `server/deploy`, `eval/`, `tools/` | `[scaffold]` | READMEs only, plus `aegis-eval` CLI stub that correctly exits non-zero |
| `.github/workflows/` | *(empty)* | Reserved. CI is Phase 1's T-1.10, deliberately not built here |

**Verification actually run, with results:**

| Command | Result |
|---|---|
| `pnpm install` | 169 packages, clean |
| `pnpm -r typecheck` | 4/4 packages clean under strict mode |
| `pnpm --filter @aegis/extension build` | `chrome-mv3`, 28.97 MB total (28.31 MB of it the ORT WASM binary) |
| `pnpm --filter @aegis/extension build:firefox` | `firefox-mv3`, same size |
| `pnpm --filter @aegis/extension test` | 1 file, 5 tests passed |
| `pnpm lint` | no-network scan passes over 4 files; **and was verified to fail correctly** on an injected `fetch()` before it was reverted |
| `server/gateway` `pytest -q` | 1 passed |

---

## 3. The repository skeleton

### 3.1 Why the extension is organised by runtime context

Architecture §15.2 puts `content/`, `host/` and `perception/` at the top of `apps/extension/src/`
rather than grouping by feature. The reason is not taste: these are three JavaScript contexts that
**cannot share memory**, and the folder a file lives in is what determines what it may touch
(architecture §5.3).

| Folder | Context | Raw pixels | DOM text | Vault values | Network |
|---|---|---|---|---|---|
| `src/content/` | Page frames, isolated world | No | Yes (own frame) | One value, at the moment of a confirmed `type` | No |
| `src/host/` | Side panel / sidebar page | Only as an undecoded data URL, for milliseconds | Receives candidate spans | **Yes — the vault lives here** | Only via `host/egress/` |
| `src/perception/` | Dedicated Web Worker | **Yes — the only place** | Receives text spans for NER | No | No |

This makes privacy review tractable. "Can raw pixels leak?" becomes "does anything under
`perception/` serialize?" rather than a whole-codebase question. Phase 0 creates the folders and
the enforcement mechanism; Phases 2–4 fill them.

### 3.2 The dependency rules

From architecture §15.3. Phase 0 creates `check-no-network.ts` (the hardest of these to express as
an import rule, since it is about a global, not a module). The rest become ESLint boundary rules in
Phase 1's T-1.8.

```
packages/recognizers, packages/policy   → no imports from apps/ or browser APIs
packages/protocol                        → no runtime deps beyond the validator
src/content                              → may import packages/*, src/shared; NOT host/ or perception/
src/perception                           → may import packages/*, src/shared; NOT host/ or content/
src/host                                 → may import packages/*, src/shared; talks to others by messages only
src/host/egress                          → the only place fetch() is allowed
src/host/privacy/vault                   → exports no serialize/toJSON; imported only by privacy/ and actions/
server/*                                 → imports generated protocol models; never imports eval/
eval/*                                   → may import server protocol models; never imported by product code
```

### 3.3 The two package managers, and why both

`pnpm` for TypeScript, `uv` for Python, one repository. The extension, the protocol and the pure
logic packages are TypeScript; the gateway, the evaluation harness and every model tool are Python
because that is where vLLM, Playwright's Python bindings and the scoring code live. Architecture
§14 rejects a heavier build orchestrator: two ecosystems, two lockfiles, no Nx/Bazel/Turborepo.

The one place they meet is the protocol (Phase 1): one JSON Schema generates both the TypeScript
types and the Pydantic models, and CI fails if the generated output drifts.

---

## 4. The extension shell

### 4.1 Manifest V3 on both browsers, and what differs

Architecture §10.3 requires MV3 on both. WXT defaults Firefox to MV2, so `manifestVersion: 3` is
set explicitly in `wxt.config.ts`. The generated manifests were inspected to confirm the mapping
came out as architecture §5.1 and design.md §14 describe:

| Key | Chrome (`chrome-mv3`) | Firefox (`firefox-mv3`) |
|---|---|---|
| Panel host | `side_panel: { default_path: "sidepanel.html" }` | `sidebar_action: { default_panel: "sidepanel.html", default_title: "AEGIS" }` |
| Panel permission | `sidePanel` (added by WXT automatically) | — (none needed) |
| Background | `background.service_worker` | `background.scripts[]` (event page) |
| Cross-origin isolation | `cross_origin_embedder_policy: require-corp` + `cross_origin_opener_policy: same-origin` | **Absent by design** |
| Signing id | — | `browser_specific_settings.gecko.id` |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'` | same |
| Permissions | `scripting`, `tabs`, `storage` | same |
| Host access | `optional_host_permissions: ["<all_urls>"]` | same |

WXT's `sidepanel` entrypoint does this mapping itself — confirmed by reading
`wxt/dist/core/utils/manifest.mjs`, which branches on `browser === "firefox"` to emit
`sidebar_action` and otherwise emits `side_panel` plus the permission. No manual wiring is needed,
and none should be added.

**Why COEP/COOP only on Chrome.** Cross-origin isolation is what makes `SharedArrayBuffer`
available, which is what lets ORT's WASM backend use threads. Firefox grants `SharedArrayBuffer` to
*privileged* extensions only (Bugzilla 1673477), so the Firefox build must plan for a
single-threaded WASM path and is not given manifest keys that would imply otherwise. This is the
first concrete consequence of NFR-11 (portability) and it is a permanent asymmetry, not a gap to be
closed later.

**Why `optional_host_permissions` and not `host_permissions`.** A click inside the side panel does
**not** grant `activeTab` (architecture §5.1, verified platform fact). Capture and content-script
injection therefore need host permissions, and requesting them at install time for `<all_urls>`
would be exactly the over-broad install-time access the design refuses. They are requested per site
at task start instead — Phase 2's T-2.4.

### 4.2 The background script is deliberately trivial

Architecture §5.6: the background opens the panel and relays permission events. That is the whole
job. It runs no inference, holds no pixels, holds no vault. The reason is stated in §5.1 — Chrome
MV3 terminates the service worker after roughly 30 s idle and forbids dynamic `import()` there, and
Firefox's event page has its own idle timer. Anything stateful placed there would be reloaded
repeatedly, which directly damages metric 4 and metric 5.

Keeping it at ~14 lines means its termination is never a bug.

### 4.3 The extension extends WXT's generated tsconfig, not the repo base

Found during the build, and worth recording because it is counter-intuitive. `tsconfig.base.json`
sets `types: ["vite/client"]`, which fails under pnpm's strict `node_modules` layout — `vite` is a
transitive dependency of WXT and is not resolvable from the extension package, so `tsc` errors with
`TS2688: Cannot find type definition file for 'vite/client'`.

WXT generates `.wxt/tsconfig.json` precisely to be extended: it carries the correct `paths` aliases,
`lib`, and a reference to `.wxt/wxt.d.ts` which pulls in the environment types properly. The
extension's `tsconfig.json` therefore extends *that*, and adds only `jsx`/`jsxImportSource` for
Preact and `types: ["@webgpu/types"]`.

`@webgpu/types` is a real dependency, not optional: `GPU`, `GPUAdapter` and `GPUAdapterInfo` are
not in TypeScript's built-in DOM lib at the version in use, and `probeWebGPU()` cannot be written
type-safely without them.

---

## 5. The perception worker and backend selection

### 5.1 Why a dedicated worker spawned from the panel

Architecture §5.2 evaluated four host options and selected D: the side panel (Chrome) / sidebar
(Firefox) page, with a dedicated inference Web Worker. The decisive arguments:

- One host that exists on both browsers, with **full extension API access** — so capture,
  inference, vault and egress all sit in one context and pixels never cross extension messaging.
  (The rejected offscreen-document option cannot call `tabs.captureVisibleTab` itself, which would
  force screenshots through the service worker as a JSON-serialized data URL — breaking the
  single-owner pixel rule the draft claimed.)
- Its lifetime equals "the user has the agent open", which is exactly when work is needed.
- It *is* the UI the demo needs: the panel that shows the outbound payload live [SS].

The cost — closing the panel stops the task — is acceptable and arguably correct.

**The Phase-0 spike exists to verify the one assumption this rests on:** that WebGPU and ONNX
Runtime Web actually work *inside a dedicated worker spawned from that page*, on both browsers.
Architecture §5.2 flags it explicitly as a Day-1 verification item, with a declared fallback: if
WebGPU is unavailable in the worker on either browser, run ORT on the panel's main thread for that
browser (the panel UI is light) and keep the worker for pre/post-processing. That fallback is
T-0.12 and is **not yet built** — it is written only when the measurement says it is needed.

### 5.2 Backend probing

`probeWebGPU()` follows design.md §11.2:

1. `navigator.gpu` present? If not → `no_navigator_gpu`.
2. `requestAdapter()` under a **1.5 s timeout** → `timeout` or `no_adapter`.
3. `requestDevice()` under the same timeout → `no_device`.
4. Report `adapter.info` (vendor, architecture, device, description), then `device.destroy()`.

Design.md §11.2 also calls for a tiny warm-up inference before declaring WebGPU usable, and for
caching the result in `storage.local` keyed by browser version and adapter info. In Phase 0 the
warm-up is performed by the bench itself (`bench()` runs one un-timed inference before the timed
loop) and **the caching is not implemented** — a spike wants a fresh probe every run. Caching is
Phase 4's T-4.1.

`probeWasm()` reports SIMD as available (ORT builds it in) and computes the thread count:

```ts
const threads = crossOriginIsolated
  ? Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)))
  : 1;
```

The `min(4, cores/2)` cap comes from architecture §6.4 — the agent shares a machine with the
browser it is driving, and saturating every core would show up directly in metric 4. The
`crossOriginIsolated` branch is what makes the Chrome/Firefox asymmetry of §4.1 concrete: on
Firefox this evaluates to 1, always.

### 5.3 The benchmark

30 timed runs after one warm-up, reporting load, warm-up, p50, p95, min and max. Input is a
random-filled `Float32Array` at the model's declared input shape, with a fallback to `[1,3,320,320]`
when the shape is symbolic or unknown.

Two deliberate honesty constraints:

- **The model is real.** `face_detection_yunet_2023mar.onnx` is the actual YuNet architecture §6.3
  selects, MIT-licensed, 227 KB, fetched from the OpenCV Zoo and sha256-verified. A synthetic
  stand-in would have made the number meaningless.
- **The input is not.** Random tensor data exercises the same compute as a real frame, and this
  spike is measuring *runtime viability*, not detection accuracy. Accuracy is Phase 4's and Phase
  5's problem. The report must say this, so nobody later mistakes a spike latency for a detection
  result.

### 5.4 ONNX Runtime WASM binaries are bundled, never fetched

FR-13 forbids runtime model or asset downloads. The first implementation set
`ort.env.wasm.wasmPaths = new URL('/ort/', import.meta.url).href` and planned a `public/ort/`
folder populated by a copy script. **That was removed after reading the build output:** Vite
already emits `assets/ort-wasm-simd-threaded.jsep-*.wasm` (28.31 MB) as a build asset resolved from
the importing module's URL, i.e. already extension-local. Pointing `wasmPaths` at an empty `/ort/`
folder would have *broken* loading, not hardened it. The override is gone and a comment records
why.

This is the single largest contributor to package size, and it is a known input to metric 4's
"bundled model size" figure. Whether the non-threaded, non-JSEP ORT build is small enough to prefer
on the Firefox target is a Phase 4 question, not a Phase 0 one.

---

## 6. The model registry and `fetch-models.ts`

Design.md §11.3 specifies a manifest listing id, file, sha256, bytes, input shape, dtype, preferred
backend, resident/evictable and licence, with sha256 verified **before a session is created**.
Phase 0 builds the manifest and the fetch-side verification; the load-side verification lands in
Phase 4 (T-4.2) when the worker actually creates sessions from the manifest.

```jsonc
// apps/extension/public/models/models.manifest.json
{
  "schema": "aegis-models/1",
  "models": [{
    "id": "face-yunet-2023mar",
    "role": "face",
    "file": "face_detection_yunet_2023mar.onnx",
    "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    "bytes": 232589,
    "source": "https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "license": "MIT (Shiqi Yu)",
    "inputShape": [1, 3, 160, 120],
    "dtype": "float32",
    "preferredBackend": "auto",
    "resident": true
  }]
}
```

`fetch-models.ts` refuses to write on either a sha256 mismatch **or** a byte-length mismatch, and
re-verifies an already-present file rather than trusting its existence. This is the supply-chain
mitigation architecture §10.2 names ("tampered model files → models bundled in the package, SHA-256
manifest verified at load; no runtime model download").

**One real finding worth carrying forward:** OpenCV Zoo tracks model files in Git LFS.
`raw.githubusercontent.com` serves a 131-byte **pointer file**, not the model —
`version https://git-lfs.github.com/spec/v1 / oid sha256:… / size 232589`. Fetching the real bytes
requires `media.githubusercontent.com/media/<owner>/<repo>/<ref>/<path>`. `fetch-models.ts` derives
that URL from the human-readable `blob` URL in the manifest, so the manifest stays readable and the
script handles the transport detail. Any future LFS-hosted model gets this for free; a non-GitHub
source will need a new branch in `toMediaUrl()`.

The `.onnx` file itself is **gitignored**. The manifest is committed. This keeps the repository
small and makes the verified-fetch path the only way models arrive — including in CI.

---

## 7. The no-network invariant, enforced at build time

AGENTS.md invariant 2 and architecture §7.8 make one module the sole egress point. Asserting that in
prose is worthless; `scripts/check-no-network.ts` asserts it mechanically:

- Walks every `.ts`/`.tsx` under `src/` and `entrypoints/`.
- Skips anything under `src/host/egress/`.
- Fails on `fetch(`, `new XMLHttpRequest`, `new WebSocket`, printing every offending path.

**It was verified to actually fail**, not merely to pass: a `fetch('https://evil.example')` was
appended to `src/shared/spike.ts`, the scan correctly reported that file and exited 1, and the line
was reverted. A guard that has never been seen to fire is not a guard.

Scope note: `scripts/` is deliberately outside the scan, because `fetch-models.ts` legitimately
calls `fetch` — it is a build-time tool that never ships in the extension. When `src/host/egress/`
comes into existence in Phase 2, the script gains its positive half: *egress must exist and must be
the one caller*.

---

## 8. The spike protocol

This is the part of the phase that is **not yet done**. Everything above is code that exists; what
follows is a measurement procedure that has to run on real hardware.

### 8.1 Why it cannot run in the development sandbox

The environment this scaffold was built in has **no Chrome or Chromium binary** and **no GPU**. A
WASM number produced there would describe a headless container, not the mid-range integrated-GPU
laptop metric 4 has to be reported on — and a WebGPU number could not be produced at all. Both
would be worse than no number, because a recorded number gets trusted.

This follows design.md §1 and [SS]'s rule directly: every figure is a target until the harness
produces it, and every reported number states its hardware. A spike result with the wrong hardware
attached is a false measurement, not a provisional one.

### 8.2 The procedure

Run on the candidate reference laptop (OQ-16 — "the weakest credible machine the team has,
integrated GPU"), on mains power, with no other heavy application running.

**Chrome:**
1. `pnpm install`
2. `pnpm dev:chrome` (or `pnpm --filter @aegis/extension build` then load `.output/chrome-mv3`
   unpacked via `chrome://extensions` → Developer mode → Load unpacked)
3. Click the AEGIS toolbar icon. The side panel opens.
4. Record the **Environment** block and the **Backend availability** block verbatim.
5. Press **Bench WebGPU**, wait for the row. Press **Bench WASM**, wait for the row.
6. Repeat the whole run three times from a fresh browser start; report the median run, and note
   spread.

**Firefox:**
1. `pnpm dev:firefox` (or build and load `.output/firefox-mv3` via `about:debugging` → This Firefox
   → Load Temporary Add-on → pick `manifest.json`)
2. Open the sidebar. Same recording procedure.
3. On Linux, additionally record whether `dom.webgpu.enabled` is set, and run once with it on and
   once off — architecture §5.1 states Firefox on Linux still needs the preference as of 152–155,
   and NFR-11 depends on the WASM path being genuinely usable there.

### 8.3 What each row of design.md §14 needs checking against

T-0.13. Every claim in the platform-abstraction table is a verified fact in the requirement docs,
but "verified against documentation" is not "verified on the team's machines":

| Capability | What to confirm |
|---|---|
| Panel host | Chrome side panel opens from toolbar click; Firefox sidebar toggles |
| WebGPU in a worker | Adapter obtained *inside the worker*, not just on the main thread |
| Cross-origin isolation | `crossOriginIsolated === true` on Chrome, `false` on Firefox |
| `SharedArrayBuffer` | Present on Chrome, absent on Firefox (confirms the single-thread plan) |
| `OffscreenCanvas` | Present in the worker on both — Phase 4's compositor needs it |
| Closed shadow roots | `chrome.dom.openOrClosedShadowRoot` / `Element.openOrClosedShadowRoot` reachable from a content script (Phase 2 exercises this properly; a smoke check here is enough) |
| `captureVisibleTab` | Rate limit behaviour on Chrome (≤2/s) — Phase 4 depends on it |

### 8.4 The decision the numbers feed

| Observation | Consequence |
|---|---|
| WebGPU available in the worker on both browsers, p95 well inside the per-frame deadline | Proceed as designed. WebGPU is the accelerator, WASM the fallback |
| WebGPU unavailable *in the worker* but available on the panel main thread | Build T-0.12: ORT on the panel main thread for that browser, worker keeps pre/post-processing (architecture §5.2's declared fallback) |
| WebGPU unavailable entirely on the reference laptop | Not fatal — NFR-11 already requires the WASM path to be first-class. But the crop budget (design.md §11.4: 16 WebGPU / 8 WASM) and the 120 ms frame deadline must be re-derived from the measured WASM numbers before Phase 4 |
| WASM p95 far above the 120 ms per-frame deadline even for the 227 KB face detector | **Go/no-go trigger.** The model stack (§6.3), the coverage-escalation thresholds (§6.2) or the reference machine choice all have to change. Escalate before Phase 1 |

The 120 ms per-frame perception deadline (architecture §6.4, design.md §10.2) is itself an initial
tunable. This spike is the first evidence about whether it is achievable.

---

## 9. Decisions this phase must close

### 9.1 OQ-16 — the reference laptop

Metric 4 is 20% of the score and is meaningless without a stated machine. Architecture §17's
proposed default is "the weakest credible machine the team has, integrated GPU". It must be named
concretely — make, model, CPU, RAM, GPU, OS, browser versions — and recorded in
[../DECISIONS.md](../DECISIONS.md), because every subsequent resource and latency figure is
reported against it.

### 9.2 OQ-13 — the GPU, therefore the server model

Architecture §8.3's default is Qwen3-VL-8B-Instruct on a 24 GB GPU; the fallbacks are
Qwen3-VL-4B-Instruct for smaller GPUs and llama.cpp/Ollama for no GPU at all. Phase 2 cannot
finish its model client without this answer. It does not block Phase 1.

### 9.3 OQ-12 — the re-baselined timeline

The source documents are dated 17 September 2026 with a 20 September portal deadline, and
architecture §1.3 C-9 flags that the strategy's roadmap must be re-baselined. The team must state
the real submission date this plan is working towards, because it determines where the Tier-1 cut
line falls (architecture §16's cut order: OCR on low-priority regions → NER profile L → deltas →
Firefox parity).

**Also outstanding, outside the OQ list:** `.gitignore` currently contains a bare `docs` entry,
which excludes the entire documentation set — including this file, FEATURES.md, PLAN.md, TASKS.md
and the requirement-document mirrors — from version control. If that is intentional (to avoid
committing the large mirrored requirement docs), it should be narrowed to those three files
specifically. If it is not, it should be removed. Either way it is a decision, not a default.

---

## 10. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria | State |
|---|---|---|---|
| 0.1 | pnpm workspace root | `pnpm install` resolves all workspace projects; `pnpm -r typecheck` runs in every package | **done** |
| 0.2 | uv workspace root | `pyproject.toml` parses with `tomllib`; names `server/gateway` and `eval` as members | **done** (not exercised by `uv` — CLI absent) |
| 0.3 | Folder skeleton per architecture §15.1 | Every directory from §15.1 exists; every otherwise-empty one carries a README naming its owning phase | **done** |
| 0.4 | `LICENSE` and `NOTICE` | NOTICE lists every bundled model with licence and source; YuNet's MIT attribution present | **done** |
| 0.5 | Root `README.md` | States what it is, the verified run commands, and honest limitations | **done** |
| 0.6 | WXT extension, side-panel entrypoint, Chrome build | `pnpm --filter @aegis/extension build` succeeds; generated `manifest.json` has `manifest_version: 3`, `side_panel.default_path`, COEP/COOP | **done** |
| 0.7 | Dedicated worker running ORT, spawned from the panel | Worker module built as a separate chunk; posts an `env` message on load; panel renders it | **done** |
| 0.8 | Probe WebGPU in the worker on **Chrome**, record adapter info | `spike_report_phase0.md` §Chrome carries availability, reason-if-not, adapter vendor/architecture, probe ms | **blocked — needs real Chrome + GPU** |
| 0.9 | Probe WebGPU in the worker on **Firefox**, record result | Same, plus the Linux `dom.webgpu.enabled` state | **blocked** |
| 0.10 | Bench YuNet on WebGPU, p50/p95 over ≥30 runs | Report carries load/warmup/p50/p95/min/max, n, machine, browser version, backend | **blocked** |
| 0.11 | Bench YuNet on WASM SIMD, with and without threads | Same, with `threads` and `crossOriginIsolated` recorded for each variant | **blocked** |
| 0.12 | Main-thread ORT fallback, **only if 0.8/0.9 show WebGPU unavailable in a worker** | If built: the panel runs the same bench on its main thread and the report compares both hosts. If not needed: the report states so and the task is closed as not-required | **not started — gated on 0.8/0.9** |
| 0.13 | Verify every row of design.md §14 on real browsers | Report carries a row-by-row table with observed values, not documentation claims | **blocked** |
| 0.14 | Record the reference laptop (OQ-16) | DECISIONS.md names make/model/CPU/RAM/GPU/OS/browser versions; status `decided` | **blocked on 0.8–0.11** |
| 0.15 | Record the go/no-go verdict and all spike numbers | `spike_report_phase0.md` exists with real numbers; HISTORY.md entry links it; §8.4's consequence is stated explicitly | **blocked** |
| 0.16 | Confirm GPU availability, therefore server model (OQ-13) | DECISIONS.md names the GPU and the model; status `decided` | **open** |
| 0.17 | Re-baseline the timeline (OQ-12) | DECISIONS.md states the real submission date and where the Tier-1 cut line falls | **open** |
| 0.18 | Model registry + verified fetch | `fetch-models.ts` writes only on sha256 **and** byte match; deleting the `.onnx` and re-running restores it byte-identical | **done** |
| 0.19 | No-network build check | Passes on real code; **and demonstrably fails** on an injected `fetch()` outside `host/egress/` | **done** |
| 0.20 | Resolve the `.gitignore` `docs` entry (§9.3) | Either narrowed to the three mirrored requirement docs, or removed; decision recorded in HISTORY.md | **open** |

---

## 11. Milestone Definition

Phase 0 is **complete** when:

> A developer sits down at the machine the team has agreed is the reference laptop — a five-year-old
> ThinkPad with integrated graphics, say — runs `pnpm install && pnpm dev:chrome`, and clicks the
> AEGIS icon. A side panel slides in reading **AEGIS — Phase 0 spike**. Under *Environment* it says
> `hardwareConcurrency: 8`, `crossOriginIsolated: true`, `SharedArrayBuffer: true`,
> `OffscreenCanvas: true`. Under *Backend availability* it says `webgpu: available — Intel
> Mesa Intel UHD Graphics (620 ms)` and `wasm: available — threads=4, coi=true`. They press
> **Bench WebGPU** and a row fills in: load 214 ms, warmup 61 ms, p50 8.9 ms, p95 12.4 ms over 30
> runs of a real 227 KB YuNet detector. They press **Bench WASM** and get p50 31 ms, p95 44 ms.
> Both are inside the 120 ms per-frame deadline with room to spare, on the weakest machine the team
> owns — so the architecture's central bet holds, and the WASM fallback is not a cliff.
> They restart, repeat twice more, and the spread is unremarkable. They switch to Firefox, load the
> temporary add-on, open the sidebar, and see `webgpu: unavailable — no_navigator_gpu` on Linux
> with `dom.webgpu.enabled` off, `wasm: available — threads=1, coi=false`, and a WASM p95 of
> 79 ms — slower, single-threaded, exactly as architecture §5.1 predicted, and still usable.
> They paste all of it into `spike_report_phase0.md` with the machine and browser versions written
> at the top, name that ThinkPad as the reference laptop in DECISIONS.md, and write **GO** in
> HISTORY.md with the numbers beside it. No page has been read, no pixel captured, no byte sent.
> The question that could have invalidated the architecture has an answer, and it is written down.

---

## 12. Files to Create

```
aegis_main/
├── package.json                                 # [done] pnpm workspace root
├── pnpm-workspace.yaml                          # [done] packages/*, apps/*, allowBuilds
├── pyproject.toml                               # [done] uv workspace root
├── tsconfig.base.json / tsconfig.json           # [done]
├── LICENSE / NOTICE                             # [done]
├── .gitignore                                   # [done, but see §9.3]
├── apps/extension/
│   ├── wxt.config.ts                            # [done] MV3 both browsers, CSP, COI, gecko id
│   ├── tsconfig.json                            # [done] extends .wxt/tsconfig.json
│   ├── vitest.config.ts                         # [done] passWithNoTests
│   ├── entrypoints/
│   │   ├── background.ts                        # [done] opens the panel; nothing else
│   │   └── sidepanel/{index.html,main.tsx}      # [built-spike] deleted in Phase 2
│   ├── src/
│   │   ├── perception/worker.ts                 # [built-spike] probe + bench; superseded Phase 4
│   │   └── shared/spike.ts                      # [built-spike] deleted in Phase 2
│   ├── scripts/
│   │   ├── fetch-models.ts                      # [done] SURVIVES — F-C03's mechanism
│   │   └── check-no-network.ts                  # [done] SURVIVES — gains its positive half Phase 2
│   ├── public/models/
│   │   ├── models.manifest.json                 # [done] committed
│   │   └── face_detection_yunet_2023mar.onnx    # [done] gitignored, fetched + verified
│   └── test/unit/percentile.test.ts             # [done]
├── packages/{protocol,recognizers,policy}/      # [scaffold] pkg.json, tsconfig, index, README
├── server/gateway/                              # [scaffold] create_app() + /healthz + 1 test
├── server/deploy/ , eval/ , tools/              # [scaffold] READMEs, aegis-eval CLI stub
└── docs/planning/
    ├── phase_0_spike_foundations.md             # [this file]
    └── spike_report_phase0.md                   # [new] written when §8 actually runs
```

---

## 13. Performance Validation

Phase 0 does not optimise anything — it establishes the baseline everything else is measured
against. These are the figures the spike must produce, not targets to hit.

| Metric | How to Measure | Target / Note |
|---|---|---|
| Face detector p50/p95, WebGPU | Panel **Bench WebGPU**, 30 runs, median of 3 browser restarts | Inside the 120 ms per-frame deadline (architecture §6.4). This is the number the deadline was guessed against |
| Face detector p50/p95, WASM | Panel **Bench WASM**, with and without threads | Report both. On Firefox, threads=1 always |
| Model session load time | `loadMs` in the bench row | Informs the lazy-load/eviction policy (§6.4). Resident models pay this once |
| Warm-up cost | `warmupMs` | Design.md §19 requires a warm-up inference per resident model at load so the first real step is not penalised. This is its price |
| Built package size, Chrome | `du -sh .output/chrome-mv3` | **Currently 28.97 MB**, 28.31 MB of which is the ORT WASM binary. Directly feeds metric 4's "bundled model size". Reducing it is a Phase 4 question |
| Built package size, Firefox | `du -sh .output/firefox-mv3` | Same. Whether a non-threaded ORT build is smaller for this target is Phase 4's call |
| Typecheck + build wall clock | `time pnpm -r typecheck && time pnpm build` | Developer-experience only; record so later phases notice regressions |

---

## 14. Estimated Complexity

| Component | LOC | Files | State |
|---|---|---|---|
| Workspace roots, tsconfigs, gitignore, LICENSE/NOTICE | ~180 | 8 | done |
| `wxt.config.ts` + `background.ts` | ~55 | 2 | done |
| Spike panel (`main.tsx` + html) | ~150 | 2 | done, throwaway |
| `worker.ts` (probe + bench) | ~165 | 1 | done, probe survives |
| `shared/spike.ts` | ~55 | 1 | done, throwaway |
| `fetch-models.ts` | ~80 | 1 | done, survives |
| `check-no-network.ts` | ~55 | 1 | done, survives |
| Package/gateway/eval scaffolds + READMEs | ~220 | 25 | done |
| `percentile.test.ts` | ~45 | 1 | done |
| **T-0.12 main-thread fallback (if required)** | ~60 | 1 | **not started, gated** |
| **Spike report** | ~120 | 1 | **not started, blocked** |
| **Total** | **~1,185** | **44** | |

New runtime dependencies introduced: **3** — `onnxruntime-web`, `preact`, `@webgpu/types` (types
only). Build-time: `wxt`, `vite`, `vitest`, `tsx`, `typescript`.

---

## 15. Forward Dependencies Declared Here

- **`probeWebGPU()` / `probeWasm()` have no caching.** Design.md §11.2 requires the result cached in
  `storage.local` keyed by browser version and GPU adapter info, re-probed on version change.
  **[Phase 4, T-4.1 builds the cache. The probe logic itself carries over unchanged.]**
- **`models.manifest.json` is fetched-and-verified but never verified at load.** Design.md §11.3
  requires the worker to check sha256 *before creating a session*. **[Phase 4, T-4.2.]**
- **The spike panel occupies the `sidepanel` entrypoint the real UI needs.**
  **[Phase 2 deletes `entrypoints/sidepanel/main.tsx` and `src/shared/spike.ts` and builds the real
  panel (F-H01, F-H02, F-H07, F-H08) in their place. The worker's probe/bench functions move into
  `src/perception/runtime/`.]**
- **`check-no-network.ts` currently enforces only the negative half** — no network calls outside
  `host/egress/`. **[Phase 2 adds the positive half once `src/host/egress/` exists: egress must
  exist, and must be the only caller. Phase 3 adds the `GuardedPayload` brand check that makes the
  choke point structural rather than conventional.]**
- **The Chrome build opts into cross-origin isolation; nothing yet depends on it.**
  **[Phase 4's resource governor reads `crossOriginIsolated` to choose the WASM thread count
  (design.md §11.2). The Firefox path is single-threaded permanently.]**
- **`optional_host_permissions: ["<all_urls>"]` is declared and never requested.**
  **[Phase 2, T-2.4 requests it per site at task start, because a side-panel click does not grant
  `activeTab` (architecture §5.1).]**
- **The 120 ms per-frame perception deadline and the 16/8 crop budgets are unvalidated guesses.**
  **[Phase 0's measurement is the first evidence; Phase 4 sets them from it; Phase 5's harness
  reports whether they held.]**
- **`eval/` and `server/` are scaffolds with no contract between them.**
  **[Phase 1 creates `packages/protocol/schema/*.json` as the single source of truth and generates
  both the TypeScript types and the Pydantic models from it, with a CI drift check.]**

---

## 16. Implementation Notes — deviations found and decided during the build

Recorded here rather than left to drift silently between this document and the code.

1. **`tsconfig.base.json` cannot be the extension's base.** `types: ["vite/client"]` is
   unresolvable from `apps/extension` under pnpm's strict layout (`vite` is WXT's transitive
   dependency, not the extension's). Extended WXT's generated `.wxt/tsconfig.json` instead, which
   is designed for exactly this and carries the correct `paths`, `lib` and `wxt.d.ts` reference.
   The repo base config still governs `packages/*`. **`@webgpu/types` was added as a real
   devDependency** — `GPU`/`GPUAdapter`/`GPUAdapterInfo` are absent from the built-in DOM lib at
   this TypeScript version, and the WebGPU probe cannot be written type-safely without them.

2. **The manual `ort.env.wasm.wasmPaths = '/ort/'` override was wrong and was removed.** Vite
   already emits ORT's WASM binary as a build asset resolved from the importing module's URL
   (confirmed in the build output: `assets/ort-wasm-simd-threaded.jsep-*.wasm`, 28.31 MB,
   extension-local). Pointing `wasmPaths` at a `public/ort/` folder that was never populated would
   have broken loading at runtime while *appearing* to harden it against CDN fetches. FR-13 is
   satisfied by the default behaviour here; a comment in `worker.ts` records why the line is
   absent, so it is not "helpfully" re-added later.

3. **WXT defaults Firefox to MV2.** Architecture §10.3 requires MV3 on both browsers, so
   `manifestVersion: 3` is set explicitly. Verified by inspecting both generated manifests rather
   than trusting the config — Chrome emitted `side_panel` + the `sidePanel` permission + COEP/COOP;
   Firefox emitted `sidebar_action` + the gecko id and, correctly, no isolation keys.

4. **The `sidePanel` permission was being added manually and did not need to be.** Reading
   `wxt/dist/core/utils/manifest.mjs` showed WXT's sidepanel handling calls `addPermission(manifest,
   "sidePanel")` itself on the Chrome branch and emits `sidebar_action` on the Firefox branch.
   Removed from the manual permission list so WXT owns the mapping; the generated manifests confirm
   it still appears.

5. **OpenCV Zoo serves model files through Git LFS.** `raw.githubusercontent.com` returns a
   131-byte pointer file, not the 232,589-byte model — a naive fetch would have silently written a
   text file with an `.onnx` extension and failed at session-creation time with a confusing error.
   `fetch-models.ts` rewrites `github.com/<o>/<r>/blob/<ref>/<path>` to
   `media.githubusercontent.com/media/<o>/<r>/<ref>/<path>`, and the sha256 **and byte-length**
   checks would have caught the pointer file regardless. The pointer's own `oid` matched the
   downloaded file's hash, which is how the manifest value was confirmed independently.

6. **`vitest run` exits 1 when no test files exist**, which would have made a clean checkout fail
   CI for a reason that is not a defect. Set `passWithNoTests: true` and wrote one real suite
   (`percentile.test.ts`) rather than leaving the runner unexercised — the suite covers the
   bounds-checking helpers the bench depends on, including the `at()` guard that throws instead of
   returning `undefined` under `noUncheckedIndexedAccess`.

7. **pnpm 12 blocks dependency build scripts by default** (`ERR_PNPM_IGNORED_BUILDS`) and writes an
   `allowBuilds` stub into `pnpm-workspace.yaml` for a human to resolve. `esbuild` (Vite/WXT's
   bundler, needs its platform binary) and `protobufjs` were both approved as `true` — both are
   legitimate, widely-used build tooling whose postinstall is required for correct operation.
   Recorded because silently approving install scripts is exactly the kind of supply-chain decision
   that should be visible.

8. **The spike's measurements could not be taken in the environment the scaffold was built in** —
   no Chrome/Chromium binary, no GPU. Rather than benching on whatever was available and labelling
   it, T-0.8…T-0.11 and T-0.13 are marked `[!]` blocked in TASKS.md with the reason attached, and
   `spike_report_phase0.md` is not written until it can contain real numbers. This follows the same
   rule the rest of the project runs on: a number without its hardware is not a measurement.
   §8.2 is the procedure for whoever runs it.
