// design.md §6.4 / phase_4_vision.md §4.2-§4.3, T-4.5, T-4.6, T-4.7 — zero-shot ViT region
// screening and the per-capture screen-state label.
//
// [Resolved 2026-09-25, see docs/HISTORY.md] The disclosed gap this file used to carry (no
// CLIP-family weights reachable) is closed: `tools/models/export_vit_vision.py` (new) exports
// open_clip's `ViT-B-32-quickgelu`/`openai` vision tower to ONNX, L2-normalizing its own output;
// `tools/models/quantize.py` (already written, now run for real) int8-quantizes it
// (351,604,555 → 88,687,890 bytes). `tools/models/export_vit_prompts.py` (already written, now
// run for real) produces the paired 15-label text-prompt embeddings. Both verified end to end on a
// real generated QR-code image and a plain-color control — int8 and fp32 agree on top-1 for both
// (QR code / plain background) with near-identical softmax scores — before shipping the int8
// variant; see `models.manifest.json`'s `vit-vision-clip-b32`/`vit-prompts-b32` entries for the
// full account, including the disclosed regeneration caveat (no fixed download URL — this is a
// generated, not fetched, artifact).
//
// Preprocessing uses `preprocess/letterbox.ts`'s square-pad transform (not CLIP's original
// resize-then-center-crop) — a deliberate consistency choice with this codebase's face detector,
// which already uses the same "fit inside a square, pad the rest" convention for its own fixed
// input rather than introducing a second resize convention; `letterbox.ts`'s own doc comment
// already anticipated this.

import type * as ort from 'onnxruntime-web';
import { letterbox, toCHWFloat32 } from '../preprocess/letterbox';

export const PROMPT_VOCABULARY = [
  'identity card',
  'Aadhaar card',
  'PAN card',
  'passport page',
  'credit or debit card',
  'handwritten signature',
  'QR code',
  'barcode',
  'photo of a person',
  'document page with text',
  'login form',
  'chart',
  'logo',
  'icon',
  'plain background',
  // 2026-09-28: "everything else" labels. Never sensitive — they exist so an ordinary photo has a
  // correct place to put its probability mass instead of being forced onto a sensitive label.
  'landscape or scene',
  'painting or illustration',
  'everyday object, food or animal',
  'map',
  'website screenshot',
] as const;

export type PromptLabel = (typeof PROMPT_VOCABULARY)[number];

/** design.md §6.4: "Sensitive top class above threshold (0.35 for ID/card, 0.45 otherwise)." Per
 * label; the region decision itself uses the pooled `entityThreshold`/`acceptedEntity` below. */
const SENSITIVE_LABELS = new Set<PromptLabel>(['identity card', 'Aadhaar card', 'PAN card', 'passport page', 'credit or debit card', 'handwritten signature', 'QR code', 'barcode']);

export function thresholdFor(label: PromptLabel): number {
  return SENSITIVE_LABELS.has(label) && label !== 'handwritten signature' && label !== 'QR code' && label !== 'barcode' ? 0.35 : 0.45;
}

export function isSensitiveLabel(label: PromptLabel): boolean {
  return SENSITIVE_LABELS.has(label);
}

/** [A] design.md §6.4 says a sensitive top class "emit[s] a whole-region candidate" but does not
 * name which `EntityType` — resolved here against the visual entity group metric 2's own scorer
 * already tracks (`{FACE, ID_DOCUMENT, QR_CODE, SIGNATURE}`, confirmed in real scoreboards): the
 * card/document-image labels collapse to `ID_DOCUMENT` (no dedicated `AADHAAR_CARD_IMAGE`/
 * `PAN_CARD_IMAGE` entity exists — Channel D/T's text-based AADHAAR/PAN recognizers already own
 * the digit/alphanumeric-string case), `handwritten signature` maps to `SIGNATURE`, and `QR code`/
 * `barcode` both map to `QR_CODE` (no separate `BARCODE` entity exists in the closed enum).
 * `photo of a person` is deliberately absent — the real YuNet face detector already owns FACE. */
export function entityForLabel(label: PromptLabel): VisionEntity | null {
  switch (label) {
    case 'identity card':
    case 'Aadhaar card':
    case 'PAN card':
    case 'passport page':
    case 'credit or debit card':
      return 'ID_DOCUMENT';
    case 'handwritten signature':
      return 'SIGNATURE';
    case 'QR code':
    case 'barcode':
      return 'QR_CODE';
    default:
      return null;
  }
}

export type VisionEntity = 'ID_DOCUMENT' | 'SIGNATURE' | 'QR_CODE';

export interface RegionClassification {
  /** Top-1 label and its softmax probability — what the diagnostics display. */
  label: PromptLabel;
  score: number;
  /** The sensitive entity with the highest pooled probability (sum over every label mapping to it
   * — e.g. "Aadhaar card" + "identity card" + "passport page" all count toward ID_DOCUMENT), and
   * that pooled probability. `null` only when no sensitive label exists in the prompt set. */
  entity: VisionEntity | null;
  entityScore: number;
  /** Pooled probability of every sensitive entity (sum over the labels mapping to it). */
  pooled?: Partial<Record<VisionEntity, number>>;
}

/** CLIP ViT-B/32's own trained logit scale is exp(4.6052) = 100, i.e. temperature 0.01 — the value
 * its image/text embeddings were contrastively trained against. The previous 0.07 (CLIP's
 * *initial* temperature before training) flattened the softmax so far that nothing ever cleared
 * the thresholds below: 0/69 real sensitive images accepted in the 2026-09-28 evaluation (see
 * `tools/models/export_vit_prompts.py`'s PROMPT_ENSEMBLES comment and docs/HISTORY.md). */
export const CLIP_TEMPERATURE = 0.01;

/** Pooled per-entity acceptance: sub-labels of one entity split its probability between them (an
 * Aadhaar sample scores on "Aadhaar card", "identity card" and "PAN card" at once), so taking only
 * the top-1 label under-counts exactly the images that most clearly are an ID document. */
export function acceptedEntity(result: RegionClassification): VisionEntity | null {
  return result.entity !== null && result.entityScore >= entityThreshold(result.entity) ? result.entity : null;
}

/** design.md §6.4's thresholds (0.35 for ID/card, 0.45 otherwise), applied to the pooled score. */
export function entityThreshold(entity: VisionEntity): number {
  return entity === 'ID_DOCUMENT' ? 0.35 : 0.45;
}

/** design.md §6.4's cosine-similarity + temperature-softmax rule, factored out so it is testable
 * independent of whether a real encoder ever produces `embedding`/`promptEmbeddings`. */
export function classifyByCosine(embedding: Float32Array, promptEmbeddings: ReadonlyMap<PromptLabel, Float32Array>, temperature = CLIP_TEMPERATURE): RegionClassification {
  const sims: [PromptLabel, number][] = [];
  for (const [label, vec] of promptEmbeddings) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < embedding.length; i++) {
      dot += embedding[i]! * vec[i]!;
      normA += embedding[i]! ** 2;
      normB += vec[i]! ** 2;
    }
    sims.push([label, dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)]);
  }
  // Standard max-shift for a numerically stable softmax (at temperature 0.01 the exponents are 100x
  // the cosines).
  const maxSim = Math.max(...sims.map(([, s]) => s));
  const exps = sims.map(([label, s]) => [label, Math.exp((s - maxSim) / temperature)] as const);
  const sum = exps.reduce((a, [, v]) => a + v, 0);
  const softmax = exps.map(([label, v]) => [label, v / sum] as const);
  const [topLabel, topScore] = softmax.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  const pooled = new Map<VisionEntity, number>();
  for (const [label, p] of softmax) {
    const entity = entityForLabel(label);
    if (entity) pooled.set(entity, (pooled.get(entity) ?? 0) + p);
  }
  let entity: VisionEntity | null = null;
  let entityScore = 0;
  for (const [e, p] of pooled) {
    if (p > entityScore) {
      entity = e;
      entityScore = p;
    }
  }
  return { label: topLabel, score: topScore, entity, entityScore, pooled: Object.fromEntries(pooled) };
}

/** What the pixels themselves show, independent of CLIP (perception/detect/verify.ts). */
export interface RegionEvidence {
  qr: boolean;
  barcode: boolean;
  signature: boolean;
  /** OCR read identity-document wording or an ID number inside the region. */
  idText: boolean;
  /** A face was detected inside the region. */
  face: boolean;
  /** Text lines detected inside the region. */
  lines: number;
  /** width / height of the region on screen. */
  aspect: number;
}

/** CLIP's zero-shot label alone is not enough to black out an image: on real pages it scored a
 * charger photo as a QR code and banners as ID documents. A region is redacted as a sensitive
 * entity only when the pixels agree — a QR code's finder patterns or a barcode's bars (conclusive
 * on their own), a signature's ink strokes, or an ID document's own text/face-and-card layout. */
export function confirmedEntity(result: RegionClassification | null, ev: RegionEvidence): { entity: VisionEntity; score: number; why: string } | null {
  if (ev.qr) return { entity: 'QR_CODE', score: 0.95, why: 'qr-finder-patterns' };
  if (ev.barcode) return { entity: 'QR_CODE', score: 0.9, why: 'barcode-bars' };
  if (!result) return ev.idText && ev.face ? { entity: 'ID_DOCUMENT', score: 0.8, why: 'id-text+face' } : null;
  const pooled = result.pooled ?? (result.entity ? { [result.entity]: result.entityScore } : {});
  const id = pooled.ID_DOCUMENT ?? 0;
  const sig = pooled.SIGNATURE ?? 0;
  const cardShaped = ev.aspect >= 1.2 && ev.aspect <= 1.95;
  if (id >= entityThreshold('ID_DOCUMENT')) {
    if (ev.idText) return { entity: 'ID_DOCUMENT', score: Math.max(id, 0.8), why: 'clip+id-text' };
    // A portrait on an advert banner is also a face with text: only a card/page-shaped (landscape)
    // region with a face and text on it counts (Amazon's hero banner, 2026-09-29).
    if (ev.face && ev.lines >= 2 && cardShaped && id >= 0.5) return { entity: 'ID_DOCUMENT', score: Math.max(id, 0.7), why: 'clip+face+text' };
    if (id >= 0.7 && ev.lines >= 3 && cardShaped) return { entity: 'ID_DOCUMENT', score: id, why: 'clip+card-layout' };
  } else if (ev.idText && ev.face && cardShaped) {
    return { entity: 'ID_DOCUMENT', score: 0.75, why: 'id-text+face+card' };
  }
  if (sig >= 0.3 && ev.signature) return { entity: 'SIGNATURE', score: Math.max(sig, 0.6), why: 'clip+ink-strokes' };
  return null;
}

const CLIP_INPUT_SIZE = 224;
// CLIP's own published per-channel normalization (open_clip's `ViT-B-32-quickgelu`/`openai`
// preprocess transform, confirmed by inspecting it directly during export — see this file's
// top-of-file comment). `toCHWFloat32` already gives [0,1]-scaled RGB planes; this rescales each
// plane to CLIP's expected distribution.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

function normalizeForClip(chw: Float32Array): Float32Array {
  const plane = chw.length / 3;
  const out = new Float32Array(chw.length);
  for (let c = 0; c < 3; c++) {
    const mean = CLIP_MEAN[c]!;
    const std = CLIP_STD[c]!;
    const base = c * plane;
    for (let i = 0; i < plane; i++) {
      out[base + i] = (chw[base + i]! - mean) / std;
    }
  }
  return out;
}

/** Binary format `export_vit_prompts.py` writes (magic `AEGISVPB1`): label count + embedding dim,
 * then each label's UTF-8 bytes length-prefixed, then the raw float32 embedding matrix — see that
 * script's own header comment for the exact layout this must stay byte-for-byte matched to. */
export function parsePromptEmbeddings(buffer: ArrayBuffer): ReadonlyMap<PromptLabel, Float32Array> {
  const view = new DataView(buffer);
  let offset = 0;
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 9));
  if (magic !== 'AEGISVPB1') throw new Error(`vit-prompts.bin: bad magic ${magic}`);
  offset += 9;
  const count = view.getUint32(offset, true);
  offset += 4;
  const dim = view.getUint32(offset, true);
  offset += 4;
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(offset, true);
    offset += 2;
    labels.push(new TextDecoder().decode(new Uint8Array(buffer, offset, len)));
    offset += len;
  }
  // `Float32Array`'s (buffer, byteOffset, length) constructor requires byteOffset to be a
  // multiple of 4 — real bug, found by this file's own browser test: the header's variable-length
  // label strings don't guarantee that alignment. `slice` copies from `offset` into a fresh,
  // zero-based (therefore always-aligned) buffer rather than requiring the caller to pad the
  // on-disk format to a 4-byte boundary.
  const matrix = new Float32Array(buffer.slice(offset));
  const out = new Map<PromptLabel, Float32Array>();
  for (let i = 0; i < count; i++) {
    out.set(labels[i] as PromptLabel, matrix.subarray(i * dim, (i + 1) * dim));
  }
  return out;
}

// CLIP's mean colour: after normalization the padding is exactly zero, i.e. carries no signal,
// where black padding reads as a dark frame around every non-square crop.
const CLIP_PAD = '#7B7568';

async function embed(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas): Promise<Float32Array> {
  const lb = letterbox(crop, CLIP_INPUT_SIZE, CLIP_PAD);
  const chw = normalizeForClip(toCHWFloat32(lb.canvas));
  const tensor = new ort_.Tensor('float32', chw, [1, 3, CLIP_INPUT_SIZE, CLIP_INPUT_SIZE]);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('vit-vision model exposes no input names');
  const results = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0]!;
  return results[outputName]!.data as Float32Array;
}

/** design.md §6.4's zero-shot region screener, real end to end: embeds `crop` with the bundled
 * int8 CLIP vision encoder, compares against the precomputed prompt vectors via `classifyByCosine`.
 * Still returns `null` on any real failure (missing session/prompts, a thrown inference error) —
 * the compositor's clearance rule treats that as "unanalysed," never "cleared," so a model or
 * runtime failure fails closed exactly as it did when this was an intentional stub. */
export async function classifyRegion(
  session: ort.InferenceSession | null,
  ort_: typeof ort,
  promptEmbeddings: ReadonlyMap<PromptLabel, Float32Array> | null,
  crop: ImageBitmap | OffscreenCanvas,
): Promise<RegionClassification | null> {
  if (!session || !promptEmbeddings || promptEmbeddings.size === 0) return null;
  try {
    const embedding = await embed(session, ort_, crop);
    return classifyByCosine(embedding, promptEmbeddings);
  } catch {
    return null;
  }
}

/** design.md's per-capture screen-state label (§4.3): the same embed+cosine call over the whole
 * captured frame rather than one region, reusing the identical top-1 label/score shape. */
export async function screenLabel(
  session: ort.InferenceSession | null,
  ort_: typeof ort,
  promptEmbeddings: ReadonlyMap<PromptLabel, Float32Array> | null,
  frame: ImageBitmap | OffscreenCanvas,
): Promise<{ label: string; score: number } | null> {
  const result = await classifyRegion(session, ort_, promptEmbeddings, frame);
  return result ? { label: result.label, score: result.score } : null;
}
