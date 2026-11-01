# Phase 4 — On-Device Vision: Capture, Face Detection, ViT Screening & Additive Composition

**Document type:** Phase 4 execution document
**Requirements basis:** FR-10, FR-11, FR-12, FR-13, FR-14, FR-22, FR-31; NFR-4, NFR-5, NFR-10, NFR-11; **AC-3, AC-4, AC-7**
**Architecture basis:** `architecture.md` §5.3 (execution contexts), §6 in full (on-device perception), §7.7 (additive composition), §9.3 (L1 flow), §9.6 (failure paths), §16 (build order step 5)
**Design basis:** `design.md` §5.8 (geometry digest), §6.4 (Channel V), §7.5 (compositor), §7.6 step 5 (image re-scan), §11 in full (perception worker)
**Depends on:** Phase 3 in full — fusion consumes Channel V candidates, the guard gains its image step, the compositor draws placeholders the vault minted. Phase 0's spike numbers should be recorded before the budgets in §6 are finalised.
**Status:** Built end to end (T-4.1…T-4.23), 2026-09-18, on explicit user instruction ("next phase
4") continuing directly from Phase 3 — Phase 2's live-model exit gate (OQ-13) is still unconfirmed
in this GPU-less environment, disclosed rather than silently bypassed (same reasoning as Phase 3's
status line). See §16a below for what deviated from this document during implementation and why.

---

## 1. Objective

The problem statement requires a **local vision model that evaluates the current screen state**
[PS], faces obscured in anything sent [PS], and analysis of content that the DOM cannot see — canvas,
images, video, PDF viewers [SS]. Phase 4 delivers all three, and it does so under a constraint that
shapes every decision in it: metric 4 (client resource utilization) is 20% of the score and metric 5
(latency) is another 15%, so every millisecond and every megabyte is scored.

The organising idea is architecture §6.2's **coverage-driven escalation**: vision runs where
structure runs out, not everywhere. A page whose DOM explains 95% of its pixels needs face detection
on its avatars and nothing else. A canvas-rendered application explains almost nothing and needs the
full pipeline. The payload level follows the same gradient — L0 (structured only), L1 (structured +
sanitized viewport image), L2 (sanitized crop).

The second organising idea is architecture §7.7's **additive composition**, and it is the one that
makes the privacy claim survive a crash. The outgoing image is not the screenshot with black boxes
painted on it. It is a **grey canvas onto which only positively-cleared regions are copied**. A
timeout, a worker crash, a model that fails to load, a region that was never analysed — all of them
produce grey, because grey is the default and content is the exception. Subtractive redaction fails
open; additive composition fails closed.

**By the end of this phase:** the agent runs on a page with a profile photo and a canvas-rendered
chart. The panel's payload viewer now shows an *image* beside the bytes: the page, recognisable and
readable, with a solid black box where the face was and grey where the canvas region could not be
analysed in time. The developer disables WebGPU; the same task completes on the WASM path, slower,
with both latencies reported. They pull the network cable; detection and redaction keep running and
the panel still shows the sanitized preview. They kill the perception worker mid-step; no image is
sent at all.

**No OCR.** PP-OCRv5 and the Devanagari recognizer are Phase 6 — they are on architecture §16's cut
list (first to go) and they are the largest single addition to the model budget. Phase 4's vision is
faces, zero-shot ViT region screening, and the masked-glyph detector. Unexplained regions that
cannot be analysed stay grey, which is correct behaviour, not a gap.

---

## 2. What this phase inherits, builds and replaces

| Path | Inherited | Phase 4 action |
|---|---|---|
| `src/perception/worker.ts` | `[built-spike]` Phase-0 probe + bench; `[Phase 3]` NER path | **Rewritten** against design.md §11.1's real message interface. The probe logic is kept and gains caching |
| `src/host/privacy/guard/` | `[Phase 3]` steps 1–4 | **Gains step 5** — image re-scan, recompose, drop-to-L0 |
| `src/host/privacy/fusion/` | `[Phase 3]` merge, arbitrate, decompose, dilate | **Consumed unchanged.** Channel V candidates now actually arrive; steps 3 and 8 start firing |
| `src/host/privacy/context/builder.ts` | `[Phase 3]` L0 only | **Extended** with `ImagePart`, real `coverage`, and the L0/L1/L2 decision |
| `src/host/controller/machine.ts` | `[Phase 2]` `PERCEIVING` is a no-op | **Filled** — capture, digest check, worker round trip |
| `apps/extension/public/models/` | `[Phase 0]` YuNet + manifest | **Gains** the ViT encoder and its precomputed prompt embeddings |
| `apps/extension/scripts/fetch-models.ts` | `[Phase 0]` | **Consumed unchanged** — the new models are manifest entries |
| `tools/models/` | `[scaffold]` README | **Filled** — `export_vit_prompts.py`, `quantize.py` |
| Panel | `[Phase 3]` payload viewer shows bytes | **Gains** the sanitized image, the screen-state label and the backend/model indicators |

---

## 3. The perception worker

### 3.1 The message interface

Design.md §11.1 replaces the Phase-0 spike protocol:

```ts
type ToWorker =
  | { t:'init'; backendPref:'auto'|'webgpu'|'wasm'; models:ModelSpec[]; profile:'S'|'L' }
  | { t:'perceive'; jobId:string; bitmap:ImageBitmap /* transferred */;
      regions:RegionJob[]; deadlineMs:number; fullFrame:boolean }
  | { t:'ner'; jobId:string; chunks:TextChunk[] }
  | { t:'compose'; jobId:string; regions:SensitiveRegionLite[]; cleared:Box[]; scale:number }
  | { t:'rescan'; jobId:string; halos:Box[] }
  | { t:'evict'; model:string } | { t:'stats' };

type FromWorker =
  | { t:'ready'; backend:'webgpu'|'wasm'; loaded:ModelInfo[] }
  | { t:'perceived'; jobId:string; candidates:Candidate[]; screenLabel?:string;
      timings:Record<string,number>; timedOut:Box[] }
  | { t:'nerResult'; jobId:string; spans:NerSpan[] }
  | { t:'composed'; jobId:string; webp:ArrayBuffer /* transferred */; coverage:Coverage }
  | { t:'rescanned'; jobId:string; hits:Candidate[] }
  | { t:'stats'; memoryEstimateMB:number; sessions:ModelInfo[] }
  | { t:'error'; jobId?:string; code:string };
```

`timedOut: Box[]` is the fail-closed channel: regions the deadline killed come back as boxes, and
the compositor leaves them grey. A region that was not analysed is never treated as clear.

### 3.2 The pixel-ownership rule, and the correction it rests on

Architecture §5.3: the worker is the **only** place raw pixels live. The data URL from
`captureVisibleTab` is decoded with `createImageBitmap` in the host and the resulting `ImageBitmap`
is **transferred** (a real structured-clone transfer, same agent cluster) into the worker, which
closes it after use.

Architecture §1.3 C-8(b) corrects the earlier draft here, and the correction is why the host
architecture is what it is: **extension messaging cannot transfer an `ImageBitmap`**. The draft's
offscreen-document design would have had to pass pixels through the service worker as a
JSON-serialized data URL — meaning the pixels would exist as a string in a third context, and the
"transfer neuters the source" guarantee would simply not hold. Because the panel both captures and
owns the worker, the transfer is a real one.

The worker holds **one capture at a time**, and closes the bitmap once `compose`/`rescan` for that
capture have finished.

### 3.3 Backend selection and caching

Design.md §11.2, extending the Phase-0 probe:

1. `navigator.gpu` → `requestAdapter()` with a 1.5 s timeout → `requestDevice()` → **a tiny warm-up
   inference**. All four must succeed for `webgpu`.
2. Otherwise `wasm` with SIMD; threads when `crossOriginIsolated` (Chrome), single-thread otherwise
   (Firefox — architecture §5.1).
3. **Result cached in `storage.local`, keyed by browser version and GPU adapter info; re-probed on
   version change.**

The caching is what Phase 0 deliberately left out (a spike wants a fresh probe every run). It
matters for metric 5: a 1.5 s adapter timeout on every task start would dominate the first step.

FR-11 requires both paths to work **and be measured**. AC-3 makes it an acceptance criterion: with
WebGPU disabled, the same task completes on WASM, and latency is reported for both.

### 3.4 Model registry, verified at load

Design.md §11.3. The manifest gains entries; the worker **verifies sha256 before creating a
session**. Phase 0 built the fetch-side verification; this is the load-side half, and it is the
supply-chain control architecture §10.2 names.

`env.allowRemoteModels = false` and no CDN paths: FR-13 says nothing is downloaded at runtime, and
the Phase-0 finding that Vite already bundles ORT's WASM locally means there is nothing to
"helpfully" re-point at a CDN.

---

## 4. Channel V — what vision actually looks for

### 4.1 Face detection

YuNet-class ONNX, sub-megabyte, already fetched and verified in Phase 0. Design.md §6.4:

- Runs on every `img`/`video`/`canvas`/avatar region, and on the **full frame when coverage < 0.70**.
- Input resized so the long side ≤ 320 px per region.
- Score threshold 0.5, with the CRITICAL band starting lower (fusion §7.1 step 2).
- Boxes expanded **10%** to cover hair and ears — a tight face box leaves identifying features.

**Faces use a solid fill, not blur or pixelation.** Architecture §7.3 is explicit about why: blur
and pixelation are **partially invertible**. The PS lists "blurring faces" as an example [PS]; solid
fill is a strictly stronger version of the same intent, and the architecture takes it as such.

**Face detection is never dropped from the degradation ladder** (architecture §6.4). Everything else
can be shed under load; faces cannot, because FR-22 is unconditional.

### 4.2 Zero-shot ViT screening

This is how the design satisfies "a ViT or equivalent" [PS] **without training or fine-tuning**
(C-6, [SS]). Architecture §1.3 C-5 resolves the conflict: the earlier draft's fine-tuned region
classifier and UI detector are replaced by a small CLIP-family image encoder used zero-shot.

Design.md §6.4:
- Each candidate crop is letterboxed to 224×224 and embedded.
- Cosine similarity against **precomputed text-prompt embeddings**, softmax with temperature.
- Prompt set: identity card, Aadhaar card, PAN card, passport page, credit or debit card,
  handwritten signature, QR code, barcode, photo of a person, document page with text, login form,
  chart, logo, icon, plain background.
- Sensitive top class above threshold (0.35 for ID/card, 0.45 otherwise) → whole-region candidate.

**The text encoder does not ship.** `tools/models/export_vit_prompts.py` computes the prompt
embeddings at build time and bundles the resulting vectors — a direct metric-4 saving, since the
text tower is typically as large as the image tower and is never needed at runtime.

**An ID document or payment card is redacted whole, without attempting to read it** (architecture
§7.2). Trying to OCR an Aadhaar card to find the number and redact just the digits would be slower,
less reliable, and would fail open when the OCR missed. The whole region goes.

### 4.3 Screen-state labelling — and why it runs on every capture

The ViT also embeds a 224×224 thumbnail of the **full viewport on every capture**, producing a
coarse screen-state label shown in the panel and recorded for metric-1 analysis.

Architecture §6.2 is candid about why this exists: coverage-driven escalation means vision might
otherwise run on almost nothing on a well-structured page, and whether that satisfies the PS's
requirement that the local model "evaluates the current screen state" is **an interpretation**.
Running the encoder on every frame at low resolution makes the requirement visibly met for a few
milliseconds per capture, and produces a per-screen signal the harness can score under OQ-4's second
reading of metric 1.

This is an honest hedge against an ambiguity in the rubric, and it should be described as such.

### 4.4 Masked-glyph detector

Runs of `•`, `●`, `*` in OCR output or DOM text inside a field → PASSWORD presence. The DOM half
works in Phase 4; the OCR half activates in Phase 6.

---

## 5. Capture

### 5.1 Cadence

Architecture §6.5: **event-driven, never a fixed frame rate.** Capture on navigation commit, on a
mutation quiet period after a burst, on `scrollend`, on focus change, at a step boundary, or when
the server asks for pixels via `request_observation`.

**On a static page with high coverage the steady-state capture rate is zero.** This is the single
biggest metric-4 lever in the phase — an agent that screenshots at 5 fps while the user reads a page
has already lost the resource metric.

Chrome limits `captureVisibleTab` to 2/s (verified platform fact, architecture §5.1). The capture
service enforces it rather than discovering it.

### 5.2 The redaction-geometry digest — a subtle correctness bug, closed

Design.md §5.8. A screenshot is asynchronous. Between requesting it and receiving it, the page can
scroll, reflow or mutate — and if it does, the redaction boxes computed from the *old* geometry no
longer cover the sensitive content in the *new* pixels. The result would be a black box next to an
exposed Aadhaar number.

The mechanism: hash the rounded boxes of every node and text span currently carrying a redaction
decision, computed **in the same animation frame as the capture request**, and recompute when the
capture resolves. Mismatch → discard the capture. After 3 consecutive mismatches, the step proceeds
as L0 (`CAPTURE_INCONSISTENT`).

This is a fail-closed response to a race that would otherwise be invisible and intermittent —
exactly the kind of bug that shows up once, in front of judges.

---

## 6. Coverage-driven escalation and the resource governor

### 6.1 The escalation table

Architecture §6.2, initial thresholds, to be tuned by the harness:

| `coverage.explained` | Vision work | Payload level |
|---|---|---|
| ≥ 0.92 | Only `<img>`, `<video>`, `<canvas>` and avatar regions (faces, ID documents, cards) | **L0** — structured only, no image |
| 0.70 – 0.92 | Plus OCR on unexplained regions *(Phase 6)* | L0, or **L1** if the server asked |
| < 0.70 | Full-frame | **L1** — structured + sanitized image |
| Server asks for a region | Crop only | **L2** — sanitized crop |

### 6.2 The governor

Architecture §6.4, design.md §11.4:

- **One inference at a time**, strict FIFO with priorities: **faces > ViT screening > OCR > NER**.
- Per-frame deadline **120 ms**; work that misses it is abandoned and its regions stay grey —
  *fail-closed, not fail-slow*.
- Lazy load; evict large sessions (OCR, NER-L) after idle. **Face detector and ViT encoder stay
  resident**, warmed up at load (design.md §19) so the first real step is not penalised.
- Crop budget per frame: 16 (WebGPU) / 8 (WASM).
- Degradation ladder driven by measured frame times, `navigator.deviceMemory` and
  `hardwareConcurrency`: fewer crops → skip OCR on low-priority regions → structured-only mode.
  **Face detection is never dropped.**
- Caches: dHash crop cache (LRU 512), normalized-text cache (LRU 2048), both cleared on task end.
  Logos and avatars are analysed once per session, not once per frame.

Every number here is an initial tunable and should be re-derived from Phase 0's measured numbers
before implementation begins.

---

## 7. The additive compositor

Design.md §7.5 — the most important 20 lines in the phase:

```
compose(bitmap, regions, cleared[], scale):
  canvas ← OffscreenCanvas(W*scale, H*scale); fill #8A8A8A     // grey by DEFAULT
  for r in mergeUp(cleared):  drawImage(bitmap, r → r*scale)   // only cleared regions copied in
  for s in regions:
     for b in s.boxes: fillRect(b*scale, #000)
     if s.placeholder and box large enough: drawText(s.placeholder, white, fitted)
     else if s.entity in {FACE, ID_DOCUMENT, SIGNATURE, QR_CODE}: drawText(s.entity, fitted)
  bitmap.close()
  return encode(canvas, "image/webp", quality 0.8), coverage
```

### 7.1 Positive clearance — the whole point

A region may be copied in only if it has **positive provenance** (design.md §7.5):

1. A structural node whose text was fully analysed and produced no accepted region, with no
   unanalysed image content inside it; **or**
2. A vision-analysed region with no accepted detection; **or**
3. Known page chrome detected structurally (navigation, headers) with no text findings.

Everything else is grey. Not "everything suspicious" — **everything not positively cleared**. That
inversion is what makes FR-31 and AC-7 achievable: if the worker dies mid-step, nothing was cleared,
so nothing is copied, so the image is entirely grey.

### 7.2 `mergeUp`, and the metric-1 tension

Cleared siblings are merged into their common container when *all* descendants are cleared. Without
this the image becomes "swiss cheese" — technically safe, but visually incoherent, which damages
metric 1 (the model cannot read a page made of disconnected fragments).

This is the phase's central trade-off, and it is explicit: safety sets the floor (nothing
uncleared is ever drawn), and `mergeUp` recovers as much legibility as it can *above* that floor.

### 7.3 Labels in the image

A redaction box carries its placeholder drawn inside it when the box is big enough
(`⟪AADHAAR#2⟫`), or its entity type for non-resolvable regions (`FACE`, `ID_DOCUMENT`). The model
therefore reads the same typed-placeholder scheme in the image that it reads in the text — which is
what the system prompt's image legend (Phase 2, design.md §12.2) describes.

Maximum image: long side ≤ 1600 px after scaling, ≤ 1.6 MP, WebP quality 0.8, base64 in the JSON
body (architecture §8.1 — one canonical body the guard scans, the ledger stores and the harness
hashes).

---

## 8. Guard step 5 — the image re-scan

Design.md §7.6 step 5. The guard now runs on pixels as well as bytes:

```
if payload.image:
   r ← worker.rescan(image, redactionBoxes)     // faces on the full image; OCR in 24 px halos
   if r.hits:
      if !alreadyRecomposed → recompose(dilate + 50%) and re-check
      else → drop the image, payload.image = null, level = L0, continue
```

Two independent checks, on the **composed output** rather than the input:

- **Face detection over the whole composed image.** If a face survives composition — because it was
  in a region wrongly marked cleared — this finds it.
- **OCR in a 24 px halo around every redaction box.** If dilation was insufficient and readable
  characters of the value remain at the edge, this finds them. *(The OCR half becomes fully
  effective in Phase 6; in Phase 4 the halo check runs with whatever recognition is available and
  the face check carries the load.)*

One recompose with +50% dilation, then **drop the image entirely and fall back to L0**. Degrading to
a text-only payload is always available and always safe; sending a questionable image is not.

---

## 9. Failure paths

Architecture §9.6, and this phase is where most of them become real:

| Failure | Behaviour |
|---|---|
| No WebGPU | WASM path; smaller crop budget; agent still works **(AC-3)** |
| Model fails to load | Image path disabled; **L0 only**; never "send raw because redaction is unavailable" |
| Perception deadline missed | Affected regions stay grey; counted as `unanalysed` |
| Capture geometry changed | Discard; after 3 tries, L0 (`CAPTURE_INCONSISTENT`) |
| **Worker killed mid-step** | No image, or only positively-cleared regions **(AC-7)** |
| Network disconnected | Detection and redaction keep running; the task cannot progress without the server, but the panel still shows detections and the sanitized preview **(AC-4, DR-2)** |

AC-4 is worth dwelling on because it is the demo's most persuasive moment [SS]: pulling the network
cable and watching local detection continue proves the perception is genuinely on-device, not a
thin client for a server-side model.

---

## 10. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 4.1 | EP probe with warm-up, cached in `storage.local` | Cache keyed by browser version + adapter info; invalidated on version change; second task start skips the 1.5 s adapter timeout entirely |
| 4.2 | sha256 verification **before session creation** | A corrupted `.onnx` on disk fails with `MODEL_LOAD_FAILED` and no session is created; the failure disables the image path rather than the whole agent |
| 4.3 | `fetch-models.ts` gains ViT + prompt embeddings | Deleting `public/models/` and re-running restores every model byte-identically; manifest lists licence and source for each |
| 4.4 | Face detector integrated, 10% box expansion | On a 12-face fixture at varied scales, all 12 detected at IoU ≥ 0.4; boxes cover hair and ears; **solid fill, never blur** |
| 4.5 | `export_vit_prompts.py` | Prompt embeddings precomputed and bundled; **the text encoder is not in the build** — asserted by a build-output size check |
| 4.6 | Zero-shot ViT region screening | On a fixture with an Aadhaar card image, a payment card, a signature and a QR code, each is classified above threshold and redacted **whole**, with no attempt to read it |
| 4.7 | Screen-state label on every capture | Label appears in the panel and in the ledger for every captured frame; adds ≤ 8 ms to the frame |
| 4.8 | Masked-glyph detector (DOM half) | A field rendering `•••••••••` is detected as PASSWORD presence |
| 4.9 | Worker message interface per design.md §11.1 | Every message type implemented; `timedOut` regions returned as boxes; one capture held at a time, bitmap closed after `compose`/`rescan` |
| 4.10 | FIFO scheduler with priorities and deadlines | Under a synthetic overload, faces complete and low-priority crops are skipped; skipped regions appear in `timedOut`, never silently as cleared |
| 4.11 | Lazy load, eviction, crop budgets, degradation ladder | Resident models stay loaded and warmed; evictable ones unload after idle; the ladder demotes under measured pressure; **face detection is never dropped** |
| 4.12 | dHash crop cache + normalized-text cache | A page with the same logo in 8 places runs the encoder once; caches cleared on task end |
| 4.13 | Capture service, ≤2/s, event-driven | On a static high-coverage page, **zero** captures in 60 s of idle; captures occur on navigation, `scrollend`, focus change and server request |
| 4.14 | `ImageBitmap` transferred into the worker | The host's reference is neutered after transfer (asserted); the worker closes the bitmap; no data URL is ever passed through extension messaging |
| 4.15 | Redaction-geometry digest | Scrolling between capture request and resolution discards the frame; 3 consecutive mismatches degrade to L0 with `CAPTURE_INCONSISTENT` |
| 4.16 | Additive compositor with `mergeUp` and clearance rules | A region with no positive clearance is grey; a fully-cleared container is drawn as one region; redaction boxes carry their placeholder or entity label |
| 4.17 | Coverage escalation L0/L1/L2 | Thresholds drive the level; a canvas-heavy page produces L1; a server `request_observation(L2, region)` produces a crop only |
| 4.18 | Guard image re-scan | A face planted in a wrongly-cleared region is caught on the composed image; one recompose at +50% dilation; a second hit drops the image and falls back to L0 |
| 4.19 | **AC-3** | With WebGPU disabled the demo task completes on WASM; the ledger reports latency for both paths |
| 4.20 | **AC-4** | With the network disconnected, the panel still shows detections and the sanitized preview for the current page |
| 4.21 | **AC-7** | Killing the perception worker mid-step results in either no image sent, or an image containing only positively-cleared regions |
| 4.22 | Panel: sanitized image, screen label, backend/model indicators | Payload viewer shows the composed image beside the bytes; the resource bar shows backend, models loaded and total MB |
| 4.23 | Model budget recorded | Total bundled model MB reported in the panel and the ledger; this is metric 4's headline number |

---

## 11. Milestone Definition

Phase 4 is **complete** when:

> A developer opens the panel on a fixture that mixes everything: a profile photo top-left, a
> scanned Aadhaar card as an `<img>`, a canvas-rendered spending chart, and a form with a visible
> phone number. They run a task.
>
> The payload viewer now has two panes. On the right, the bytes — placeholders, as in Phase 3. On
> the left, **the image the server received**: the page is recognisable, its headings and buttons
> perfectly readable, with a solid black box where the face was, labelled `FACE`; a second black box
> over the Aadhaar card image, labelled `ID_DOCUMENT` — redacted whole, never read; the phone number
> replaced by a box reading `⟪PHONE#3⟫`; and the canvas region a flat grey, because it could not be
> analysed within the frame deadline. Under it: *Coverage: 91% cleared · 4% redacted · 5%
> unanalysed.* A line reads *screen state: login form (0.71)*. The resource bar reads *Models
> 21.4 MB · WebGPU · Mem ~180 MB*.
>
> They scroll the page rapidly and watch the capture counter: it does not move while the page is
> settling, then takes exactly one capture on `scrollend`. They leave the page idle for a minute:
> zero captures, and CPU sits at nothing.
>
> Then they start breaking things. They disable WebGPU in chrome://flags and re-run: the backend
> indicator flips to *WASM · threads 4*, every latency roughly triples, and the task still
> completes — both numbers side by side in the ledger. They pull the network cable: the server step
> fails, the task stops with an explanation, and the panel **still shows the detections and the
> sanitized preview**, because none of that needed a server. They kill the perception worker from
> DevTools in the middle of a step: the next payload arrives with `image: null` and the step
> continues as L0 — no half-composed image, no leaked strip of un-analysed screen. They add a
> `setInterval` that scrolls the page 40 px every 50 ms and re-run: three captures are discarded on
> digest mismatch and the step proceeds text-only, logged as `CAPTURE_INCONSISTENT`.
>
> Finally they plant a face in a region the compositor wrongly cleared, by hand-editing the
> clearance list. The guard's re-scan finds it on the composed image, recomposes once with wider
> dilation, finds it again, and drops the image entirely. The step goes out as L0. Nothing
> identifiable was sent, and the failure is on screen with its reason.
>
> The PS's on-device vision requirement is visibly met, and every way it can fail, fails to grey.

---

## 12. Files to Create

```
apps/extension/
├── public/models/
│   ├── models.manifest.json                 # [modify] + ViT encoder, prompt embeddings
│   ├── clip-vit-*.onnx                      # [new, gitignored] fetched + verified
│   └── vit-prompts.bin                      # [new] precomputed text-prompt embeddings
├── src/perception/
│   ├── worker.ts                            # [rewrite] design.md §11.1 message loop
│   ├── runtime/{backend,probe-cache,sessions,evict}.ts   # [new]
│   ├── models/{face,vit-encoder,masked-glyph}.ts         # [new]
│   ├── preprocess/{resize,crop,tensor,dhash}.ts          # [new]
│   ├── compose/{compositor,merge-up,clearance}.ts        # [new]
│   ├── rescan/{halo,face-recheck}.ts                     # [new]
│   └── schedule/{queue,deadline,budget,ladder}.ts        # [new]
├── src/host/
│   ├── capture/{service,rate-limit,digest}.ts            # [new]
│   ├── privacy/context/builder.ts                        # [modify] ImagePart, coverage, L0/L1/L2
│   └── privacy/guard/image-rescan.ts                     # [new] guard step 5
├── src/ui/{SanitizedImage,ScreenLabel,ResourceBar}.tsx   # [new/modify]
└── test/
    ├── unit/{compositor,clearance,digest,scheduler,backend,coverage}.spec.ts
    ├── fixtures/{faces-12,id-card,canvas-chart,scrolling,mixed-media}.html
    └── e2e/{ac3-wasm,ac4-offline,ac7-worker-kill,image-rescan}.spec.ts

tools/models/
├── export_vit_prompts.py                    # [new] precompute at build time
└── quantize.py                              # [new] int8/fp16 variants
```

---

## 13. Performance Validation

All targets from design.md §10.2 and architecture §11.2/§11.3. Every one is an initial tunable that
Phase 0's measurements should have already refined.

| Metric | How to Measure | Target |
|---|---|---|
| Capture + decode | Ledger `client_timing` | ≤ 30 ms |
| Face + ViT screening | Worker timings | ≤ 15 ms (L0) / ≤ 30 ms (L1) |
| Compose + guard + encode | Worker + ledger | ≤ 60 ms (L1) |
| **Per-frame perception deadline** | Scheduler | 120 ms hard; overruns land in `timedOut`, never in the image |
| Bundled model size | `models.manifest.json` sum, shown in the panel | Report exactly; this is metric 4's headline |
| Peak memory, host + worker | Harness OS sampling | Report; draft target ≤ 250 MB |
| CPU idle on a static page | Harness, 60 s | ~0% — **zero captures is the mechanism** |
| CPU during a task | Harness, mean and p95 | Report both, per backend |
| WebGPU vs WASM delta | Both paths on the same corpus | Reported side by side, never averaged together **(AC-3)** |
| Image payload size | Captured payloads | ≤ 1.6 MP, WebP q0.8; base64 adds ~33% — record the real wire size |

---

## 14. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| Worker rewrite (message loop, queue, deadlines) | ~380 | 1 |
| Runtime: backend probe + cache, sessions, eviction | ~340 | 4 |
| Face detector integration | ~200 | 1 |
| ViT encoder + zero-shot screening + screen label | ~330 | 1 |
| Masked-glyph detector | ~90 | 1 |
| Preprocess: resize, crop, tensor, dHash | ~280 | 4 |
| Compositor + mergeUp + clearance rules | ~420 | 3 |
| Re-scan: halo + face re-check | ~180 | 2 |
| Scheduler: queue, deadline, budget, ladder | ~360 | 4 |
| Capture service + rate limit + digest | ~290 | 3 |
| Context builder: ImagePart, coverage, escalation | ~260 | 1 |
| Guard step 5 | ~170 | 1 |
| Panel: image, screen label, resource bar | ~310 | 3 |
| `export_vit_prompts.py`, `quantize.py` | ~260 | 2 |
| Unit suites | ~980 | 6 |
| Fixtures + e2e | ~740 | 9 |
| **Total** | **~5,590** | **46** |

New runtime dependencies: **2 models** — a CLIP-family ViT image encoder and its precomputed prompt
embeddings. No new libraries: ORT and Transformers.js are already present, and `OffscreenCanvas`,
`createImageBitmap` and WebGPU are platform APIs.

---

## 15. Forward Dependencies Declared Here

- **OCR is absent.** Unexplained regions stay grey and the guard's halo check has no recognition
  behind it. **[Phase 6, F-C07: PP-OCRv5 mobile det+rec with Devanagari routing. Until then, canvas
  and PDF pages are safe but low-value — the model sees grey where it would like text.]**
- **Fusion step 8 (OCR line fallback) still has no input.** **[Phase 6.]**
- **The UI element detector for DOM-less regions is deliberately not built.** Architecture §6.3
  drops it because it would require fine-tuning (C-6). **[Revisit only if Phase 5's harness shows a
  measurable gap on canvas/PDF categories.]**
- **NER profile L is not built.** **[Phase 6, gated on OQ-7 and on Phase 5's measurement of profile
  S's free-text recall against NFR-2's ≥0.95.]**
- **The degradation ladder's thresholds are guesses.** **[Phase 5 measures whether they trigger on
  the reference laptop and at what page complexity; the harness sweeps them.]**
- **Coverage escalation thresholds (0.92 / 0.70) are initial values.** **[Phase 5 tunes them
  against metric 1 vs metric 4 — more L1 payloads mean better context and worse latency, and only
  the harness can locate the knee.]**
- **`screenLabel` is recorded and unscored.** **[Phase 5's metric-1 scorer uses it for OQ-4's second
  reading — "the local model's own perception accuracy" — alongside the primary sanitized-vs-raw
  task-success measure.]**
- **The canary check in the guard is still absent.** **[Phase 5, T-5.8 — and it now needs to scan
  the composed image via OCR as well as the JSON bytes, which is why it lands after OCR exists in
  the harness auditor.]**
- **Model quantisation is scripted but not decided.** **[Phase 4's own bake-off
  (`bakeoff_phase4.md`) picks int8 vs fp16 per model against the size and accuracy budget;
  architecture §6.3 warns not to int8 the OCR recognizer if it costs accuracy, since accuracy is
  worth more points than a few megabytes.]**

---

## 16a. Implementation notes (added during the build, 2026-09-18)

Real deviations and gaps found while implementing this document, recorded here per CLAUDE.md rule
1 rather than left to drift silently against the design. See `docs/HISTORY.md`'s Phase 4 entry for
the full narrative and `docs/DECISIONS.md` for the two decision-log entries this phase added.

1. **§11.1's message types moved to `apps/extension/src/shared/`, not `src/perception/`.** Host
   and worker cannot import each other (architecture §15.3, ESLint-enforced) and talk only by
   message — the message *type definitions* still need one file both sides can import, exactly the
   role `shared/messages.ts` already plays for content↔host. `worker-protocol.ts` lives there now.
2. **§11.2's `storage.local` cache is host-side, not worker-side.** `chrome.storage`/
   `browser.storage` is an extension-page API, unavailable inside a plain
   `DedicatedWorkerGlobalScope` — the same category of platform correction as architecture §1.3
   C-8(b)'s `ImageBitmap`-transfer finding. The worker still owns the actual WebGPU/WASM probe (per
   §3.3's spike heritage) and reports `adapterInfo` back in its `ready` message so the host has
   something to key the cache on.
3. **T-4.2's runtime sha256 verification needs a `fetch()` call inside the worker**, which the
   project's no-network scan would otherwise flag. Resolved as one narrow, disclosed, exact-file
   exception (`scripts/check-no-network.ts`), not a silent workaround and not a silently-dropped
   requirement — see DECISIONS.md's 2026-09-18 entry.
4. **The YuNet model's real input/output contract did not match `models.manifest.json`.** The
   manifest's `inputShape` (`[1,3,160,120]`) was simply wrong; real inference showed a fixed
   `[1,3,640,640]` input and a 3-stride anchor-free head. The decode in `perception/models/face.ts`
   is transcribed from OpenCV's own C++ post-processing for this exact model (verified via a real
   fetch of the `opencv/opencv` source), not re-derived from the PS/design docs, which don't specify
   it at this level of detail.
5. **§7.5's `mergeUp` is implemented geometrically (box adjacency), not via DOM containment.** The
   design's prose ("common container," "descendants") describes a tree operation, but places the
   call inside `compose()`, which only ever receives a flat `Box[]` over the host↔worker message
   boundary — no DOM tree crosses that boundary, and duplicating the whole screen graph into every
   `compose` call was judged not worth it for a legibility optimization. Disclosed as an `[A]` in
   `perception/compose/merge-up.ts` itself.
6. **No CLIP-family ViT encoder exists in this sandboxed, network-restricted environment** — §4.2's
   zero-shot region screening and §4.3's screen-state label are real call shapes
   (`perception/models/vit-encoder.ts`: the exact prompt vocabulary, cosine+softmax classification
   math, thresholds) with no model behind them, exactly Phase 3's NER-stub precedent. Neither T-4.5
   nor T-4.6 nor T-4.7 is claimed complete in TASKS.md — each is marked `[~]` with the gap named.
7. **`export_vit_prompts.py`/`quantize.py` (§14) are written but not executed** — no ML Python
   environment (torch/open_clip/onnxruntime) and no network access to a CLIP checkpoint exist in
   this sandbox. Written to the real intended CLI interface so a normal ML environment can run them
   unchanged.
8. **Face-detection accuracy against real photographs is unverified.** §10's T-4.4 acceptance
   criterion (a 12-face fixture, IoU ≥ 0.4) needs licensable face photographs; none were reachable
   in this network-restricted sandbox (fetch attempts against Wikimedia Commons and the
   opencv_zoo repo's own example images both failed — see HISTORY). What *is* verified: the decode
   arithmetic against synthetic tensors built to the model's real, introspected output contract,
   and a real end-to-end inference pass through the actual bundled model with no crash and
   well-formed output shapes (`test/browser/face-pipeline.spec.ts`).
9. **`CANVAS`/`VIDEO` elements are routed to accessibility role `'img'`** in
   `content/screen-graph/roles.ts` so Channel V's element-level routing (§4.1: "runs on every
   img/video/canvas/avatar region") has something to select on — neither tag has a real implicit
   ARIA role by HTML-AAM, so this is a disclosed routing overload, not an accessibility-semantics
   claim.
10. **§6.2's dHash crop cache is built and tested but not yet called from a real per-region loop**
    — its main intended consumer (repeated ViT screening of the same logo/avatar) is the disclosed
    ViT no-op above, so there is nothing yet asking the cache for a hit. The normalized-text cache
    is not built at all this phase.
