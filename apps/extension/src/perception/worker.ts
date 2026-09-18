/// <reference lib="webworker" />
// design.md §11.1 — the real perception-worker message loop, replacing the Phase-0 spike's
// probe/bench handlers (kept as `spike-protocol.ts`; its pure math is still locked down by
// `test/unit/percentile.test.ts`). This is the only place raw pixels live (architecture §5.3):
// an `ImageBitmap` arrives transferred from the host, is closed once its capture's `compose`/
// `rescan` finish, and nothing here ever calls `fetch`/`XMLHttpRequest` for anything but a
// same-origin, extension-bundled model file (verified by sha256 in `runtime/sessions.ts` before
// any session is created).

import * as ort from 'onnxruntime-web';
import type { Backend, FromWorker, ToWorker } from '../shared/worker-protocol';
import { selectBackend } from './runtime/backend';
import { ModelLoadError, ModelRegistry } from './runtime/sessions';
import { cropRegion } from './preprocess/crop';
import { detectFaces } from './models/face';
import { buildCtcVocabulary } from './models/ocr-rec';
import { screenLabel } from './models/vit-encoder';
import { PriorityQueue } from './schedule/queue';
import { runWithDeadline } from './schedule/deadline';
import { applyCropBudget } from './schedule/budget';
import { compose, encodeWebp, type RedactionBoxSet } from './compose/compositor';
import { detectTextEntitiesInRegion } from './detect/text-region';
import { recheckFacesOnComposedImage } from './rescan/face-recheck';
import { checkHalosForText, type OcrRescanModels } from './rescan/halo';

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
  registry = new ModelRegistry(backend);
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
  if (faceModelId) {
    try {
      await registry.get(faceModelId);
    } catch (err) {
      faceModelId = null;
      post({ t: 'error', code: err instanceof ModelLoadError ? err.code : 'MODEL_LOAD_FAILED', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  post({ t: 'ready', backend, loaded: registry.loadedInfo(), adapterInfo: selected.adapterInfo });
}

async function handlePerceive(msg: Extract<ToWorker, { t: 'perceive' }>): Promise<void> {
  closeCurrentCapture(); // a previous capture whose compose was never called (e.g. L0 decided
  // after all) must not leak — see this file's `currentCapture` doc comment.
  currentCapture = { bitmap: msg.bitmap };

  const timings: Record<string, number> = {};
  const timedOut: Extract<FromWorker, { t: 'perceived' }>['timedOut'] = [];
  const candidates: Extract<FromWorker, { t: 'perceived' }>['candidates'] = [];

  const cropRegions = msg.regions.filter((r) => r.kind === 'crop');
  const { admitted, dropped } = applyCropBudget(cropRegions, backend);
  for (const d of dropped) timedOut.push(d.box);

  const faceSession = faceModelId && registry ? await registry.get(faceModelId).catch(() => null) : null;
  // T-6.5/T-6.6: OCR detection-side pass, finding NEW PII in a region the DOM never explained —
  // as opposed to `handleRescan`'s halo check, which only re-verifies pixels already decided to
  // be redacted. Loaded lazily, same as the halo path (design.md §6.4's degradation ladder never
  // resident-loads OCR); skipped entirely when there are no crop regions to look at.
  const ocrModels = admitted.length > 0 ? await loadOcrRescanModels() : null;

  let faceTimeMs = 0;
  let ocrTimeMs = 0;
  if (faceSession || ocrModels) {
    // Both capabilities run inside ONE per-region job (`kind: 'face'`, the queue's own top
    // priority) rather than two separately-queued jobs at 'face'/'ocr' priority — they already
    // share the same crop and the same per-region deadline slot, and design.md §11.4's
    // face > OCR ordering is about which capability gets dropped first under load (the ladder's
    // `no-ocr` rung, still unwired — see docs/HISTORY.md), not about interleaving within a region.
    const queue = new PriorityQueue<(typeof admitted)[number]>();
    for (const region of admitted) queue.enqueue({ id: region.id, kind: 'face', payload: region });

    const { completed, timedOut: regionTimedOut } = await runWithDeadline(
      queue,
      async (job) => {
        const crop = cropRegion(msg.bitmap, job.payload.box);

        const faceStart = performance.now();
        const faces = faceSession ? await detectFaces(faceSession, ort, crop, job.payload.box) : [];
        faceTimeMs += performance.now() - faceStart;

        const ocrStart = performance.now();
        const ocrHits = ocrModels ? await detectTextEntitiesInRegion(ort, ocrModels, crop, job.payload.id, job.payload.box) : [];
        ocrTimeMs += performance.now() - ocrStart;

        return { faces, ocrHits };
      },
      msg.deadlineMs,
    );
    for (const { job, result } of completed) {
      for (const face of result.faces) candidates.push({ entity: 'FACE', box: face.box, score: face.score, regionId: job.payload.id, channel: 'vision' });
      candidates.push(...result.ocrHits);
    }
    for (const job of regionTimedOut) timedOut.push(job.payload.box);
  } else {
    // Neither capability available — every region that would have been screened stays
    // `timedOut`, not silently cleared (the compositor's clearance rule then leaves it grey, per
    // T-4.2's AC).
    for (const region of admitted) timedOut.push(region.box);
  }
  timings.face = faceTimeMs;
  timings.ocr = ocrTimeMs;

  // design.md §4.3: the ViT encoder also embeds a low-res thumbnail of the full viewport on
  // EVERY capture, for the screen-state label — real call shape, disclosed no-op today (see
  // `models/vit-encoder.ts`'s top comment).
  let label: Extract<FromWorker, { t: 'perceived' }>['screenLabel'];
  if (msg.fullFrame) {
    const labelStart = performance.now();
    const result = await screenLabel(msg.bitmap);
    timings.screenLabel = performance.now() - labelStart;
    if (result) label = result;
  }

  // NOT closed here — `currentCapture` still owns `msg.bitmap` until `compose` (or a superseding
  // `perceive`) closes it. See the `currentCapture` doc comment above.
  post({ t: 'perceived', jobId: msg.jobId, candidates, screenLabel: label, timings, timedOut });
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
  });
  const webp = await encodeWebp(output.canvas);
  closeCurrentCapture();
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
    return { detSession, recSession, vocabulary: buildCtcVocabulary(vocabDict) };
  } catch {
    return null;
  }
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
      if (msg.t === 'compose') return await handleCompose(msg);
      if (msg.t === 'rescan') return await handleRescan(msg);
      if (msg.t === 'stats') {
        return post({ t: 'stats', memoryEstimateMB: registry?.memoryEstimateMB() ?? 0, sessions: registry?.loadedInfo() ?? [] });
      }
      if (msg.t === 'evict') {
        registry?.evict(msg.model);
        return;
      }
      // 'ner' — NER stays a Channel-independent call the host makes directly against
      // `perception/models/pii-ner.ts`'s pure function today (no session, nothing to route
      // through the worker's model registry); routing it through here is Phase 6 work once a
      // real profile-L model needs the worker's scheduler.
    } catch (err) {
      const jobId = 'jobId' in msg ? msg.jobId : undefined;
      post({ t: 'error', jobId, code: 'WORKER_FAILED', detail: err instanceof Error ? err.message : String(err) });
    }
  })();
});

export { compose, encodeWebp, type RedactionBoxSet };
