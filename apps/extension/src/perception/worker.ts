/// <reference lib="webworker" />
// design.md §11.1 — the real perception-worker message loop, replacing the Phase-0 spike's
// probe/bench handlers (kept as `spike-protocol.ts`; its pure math is still locked down by
// `test/unit/percentile.test.ts`). This is the only place raw pixels live (architecture §5.3):
// an `ImageBitmap` arrives transferred from the host, is closed once its capture's `compose`/
// `rescan` finish, and nothing here ever calls `fetch`/`XMLHttpRequest` for anything but a
// same-origin, extension-bundled model file (verified by sha256 in `runtime/sessions.ts` before
// any session is created).

import * as ort from 'onnxruntime-web';
import type { Backend, FromWorker, ModelLoadFailure, PerceiveDiagnostics, RegionDiagnostic, ToWorker } from '../shared/worker-protocol';
import { selectBackend } from './runtime/backend';
import { ModelLoadError, ModelRegistry } from './runtime/sessions';
import { cropRegion } from './preprocess/crop';
import { detectFaces } from './models/face';
import { buildCtcVocabulary } from './models/ocr-rec';
import { acceptedEntity, classifyRegion, parsePromptEmbeddings, screenLabel, type PromptLabel } from './models/vit-encoder';
import { PriorityQueue } from './schedule/queue';
import { runWithDeadline } from './schedule/deadline';
import { applyCropBudget } from './schedule/budget';
import { compose, encodeWebp, type RedactionBoxSet } from './compose/compositor';
import { detectTextEntitiesInRegion } from './detect/text-region';
import { recheckFacesOnComposedImage } from './rescan/face-recheck';
import { checkHalosForText, type OcrRescanModels } from './rescan/halo';
import { shouldRunNer } from './prefilter';
import { classifyProfileL, classifyProfileS, type TokenClassificationPipeline } from './models/pii-ner';

ort.env.allowLocalModels = true;

let registry: ModelRegistry | null = null;
let backend: Backend = 'wasm';
let faceModelId: string | null = null;
// T-6.3's halo re-scan (`rescan/halo.ts`) and T-6.5/T-6.6's detection-side pass (`detect/
// text-region.ts`, wired into `handlePerceive` below) both always use the Latin/English
// recognizer, regardless of page script — script routing (T-6.4's `script-route.ts`) is unused by
// either caller, since it would need the page's `lang` threaded into the `perceive`/`rescan`
// messages, which neither currently carries. A Devanagari miss on either path is a disclosed gap,
// not a silent one.
let ocrDetModelId: string | null = null;
let ocrRecEnModelId: string | null = null;
let vitModelId: string | null = null;
let ocrLoadError: string | null = null;
let vitPromptEmbeddings: ReadonlyMap<PromptLabel, Float32Array> | null = null;
// T-6.8: which NER profile this session's `init` asked for — read by `getNerPipeline` below.
// Profile L's pipeline is intentionally NOT warmed here alongside face/ViT: design.md §19's
// degradation ladder explicitly lists NER-L among the "lazy load; evict after idle" models (unlike
// the face detector/ViT encoder, which stay resident) — it loads on the first real `ner` message.
let nerProfile: 'S' | 'L' = 'S';
let nerPipeline: TokenClassificationPipeline | null = null;
let nerPipelineFailed = false;

// phase_4_vision.md §3.2: "The worker holds one capture at a time, and closes the bitmap once
// compose/rescan for that capture have finished." `perceive` transfers the bitmap in and analyses
// it but does NOT close it — a later `compose` call for the same capture needs the actual pixels
// to draw the cleared regions. `closeCurrentCapture` is the single place the bitmap is closed, so
// every path (compose completing, a new perceive superseding an uncomposed one, an init/evict)
// can call it without duplicating the "did we already close this" bookkeeping.
let currentCapture: { bitmap: ImageBitmap } | null = null;

function closeCurrentCapture(): void {
  currentCapture?.bitmap.close();
  currentCapture = null;
}

function post(msg: FromWorker, transfer?: Transferable[]): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);
}

async function handleInit(msg: Extract<ToWorker, { t: 'init' }>): Promise<void> {
  const selected = await selectBackend(msg.backendPref);
  backend = selected.backend;
  registry = new ModelRegistry(selected.providerPolicy);
  registry.register(msg.models);

  // Resident models are warmed up at init (design.md §19) so the first real step isn't penalised
  // by a lazy first load. A load failure disables only the image path (T-4.2's AC) — logged via a
  // jobless `error` the host may surface, but `ready` still fires so the agent can proceed L0-only.
  faceModelId = msg.models.find((m) => m.role === 'face')?.id ?? null;
  // OCR (T-6.3/T-6.4) is deliberately NOT warmed up here — design.md §6.4's degradation ladder
  // ("Lazy load; evict large sessions (OCR, NER-L) after idle") only resident-loads the face
  // detector and ViT encoder; OCR loads on its first real use (the halo re-scan, today).
  ocrDetModelId = msg.models.find((m) => m.role === 'ocr-det')?.id ?? null;
  ocrRecEnModelId = msg.models.find((m) => m.role === 'ocr-rec' && m.script === 'latin')?.id ?? null;
  vitModelId = msg.models.find((m) => m.role === 'vit')?.id ?? null;
  nerProfile = msg.profile;
  nerPipeline = null;
  nerPipelineFailed = false;
  ocrLoadError = null;
  const failed: ModelLoadFailure[] = [];
  const failure = (id: string, role: ModelLoadFailure['role'], err: unknown): ModelLoadFailure => ({
    id,
    role,
    code: err instanceof ModelLoadError ? err.code : 'MODEL_LOAD_FAILED',
    detail: err instanceof Error ? err.message : String(err),
  });
  if (faceModelId) {
    try {
      await registry.get(faceModelId);
    } catch (err) {
      failed.push(failure(faceModelId, 'face', err));
      faceModelId = null;
    }
  }
  // design.md §19: "Face detector and ViT encoder stay resident" — warmed the same way, and a
  // load failure disables only the ViT path (screen label + region screening), same fail-closed
  // shape as the face detector's own catch above.
  if (vitModelId) {
    try {
      await registry.get(vitModelId);
      vitPromptEmbeddings = parsePromptEmbeddings(await registry.getAsset(vitModelId));
    } catch (err) {
      failed.push(failure(vitModelId, 'vit', err));
      vitModelId = null;
      vitPromptEmbeddings = null;
    }
  }

  post({ t: 'ready', backend, loaded: registry.loadedInfo(), failed, adapterInfo: selected.adapterInfo, webgpuRejected: selected.webgpuRejected });
}

async function handlePerceive(msg: Extract<ToWorker, { t: 'perceive' }>): Promise<void> {
  closeCurrentCapture(); // a previous capture whose compose was never called (e.g. L0 decided
  // after all) must not leak — see this file's `currentCapture` doc comment.
  currentCapture = { bitmap: msg.bitmap };

  const perceiveStart = performance.now();
  const timings: Record<string, number> = {};
  const timedOut: Extract<FromWorker, { t: 'perceived' }>['timedOut'] = [];
  const candidates: Extract<FromWorker, { t: 'perceived' }>['candidates'] = [];
  const regionDiagnostics: RegionDiagnostic[] = [];
  const inferences: PerceiveDiagnostics['inferences'] = { face: 0, vitRegion: 0, vitFullFrame: 0, ocrDet: 0, ocrRec: 0 };
  const modelErrors: PerceiveDiagnostics['modelErrors'] = [];

  const cropRegions = msg.regions.filter((r) => r.kind === 'crop');
  const { admitted, dropped } = applyCropBudget(cropRegions, backend);
  for (const d of dropped) {
    timedOut.push(d.box);
    regionDiagnostics.push({ regionId: d.id, outcome: 'budget' });
  }

  const faceSession = faceModelId && registry ? await registry.get(faceModelId).catch(() => null) : null;
  const vitSession = vitModelId && registry ? await registry.get(vitModelId).catch(() => null) : null;
  // T-6.5/T-6.6: OCR detection-side pass, finding NEW PII in a region the DOM never explained —
  // as opposed to `handleRescan`'s halo check, which only re-verifies pixels already decided to
  // be redacted. Loaded lazily, same as the halo path (design.md §6.4's degradation ladder never
  // resident-loads OCR); skipped entirely when there are no crop regions to look at.
  const ocrModels = admitted.length > 0 ? await loadOcrRescanModels() : null;
  if (admitted.length > 0 && !ocrModels && ocrLoadError) modelErrors.push({ role: 'ocr-det', code: ocrLoadError });

  let faceTimeMs = 0;
  let ocrTimeMs = 0;
  let vitTimeMs = 0;
  if (faceSession || ocrModels || vitSession) {
    // All three capabilities run inside ONE per-region job (`kind: 'face'`, the queue's own top
    // priority) rather than separately-queued jobs — they already share the same crop and the
    // same per-region deadline slot, and design.md §11.4's ordering is about which capability
    // gets dropped first under load (the ladder's `no-ocr` rung, still unwired — see
    // docs/HISTORY.md), not about interleaving within a region.
    const queue = new PriorityQueue<(typeof admitted)[number]>();
    for (const region of admitted) queue.enqueue({ id: region.id, kind: 'face', payload: region });

    const { completed, timedOut: regionTimedOut } = await runWithDeadline(
      queue,
      async (job) => {
        const regionStart = performance.now();
        const crop = cropRegion(msg.bitmap, job.payload.box);

        const faceStart = performance.now();
        const faces = faceSession ? await detectFaces(faceSession, ort, crop, job.payload.box) : [];
        if (faceSession) inferences.face += 1;
        faceTimeMs += performance.now() - faceStart;

        const ocrStart = performance.now();
        const ocrStats = { linesDetected: 0, linesRecognized: 0 };
        const ocrHits = ocrModels ? await detectTextEntitiesInRegion(ort, ocrModels, crop, job.payload.id, job.payload.box, ocrStats) : [];
        if (ocrModels) {
          inferences.ocrDet += 1;
          inferences.ocrRec += ocrStats.linesRecognized;
        }
        ocrTimeMs += performance.now() - ocrStart;

        // design.md §6.4's zero-shot ViT region screening (T-4.6): a sensitive entity whose pooled
        // probability clears its threshold becomes a whole-region candidate — see
        // `acceptedEntity`'s doc comment for why pooled rather than top-1.
        const vitStart = performance.now();
        const vitResult = vitSession ? await classifyRegion(vitSession, ort, vitPromptEmbeddings, crop) : null;
        if (vitResult) inferences.vitRegion += 1;
        vitTimeMs += performance.now() - vitStart;
        const vitEntity = vitResult ? acceptedEntity(vitResult) : null;
        const vitAccepted = vitEntity !== null;

        const diagnostic: RegionDiagnostic = {
          regionId: job.payload.id,
          outcome: 'analysed',
          ms: performance.now() - regionStart,
          faces: faceSession ? faces.length : undefined,
          faceTopScore: faces.length > 0 ? Math.max(...faces.map((f) => f.score)) : undefined,
          ocrLinesDetected: ocrModels ? ocrStats.linesDetected : undefined,
          ocrLinesRecognized: ocrModels ? ocrStats.linesRecognized : undefined,
          ocrEntities: ocrModels ? ocrHits.map((h) => h.entity) : undefined,
          vit: vitResult ? { label: vitResult.label, score: vitResult.score, accepted: vitAccepted, entity: vitResult.entity ?? undefined, entityScore: vitResult.entityScore } : undefined,
        };
        return { faces, ocrHits, vitEntity, vitScore: vitResult?.entityScore, diagnostic };
      },
      msg.deadlineMs,
    );
    for (const { job, result } of completed) {
      for (const face of result.faces) candidates.push({ entity: 'FACE', box: face.box, score: face.score, regionId: job.payload.id, channel: 'vision' });
      candidates.push(...result.ocrHits);
      if (result.vitEntity) candidates.push({ entity: result.vitEntity, box: job.payload.box, score: result.vitScore!, regionId: job.payload.id, channel: 'vision' });
      regionDiagnostics.push(result.diagnostic);
    }
    for (const job of regionTimedOut) {
      timedOut.push(job.payload.box);
      regionDiagnostics.push({ regionId: job.payload.id, outcome: 'deadline' });
    }
  } else {
    // No capability available — every region that would have been screened stays `timedOut`, not
    // silently cleared (the compositor's clearance rule then leaves it grey, per T-4.2's AC).
    for (const region of admitted) {
      timedOut.push(region.box);
      regionDiagnostics.push({ regionId: region.id, outcome: 'no-capability' });
    }
  }
  timings.face = faceTimeMs;
  timings.ocr = ocrTimeMs;
  timings.vit = vitTimeMs;

  // design.md §4.3: the ViT encoder also embeds a low-res thumbnail of the full viewport on
  // EVERY capture, for the screen-state label.
  let label: Extract<FromWorker, { t: 'perceived' }>['screenLabel'];
  let screenLabelMs = 0;
  if (msg.fullFrame) {
    const labelStart = performance.now();
    const result = await screenLabel(vitSession, ort, vitPromptEmbeddings, msg.bitmap);
    screenLabelMs = performance.now() - labelStart;
    timings.screenLabel = screenLabelMs;
    if (result) {
      label = result;
      inferences.vitFullFrame += 1;
    }
  }

  const providerOf = (id: string | null) => (id && registry ? registry.providerOf(id) ?? undefined : undefined);
  const diagnostics: PerceiveDiagnostics = {
    backend,
    providers: {
      face: faceSession ? providerOf(faceModelId) : undefined,
      vit: vitSession ? providerOf(vitModelId) : undefined,
      ocrDet: ocrModels ? providerOf(ocrDetModelId) : undefined,
      ocrRec: ocrModels ? providerOf(ocrRecEnModelId) : undefined,
    },
    available: { face: !!faceSession, vit: !!vitSession && !!vitPromptEmbeddings, ocr: !!ocrModels },
    inferences,
    ms: { face: faceTimeMs, vit: vitTimeMs, ocr: ocrTimeMs, screenLabel: screenLabelMs, total: performance.now() - perceiveStart },
    regions: regionDiagnostics,
    modelErrors,
  };

  // NOT closed here — `currentCapture` still owns `msg.bitmap` until `compose` (or a superseding
  // `perceive`) closes it. See the `currentCapture` doc comment above.
  post({ t: 'perceived', jobId: msg.jobId, candidates, screenLabel: label, timings, timedOut, diagnostics });
}

async function handleCompose(msg: Extract<ToWorker, { t: 'compose' }>): Promise<void> {
  if (!currentCapture) {
    post({ t: 'error', jobId: msg.jobId, code: 'NO_CAPTURE', detail: 'compose called with no prior perceive for this capture' });
    return;
  }
  const output = compose({
    bitmap: currentCapture.bitmap,
    cleared: msg.cleared,
    regions: msg.regions as RedactionBoxSet[],
    scale: msg.scale,
    unlabelled: msg.unlabelled,
  });
  const webp = await encodeWebp(output.canvas);
  // T-6.10: NOT closed here. This file's own `currentCapture` doc comment already says the
  // bitmap is meant to survive until "compose/rescan for that capture have finished" — plural,
  // because `image-rescan.ts`'s halo re-check can call `compose` a SECOND time (`recompose`, via
  // this same handler) against the very same capture when it finds a residual leak the first
  // composite missed, and that second call needs `currentCapture` to still be alive. Closing here
  // unconditionally broke exactly that path — found by driving a real fixture end to end for the
  // first time (T-6.9/T-6.10's ablation runner) once `captureVisibleTab` could finally succeed at
  // all (see fixture_server.py): the halo rescan found a real hit, `recompose` fired a second
  // `compose` request, and it arrived to find `currentCapture` already null. `handlePerceive`'s
  // own `closeCurrentCapture()` at the top of the NEXT capture cycle is what actually reclaims
  // this one now — the same place that already handled "a previous capture whose compose was
  // never called at all" (the L0 case), just widened to also cover "compose happened but a
  // possible recompose hadn't yet."
  post({ t: 'composed', jobId: msg.jobId, webp, coverage: output.coverage }, [webp]);
}

/** A load failure here (missing model, sha256 mismatch, OOM) disables only the halo re-scan's OCR
 * half for this rescan call — same "fail the capability, not the agent" shape as `faceModelId`'s
 * own catch above, not a new pattern. */
async function loadOcrRescanModels(): Promise<OcrRescanModels | null> {
  if (!registry || !ocrDetModelId || !ocrRecEnModelId) return null;
  try {
    const [detSession, recSession, vocabDict] = await Promise.all([
      registry.get(ocrDetModelId),
      registry.get(ocrRecEnModelId),
      registry.getDict(ocrRecEnModelId),
    ]);
    ocrLoadError = null;
    return { detSession, recSession, vocabulary: buildCtcVocabulary(vocabDict) };
  } catch (err) {
    ocrLoadError = err instanceof ModelLoadError ? err.code : 'MODEL_LOAD_FAILED';
    return null;
  }
}

/** T-6.8: `openai/privacy-filter` at q4, real, loaded through `@huggingface/transformers`'s own
 * pipeline (not `ModelRegistry` — that class manages one-file `ort.InferenceSession`s; this model
 * is a multi-file (config/tokenizer/onnx) load transformers.js already knows how to do, and
 * duplicating that loader here would be the same "not the real thing" gap the old stub was, just
 * moved down a layer). `env.localModelPath` defaults to `/models/` in a browser/worker environment
 * (confirmed by reading `@huggingface/transformers`'s own `env.js`, not assumed) — the SAME
 * extension-relative root every other bundled model already fetches from (`public/models/`), so
 * `apps/extension/public/models/privacy-filter/` (this repo's real, sha256-unverified-by-us-but-
 * fetched-straight-from-`openai/privacy-filter`'s own HF repo weights) is found with no extra
 * config. `allowRemoteModels = false` is the one setting that matters for this project's own
 * invariant: even if the local fetch somehow missed, this call must never silently reach out to
 * the real Hugging Face Hub over the network from inside the perception worker. WebGPU-only per
 * design.md §6.3/OQ-7 — a `backend !== 'webgpu'` session never attempts this at all, same
 * fail-closed shape `classifyRegion`'s vision path already uses (a load/inference failure disables
 * only this capability, never the rest of the step). */
async function getNerPipeline(): Promise<TokenClassificationPipeline | null> {
  if (nerProfile !== 'L' || backend !== 'webgpu' || nerPipelineFailed) return null;
  if (nerPipeline) return nerPipeline;
  try {
    // Real bug, found and fixed 2026-09-26 (T-6.8), root-caused across several layers before
    // landing on this fix. Importing `@huggingface/transformers` as a normal module specifier
    // (`import ... from '@huggingface/transformers'`) makes Vite bundle/inline its code — and its
    // bundled `onnxruntime-web`'s WebGPU (JSEP) backend loader does its OWN dynamic `import()` of
    // its WASM glue module, keyed off `import.meta.url`/same-origin checks that resolve
    // differently once Vite has processed the code this way (confirmed by direct reproduction:
    // the resulting `import.meta.url` no longer points at a plain, directly re-importable same-
    // origin file the way the untouched package does). The end effect, at runtime: a `TypeError:
    // Failed to fetch dynamically imported module: blob:chrome-extension://...` — this extension's
    // CSP (`script-src 'self' 'wasm-unsafe-eval'`, wxt.config.ts) has no reason to allow a `blob:`
    // script source, and correctly blocks it, so `pipeline()` always failed with "no available
    // backend found" and profile L never ran on a single real fixture. Tried and ruled out first,
    // each confirmed NOT sufficient by rerunning against the real built extension rather than
    // assumed fixed: overriding `env.backends.onnx.wasm.wasmPaths` to this project's own bundled
    // local copies of the exact matching onnxruntime-web files (`public/models/ort-web/` — still
    // worth keeping, since it also stops a real CDN fetch attempt); `wxt.config.ts`'s `worker:
    // { format: 'es' }` (still worth keeping — real ESM output instead of Vite's default IIFE);
    // `numThreads = 1`. The fix that actually works: don't let Vite touch `@huggingface/
    // transformers` at all. Its own `dist/transformers.web.js` is a complete, pre-built, ready-
    // to-run browser ES module (copied once into `public/models/transformers-web/`, unmodified —
    // the package's own official browser build, not a third-party mirror) — dynamically importing
    // it by its literal served URL (not a bare specifier) is exactly the same "opaque runtime
    // string Vite doesn't touch" pattern `wasmPaths` and every `.onnx` model URL already use, and
    // sidesteps the whole class of Vite-processing-changes-module-semantics problem above: this
    // file's own `import.meta.url` is simply its own real, same-origin, directly-fetchable URL.
    // @ts-expect-error a served static-asset URL, not a resolvable module specifier — TS has no
    // way to type-check this import target; the cast just below supplies the real shape instead.
    const { pipeline, env } = (await import(/* @vite-ignore */ '/models/transformers-web/transformers.web.js')) as typeof import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // Still needed even with the plain-URL import above: `onnxruntime-web`'s own module-level
    // setup code defaults `wasmPaths` to a `cdn.jsdelivr.net` URL whenever it isn't already set,
    // regardless of same-origin status — this has nothing to do with the blob-import bug the
    // long comment above this function describes, it's simply the package's own unconditional
    // default. Overridden to this project's own bundled copy of the exact matching files
    // (`public/models/ort-web/`, copied once from this pinned dependency's own `dist/`).
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = {
        mjs: '/models/ort-web/ort-wasm-simd-threaded.jsep.mjs',
        wasm: '/models/ort-web/ort-wasm-simd-threaded.jsep.wasm',
      };
    }
    const p = await pipeline('token-classification', 'privacy-filter', { dtype: 'q4', device: 'webgpu' });
    nerPipeline = p as unknown as TokenClassificationPipeline;
    return nerPipeline;
  } catch (err) {
    nerPipelineFailed = true;
    post({ t: 'error', code: 'MODEL_LOAD_FAILED', detail: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** T-6.8: `msg.chunks` are `builder.ts`'s free-text sources, each independently prefiltered here
 * (`shouldRunNer`, T-3.10's real pre-filter — "reject ≥80% before the model runs") before the
 * (expensive) model ever sees it. [A] simplification: `shouldRunNer`'s second argument
 * (`insideFormOrProfileContainer`) is a DOM concept the worker has no access to over this message —
 * every chunk is prefiltered with it defaulted to `false`, which still catches this filter's own
 * capitalized-run/digit-cluster/gazetteer signals; it just can't add the container-context boost. A
 * disclosed narrowing, not a silent one. Profile S has no real model (`classifyProfileS` always
 * returns `[]`) — this always answers, whichever profile is active, so the host never needs to
 * branch on it. */
async function handleNer(msg: Extract<ToWorker, { t: 'ner' }>): Promise<void> {
  const nerModel = await getNerPipeline();
  const spans: Extract<FromWorker, { t: 'nerResult' }>['spans'] = [];
  for (const chunk of msg.chunks) {
    if (!shouldRunNer(chunk.text)) continue;
    const matches = nerModel ? await classifyProfileL(nerModel, chunk.text) : await classifyProfileS(chunk.text);
    for (const m of matches) spans.push({ id: chunk.id, start: m.start, end: m.end, entity: m.entity, score: m.score });
  }
  post({ t: 'nerResult', jobId: msg.jobId, spans });
}

async function handleRescan(msg: Extract<ToWorker, { t: 'rescan' }>): Promise<void> {
  const hits: Extract<FromWorker, { t: 'rescanned' }>['hits'] = [];
  const faceSession = faceModelId && registry ? await registry.get(faceModelId).catch(() => null) : null;
  if (faceSession) {
    const faceBoxes = await recheckFacesOnComposedImage(faceSession, ort, msg.image);
    for (const box of faceBoxes) hits.push({ entity: 'FACE', box, score: 1 });
  }
  const halos = msg.halos.length > 0 ? msg.halos : msg.redactionBoxes;
  const ocrModels = await loadOcrRescanModels();
  const textHits = await checkHalosForText(ort, ocrModels, msg.image, halos);
  for (const box of textHits) hits.push({ entity: 'SECRET', box, score: 1 });

  post({ t: 'rescanned', jobId: msg.jobId, hits });
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  (async () => {
    try {
      if (msg.t === 'init') return await handleInit(msg);
      if (msg.t === 'perceive') return await handlePerceive(msg);
      if (msg.t === 'ner') return await handleNer(msg);
      if (msg.t === 'compose') return await handleCompose(msg);
      if (msg.t === 'rescan') return await handleRescan(msg);
      if (msg.t === 'stats') {
        return post({ t: 'stats', memoryEstimateMB: registry?.memoryEstimateMB() ?? 0, sessions: registry?.loadedInfo() ?? [] });
      }
      if (msg.t === 'evict') {
        registry?.evict(msg.model);
        return;
      }
    } catch (err) {
      const jobId = 'jobId' in msg ? msg.jobId : undefined;
      post({ t: 'error', jobId, code: 'WORKER_FAILED', detail: err instanceof Error ? err.message : String(err) });
    }
  })();
});

export { compose, encodeWebp, type RedactionBoxSet };
