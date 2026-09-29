/// <reference lib="webworker" />
// design.md §11.1 — the real perception-worker message loop, replacing the Phase-0 spike's
// probe/bench handlers (kept as `spike-protocol.ts`; its pure math is still locked down by
// `test/unit/percentile.test.ts`). This is the only place raw pixels live (architecture §5.3):
// an `ImageBitmap` arrives transferred from the host, is closed once its capture's `compose`/
// `rescan` finish, and nothing here ever calls `fetch`/`XMLHttpRequest` for anything but a
// same-origin, extension-bundled model file (verified by sha256 in `runtime/sessions.ts` before
// any session is created).

import * as ort from 'onnxruntime-web';
import type { Backend, Box, FrameAnalysis, FromWorker, ModelLoadFailure, PerceiveDiagnostics, RegionDiagnostic, ToWorker } from '../shared/worker-protocol';
import { selectBackend } from './runtime/backend';
import { ModelLoadError, ModelRegistry } from './runtime/sessions';
import { cropRegion } from './preprocess/crop';
import { findAll } from '@aegis/recognizers';
import { detectFacesFullFrame, type FaceDetection } from './models/face';
import { buildCtcVocabulary, recognizeLine, spanExtent, type RecognizedLine } from './models/ocr-rec';
import { detectText } from './models/ocr-det';
import { classifyRegion, confirmedEntity, parsePromptEmbeddings, screenLabel, type PromptLabel, type RegionClassification, type RegionEvidence, type VisionEntity } from './models/vit-encoder';
import { cropBudgetFor } from './schedule/budget';
import { compose, encodeWebp, type RedactionBoxSet } from './compose/compositor';
import { idDocumentTextEvidence, isNearUniform, looksLikeBarcode, looksLikeQrCode, looksLikeSignature, toGray } from './detect/verify';
import { haloAround, readHaloText, type OcrRescanModels } from './rescan/halo';
import { shouldRunNer } from './prefilter';
import { classifyProfileL, classifyProfileS, type TokenClassificationPipeline } from './models/pii-ner';
import { pixelKey, RegionResultCache } from './region-cache';

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
  residentRetryAt.clear();
  ocrRetryAt = 0;
  // A model that fails here stays registered: `loadResident` retries it on a later step (a
  // transient fetch or GPU hiccup must not cost the whole task its face detector).
  if (faceModelId) {
    try {
      await registry.get(faceModelId);
    } catch (err) {
      failed.push(failure(faceModelId, 'face', err));
      residentRetryAt.set(faceModelId, performance.now() + RESIDENT_RETRY_MS);
    }
  }
  // design.md §19: "Face detector and ViT encoder stay resident" — warmed the same way, and a
  // load failure disables only the ViT path (screen label + region screening), same fail-closed
  // shape as the face detector's own catch above.
  vitPromptEmbeddings = null;
  if (vitModelId) {
    try {
      await registry.get(vitModelId);
      vitPromptEmbeddings = parsePromptEmbeddings(await registry.getAsset(vitModelId));
    } catch (err) {
      failed.push(failure(vitModelId, 'vit', err));
      residentRetryAt.set(vitModelId, performance.now() + RESIDENT_RETRY_MS);
    }
  }

  post({ t: 'ready', backend, loaded: registry.loadedInfo(), failed, adapterInfo: selected.adapterInfo, webgpuRejected: selected.webgpuRejected });
}

// A model that failed to load is tried again this soon: its part of the frame stays grey meanwhile,
// so a transient fetch or GPU hiccup must cost a step or two at most.
const RESIDENT_RETRY_MS = 2_000;
/** After the frame deadline, pictures CLIP had no time for are still screened by pixel structure
 * for this long (a few ms each). */
const PIXEL_SCREEN_EXTRA_MS = 600;
/** Time text reading always gets in a perceive (~50 lines on WASM; cached lines cost nothing). */
const MIN_TEXT_READ_MS = 1500;
const residentRetryAt = new Map<string, number>();
let ocrRetryAt = 0;

/** Runs `run` on `session`; if it throws on a WebGPU session, the model is re-created on WASM and
 * run once more. */
async function withWasmFallback<T>(modelId: string | null, session: ort.InferenceSession, run: (s: ort.InferenceSession) => Promise<T>): Promise<T> {
  try {
    return await run(session);
  } catch (err) {
    if (!registry || !modelId || registry.providerOf(modelId) !== 'webgpu') throw err;
    return run(await registry.reloadOnWasm(modelId));
  }
}

/** The face detector or the ViT, loading it again if an earlier load failed and its back-off has
 * passed; null while it is unavailable (what it would have screened stays grey meanwhile). */
async function loadResident(role: 'face' | 'vit'): Promise<ort.InferenceSession | null> {
  const id = role === 'face' ? faceModelId : vitModelId;
  if (!id || !registry) return null;
  const retryAt = residentRetryAt.get(id);
  if (retryAt !== undefined && performance.now() < retryAt) return null;
  try {
    const session = await registry.get(id);
    if (role === 'vit' && !vitPromptEmbeddings) vitPromptEmbeddings = parsePromptEmbeddings(await registry.getAsset(id));
    residentRetryAt.delete(id);
    return session;
  } catch {
    residentRetryAt.set(id, performance.now() + RESIDENT_RETRY_MS);
    return null;
  }
}

// CLIP + verifier results per image region, and OCR per text line, reused only for byte-identical
// pixels (region-cache.ts): an unchanged page costs almost nothing on the next step.
type RegionOcrHit = Extract<FromWorker, { t: 'perceived' }>['candidates'][number];
const regionCache = new RegionResultCache<RegionOcrHit, RegionDiagnostic>();
const lineCache = new Map<string, RecognizedLine>();
const LINE_CACHE_MAX = 1024;

// An image smaller than this on screen cannot carry a legible ID document, QR code or signature;
// faces and text inside it are still found by the whole-frame passes.
const MIN_SCREEN_REGION_PX = 40;
// Full-frame text detection resolution (long side). Screen text is small: a 1280 px viewport kept
// at 1:1 keeps 11 px text detectable, where PaddleOCR's 960 default shrinks it to 8 px.
const OCR_FULL_FRAME_LIMIT = 1280;
// A detected line is already DOM text when this much of it lies on DOM text boxes.
const DOM_COVERED_FRACTION = 0.6;
// A line belongs to an image when this much of it lies inside the image's box.
const IN_IMAGE_FRACTION = 0.5;
const ID_ENTITIES = new Set(['AADHAAR', 'PAN', 'PASSPORT', 'DOB']);

function clipToFrame([x, y, w, h]: Box, fw: number, fh: number): Box {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(fw, x + w);
  const y1 = Math.min(fh, y + h);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

function insideFraction([x, y, w, h]: Box, [bx, by, bw, bh]: Box): number {
  const ix = Math.max(0, Math.min(x + w, bx + bw) - Math.max(x, bx));
  const iy = Math.max(0, Math.min(y + h, by + bh) - Math.max(y, by));
  return w * h > 0 ? (ix * iy) / (w * h) : 0;
}

/** Fraction of `box` covered by the union of `cover` — sampled on a 7×3 grid, which is plenty to
 * tell "this line is DOM text" from "this line is not". */
function coveredFraction([x, y, w, h]: Box, cover: readonly Box[]): number {
  const near = cover.filter((c) => c[0] < x + w && x < c[0] + c[2] && c[1] < y + h && y < c[1] + c[3]);
  if (near.length === 0) return 0;
  let inside = 0;
  let total = 0;
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 3; j++) {
      const px = x + (w * (i + 0.5)) / 7;
      const py = y + (h * (j + 0.5)) / 3;
      total++;
      if (near.some(([cx, cy, cw, ch]) => px >= cx && px <= cx + cw && py >= cy && py <= cy + ch)) inside++;
    }
  }
  return inside / total;
}

function cropPixels(canvas: OffscreenCanvas): Uint8ClampedArray {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
}

interface OcrLine {
  box: Box;
  /** Id of the image region the line lies in, if any. */
  region: string | null;
  domCovered: boolean;
  read?: RecognizedLine;
}

async function recognizeFrameLine(models: OcrRescanModels, frame: ImageBitmap, line: OcrLine): Promise<RecognizedLine> {
  const [lx, ly, lw, lh] = line.box;
  const w = Math.max(1, Math.round(lw));
  const h = Math.max(1, Math.round(lh));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(frame, lx, ly, lw, lh, 0, 0, w, h);
  const key = pixelKey(w, h, cropPixels(canvas), 'line');
  const cached = lineCache.get(key);
  if (cached) return cached;
  const read = await recognizeLine(models.recSession, ort, canvas, models.vocabulary);
  lineCache.set(key, read);
  while (lineCache.size > LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!);
  return read;
}

/** Recognizer matches in a read line, each boxed to its own characters (CTC positions) rather than
 * the whole line, falling back to the line when positions are unknown. */
function lineCandidates(line: OcrLine, regionId: string | undefined): RegionOcrHit[] {
  const read = line.read;
  if (!read || read.text.trim().length === 0) return [];
  const out: RegionOcrHit[] = [];
  const [lx, ly, lw, lh] = line.box;
  const normalizedSameLength = read.text.normalize('NFKC').length === read.text.length;
  for (const match of findAll(read.text)) {
    const extent = normalizedSameLength ? spanExtent(read, match.start, match.end, lw) : null;
    const box: Box = extent ? [lx + extent[0], ly, extent[1] - extent[0], lh] : [lx, ly, lw, lh];
    out.push({ entity: match.entity, box, score: match.score, regionId, channel: 'text-ocr', source: match.source, value: match.matchedText });
  }
  return out;
}

async function handlePerceive(msg: Extract<ToWorker, { t: 'perceive' }>): Promise<void> {
  closeCurrentCapture(); // a previous capture whose compose was never called (e.g. L0 decided
  // after all) must not leak — see this file's `currentCapture` doc comment.
  currentCapture = { bitmap: msg.bitmap };
  const frame = msg.bitmap;

  const perceiveStart = performance.now();
  const deadlineAt = perceiveStart + msg.deadlineMs;
  const timings: Record<string, number> = {};
  const timedOut: Extract<FromWorker, { t: 'perceived' }>['timedOut'] = [];
  const candidates: Extract<FromWorker, { t: 'perceived' }>['candidates'] = [];
  const regionDiagnostics: RegionDiagnostic[] = [];
  const inferences: PerceiveDiagnostics['inferences'] = { face: 0, vitRegion: 0, vitFullFrame: 0, ocrDet: 0, ocrRec: 0 };
  const modelErrors: PerceiveDiagnostics['modelErrors'] = [];
  const unanalysed: Box[] = [];

  const faceSession = await loadResident('face');
  const vitSession = await loadResident('vit');
  const ocrModels = await loadOcrRescanModels();
  if (!ocrModels && ocrLoadError) modelErrors.push({ role: 'ocr-det', code: ocrLoadError });
  const clipReady = !!vitSession && !!vitPromptEmbeddings;

  // 1. Faces, over the whole frame.
  let faceStatus: FrameAnalysis['faces'] = faceSession ? 'ok' : 'unavailable';
  let faces: FaceDetection[] = [];
  let facePasses = 0;
  const faceStart = performance.now();
  if (faceSession) {
    try {
      const found = await withWasmFallback(faceModelId, faceSession, (s) => detectFacesFullFrame(s, ort, frame));
      faces = found.faces;
      facePasses = found.passes;
      inferences.face += found.passes;
    } catch (err) {
      faceStatus = 'failed';
      modelErrors.push({ role: 'face', code: err instanceof Error ? 'INFERENCE_FAILED' : 'UNKNOWN' });
    }
  }
  const faceMs = performance.now() - faceStart;
  for (const face of faces) candidates.push({ entity: 'FACE', box: face.box, score: face.score, channel: 'vision' });

  // 2. Text lines, over the whole frame.
  let textStatus: FrameAnalysis['text'] = ocrModels ? 'ok' : 'unavailable';
  const detStart = performance.now();
  let rawLines: { box: Box }[] = [];
  if (ocrModels) {
    try {
      rawLines = await withWasmFallback(ocrDetModelId, ocrModels.detSession, (s) => detectText(s, ort, frame, OCR_FULL_FRAME_LIMIT));
      inferences.ocrDet += 1;
    } catch {
      textStatus = 'failed';
      modelErrors.push({ role: 'ocr-det', code: 'INFERENCE_FAILED' });
    }
  }
  const textDetMs = performance.now() - detStart;

  const imageRegions = msg.regions
    .filter((r) => r.kind === 'crop')
    .map((r) => ({ ...r, visible: clipToFrame(r.box, frame.width, frame.height) }))
    .filter((r) => r.visible[2] > 0 && r.visible[3] > 0)
    .sort((a, b) => b.visible[2] * b.visible[3] - a.visible[2] * a.visible[3]);
  const textBoxes = msg.textBoxes ?? [];
  const lines: OcrLine[] = rawLines.map(({ box }) => {
    const region = imageRegions.find((r) => insideFraction(box, r.visible) >= IN_IMAGE_FRACTION);
    return { box, region: region?.id ?? null, domCovered: !region && coveredFraction(box, textBoxes) >= DOM_COVERED_FRACTION };
  });

  let recMs = 0;
  let recognized = 0;
  // Reading text gets its own time, whatever the passes before it took: on a picture-heavy page
  // (amazon.in's home page, 2026-09-30) faces, text detection and CLIP used the whole frame
  // deadline and not one line in a picture was read — every banner's text went grey.
  let readDeadlineAt = deadlineAt;
  const readLine = async (line: OcrLine): Promise<boolean> => {
    if (!ocrModels || textStatus !== 'ok') return false;
    if (performance.now() > readDeadlineAt) return false;
    const t0 = performance.now();
    try {
      line.read = await recognizeFrameLine(ocrModels, frame, line);
      recognized += 1;
      inferences.ocrRec += 1;
      return true;
    } catch {
      return false;
    } finally {
      recMs += performance.now() - t0;
    }
  };

  // 3. Pictures, in two passes so a slow page loses as little as possible to the deadline: first
  // every picture gets CLIP plus the structural checks (cheap, one inference each); then text is
  // read — in pictures CLIP thinks may be documents first (their text decides it), then in other
  // pictures, then text the DOM never had. What the deadline leaves unread greys only that line.
  let vitMs = 0;
  let cachedRegions = 0;
  const budget = cropBudgetFor(backend);
  let classified = 0;
  interface Classified {
    region: (typeof imageRegions)[number];
    lines: OcrLine[];
    gray: ReturnType<typeof toGray>;
    vit: RegionClassification | null;
    evidence: RegionEvidence;
    cacheKey: string;
    cached: boolean;
    confirmed: ReturnType<typeof confirmedEntity>;
    started: number;
    /** Past CLIP's budget or deadline: screened by pixel structure and its text only. */
    pixelsOnly?: boolean;
  }
  const pending: Classified[] = [];
  for (const region of imageRegions) {
    const [, , vw, vh] = region.visible;
    const regionLines = lines.filter((l) => l.region === region.id);
    if (vw < MIN_SCREEN_REGION_PX || vh < MIN_SCREEN_REGION_PX) {
      // Too small to be a document, but any text in it is still read by the pass below.
      for (const l of regionLines) l.region = null;
      regionDiagnostics.push({ regionId: region.id, outcome: 'small' });
      continue;
    }
    const clipTime = classified < budget && performance.now() <= deadlineAt;
    // Past CLIP's budget, a picture is still screened by what costs a few ms: its pixels' structure
    // (QR finder patterns, barcode bars, signature ink) and its text (read below, faces were found
    // over the whole frame). Only a picture past even that time stays grey unseen.
    if (!clipTime && performance.now() > deadlineAt + PIXEL_SCREEN_EXTRA_MS) {
      timedOut.push(region.box);
      unanalysed.push(region.visible);
      regionDiagnostics.push({ regionId: region.id, outcome: classified >= budget ? 'budget' : 'deadline' });
      continue;
    }
    const started = performance.now();
    const crop = cropRegion(frame, region.visible);
    const gray = toGray(crop);
    if (isNearUniform(gray)) {
      for (const l of regionLines) l.read = { text: '', confidence: 0 };
      regionDiagnostics.push({ regionId: region.id, outcome: 'blank' });
      continue;
    }
    if (clipTime) classified += 1;
    const evidence: RegionEvidence = {
      qr: false,
      barcode: false,
      signature: false,
      idText: false,
      face: faces.some((f) => insideFraction(f.box, region.visible) >= 0.5),
      lines: regionLines.length,
      aspect: vw / vh,
    };
    const cacheKey = pixelKey(crop.width, crop.height, cropPixels(crop), `v${clipReady ? 1 : 0}`);
    const hit = regionCache.get(cacheKey, region.visible, region.id);
    if (!clipTime && !hit) {
      evidence.qr = looksLikeQrCode(gray);
      evidence.barcode = !evidence.qr && looksLikeBarcode(gray);
      evidence.signature = looksLikeSignature(gray);
      pending.push({ region, lines: regionLines, gray, vit: null, evidence, cacheKey, cached: false, confirmed: null, started, pixelsOnly: true });
      continue;
    }
    if (hit) {
      cachedRegions += 1;
      const confirmed = hit.vitEntity ? { entity: hit.vitEntity as VisionEntity, score: hit.vitScore ?? 0.9, why: 'cached' } : null;
      pending.push({ region, lines: regionLines, gray, vit: null, evidence, cacheKey, cached: true, confirmed, started });
      regionDiagnostics.push({ ...hit.diagnostic, regionId: region.id, ms: performance.now() - started, cached: true });
      continue;
    }
    evidence.qr = looksLikeQrCode(gray);
    evidence.barcode = !evidence.qr && looksLikeBarcode(gray);
    const vitStart = performance.now();
    const vit = clipReady && vitSession ? await withWasmFallback(vitModelId, vitSession, (sess) => classifyRegion(sess, ort, vitPromptEmbeddings, crop)) : null;
    vitMs += performance.now() - vitStart;
    if (vit) inferences.vitRegion += 1;
    if ((vit?.pooled?.SIGNATURE ?? 0) >= 0.3) evidence.signature = looksLikeSignature(gray);
    pending.push({ region, lines: regionLines, gray, vit, evidence, cacheKey, cached: false, confirmed: null, started });
  }

  const mayBeDocument = (c: Classified) => !c.cached && (c.vit?.pooled?.ID_DOCUMENT ?? 0) >= 0.3;
  const order = [...pending.filter(mayBeDocument), ...pending.filter((c) => !mayBeDocument(c))];
  readDeadlineAt = Math.max(deadlineAt, performance.now() + MIN_TEXT_READ_MS);
  for (const c of order) for (const l of c.lines) if (!l.read) await readLine(l);

  for (const c of pending) {
    const unread = c.lines.filter((l) => !l.read);
    const texts = c.lines.map((l) => l.read?.text ?? '').filter((t) => t.trim().length > 0);
    const hits = c.lines.flatMap((l) => lineCandidates(l, c.region.id));
    candidates.push(...hits);
    // A text line in the picture OCR could not read in time stays grey on its own.
    for (const l of unread) unanalysed.push(l.box);
    if (!c.cached) {
      c.evidence.idText = idDocumentTextEvidence(texts, hits.filter((h) => ID_ENTITIES.has(h.entity)).length);
      c.confirmed = confirmedEntity(c.vit, c.evidence);
      // Without CLIP a picture is cleared only when its pixels and text rule out what CLIP would
      // have looked for: no signature-like ink, no document wording, every line read. Otherwise
      // (or with no CLIP at all) it stays grey — it could be a document or a signature.
      const pixelsCleared = !!c.pixelsOnly && clipReady && !c.evidence.signature && !c.evidence.idText && unread.length === 0;
      if (!c.vit && !c.confirmed && !pixelsCleared) unanalysed.push(c.region.visible);
      const diagnostic: RegionDiagnostic = {
        regionId: c.region.id,
        outcome: c.vit || c.confirmed ? 'analysed' : pixelsCleared ? 'pixels' : c.pixelsOnly && clipReady ? 'budget' : 'no-capability',
        ms: performance.now() - c.started,
        faces: faces.filter((f) => insideFraction(f.box, c.region.visible) >= 0.5).length,
        ocrLinesDetected: c.lines.length,
        ocrLinesRecognized: c.lines.length - unread.length,
        ocrEntities: hits.map((h) => h.entity),
        vit: c.vit
          ? { label: c.vit.label, score: c.vit.score, accepted: !!c.confirmed, entity: c.confirmed?.entity ?? c.vit.entity ?? undefined, entityScore: c.confirmed?.score ?? c.vit.entityScore, why: c.confirmed?.why }
          : undefined,
      };
      regionDiagnostics.push(diagnostic);
      if (c.vit && unread.length === 0) regionCache.set(c.cacheKey, c.region.visible, { faces: [], ocrHits: [], vitEntity: c.confirmed?.entity ?? null, vitScore: c.confirmed?.score, diagnostic });
    }
    if (c.confirmed) candidates.push({ entity: c.confirmed.entity, box: c.region.box, score: c.confirmed.score, regionId: c.region.id, channel: 'vision', source: `vision:${c.confirmed.why}` });
  }

  // 4. Text the DOM never read: in canvases, SVG, background pictures, cross-origin frames,
  // closed shadow roots. Top to bottom, until the deadline; what is left stays grey.
  const loose = lines.filter((l) => !l.domCovered && l.region === null).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  for (const line of loose) {
    if (await readLine(line)) candidates.push(...lineCandidates(line, undefined));
    else unanalysed.push(line.box);
  }

  timings.face = faceMs;
  timings.ocr = textDetMs + recMs;
  timings.vit = vitMs;

  // design.md §4.3: the ViT encoder also embeds the full viewport on every capture, for the
  // screen-state label.
  let label: Extract<FromWorker, { t: 'perceived' }>['screenLabel'];
  let screenLabelMs = 0;
  if (msg.fullFrame) {
    const labelStart = performance.now();
    const result = await screenLabel(vitSession, ort, vitPromptEmbeddings, frame);
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
    available: { face: !!faceSession, vit: clipReady, ocr: !!ocrModels },
    inferences,
    cachedRegions,
    ms: { face: faceMs, vit: vitMs, ocr: textDetMs + recMs, screenLabel: screenLabelMs, total: performance.now() - perceiveStart },
    regions: regionDiagnostics,
    modelErrors,
    frame: {
      facePasses,
      faces: faces.length,
      linesDetected: lines.length,
      linesDomCovered: lines.filter((l) => l.domCovered).length,
      linesRecognized: recognized,
      linesUnread: lines.filter((l) => !l.domCovered && !l.read).length,
      ms: { faces: faceMs, textDet: textDetMs, textRec: recMs },
    },
  };
  const analysis: FrameAnalysis = { faces: faceStatus, text: textStatus, images: clipReady ? 'ok' : 'unavailable', unanalysed };

  // NOT closed here — `currentCapture` still owns `msg.bitmap` until `compose` (or a superseding
  // `perceive`) closes it. See the `currentCapture` doc comment above.
  post({ t: 'perceived', jobId: msg.jobId, candidates, screenLabel: label, timings, timedOut, diagnostics, analysis });
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
    clearDefault: msg.clearDefault,
    grey: msg.grey,
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
  if (performance.now() < ocrRetryAt) return null;
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
    ocrRetryAt = performance.now() + RESIDENT_RETRY_MS;
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
  const scale = msg.scale ?? 1;
  const toImage = ([x, y, w, h]: Box): Box => [x * scale, y * scale, w * scale, h * scale];

  // Every redaction box is masked solid black before anything is read, so neither the face
  // detector nor OCR sees the labels the compositor drew inside the boxes (A2: OCR read our own
  // `FACE`/`⟪AADHAAR#1⟫` labels back as "leaks", so every labelled image was dropped).
  const composed = await createImageBitmap(new Blob([msg.image], { type: 'image/webp' }));
  const masked = new OffscreenCanvas(composed.width, composed.height);
  const ctx = masked.getContext('2d')!;
  ctx.drawImage(composed, 0, 0);
  composed.close();
  ctx.fillStyle = '#000000';
  for (const box of msg.redactionBoxes) {
    const [x, y, w, h] = toImage(box);
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  }

  const hits: Extract<FromWorker, { t: 'rescanned' }>['hits'] = [];
  const faceSession = await loadResident('face');
  if (faceSession) {
    // Same whole-frame detector as `perceive`, so a face it passed over is a real miss, not a
    // difference between two detectors. Boxes back in CSS px.
    for (const face of (await detectFacesFullFrame(faceSession, ort, masked)).faces) {
      hits.push({ entity: 'FACE', box: [face.box[0] / scale, face.box[1] / scale, face.box[2] / scale, face.box[3] / scale], score: face.score });
    }
  }
  const halos = (msg.halos.length > 0 ? msg.halos : msg.redactionBoxes.map(haloAround)).map(toImage);
  const ringText = (await readHaloText(ort, await loadOcrRescanModels(), masked, halos)).map((r) => ({
    box: [r.box[0] / scale, r.box[1] / scale, r.box[2] / scale, r.box[3] / scale] as Box,
    text: r.text,
  }));

  post({ t: 'rescanned', jobId: msg.jobId, hits, ringText });
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
