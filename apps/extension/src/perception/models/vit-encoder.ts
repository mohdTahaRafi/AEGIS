// design.md §6.4 / phase_4_vision.md §4.2-§4.3, T-4.5, T-4.6, T-4.7 — zero-shot ViT region
// screening and the per-capture screen-state label.
//
// [A] DISCLOSED LIMITATION, same category as `perception/models/pii-ner.ts`'s: no CLIP-family
// image encoder weights are bundled or fetchable in this sandboxed, network-restricted
// environment (T-4.3/T-4.5 need an actual `.onnx` encoder plus `tools/models/export_vit_prompts.py`
// run against a real checkpoint — the export script is written, per T-4.5, but has not been run;
// see its own header comment). This file defines the real call shape — the prompt vocabulary
// (§4.2's exact list), the cosine-similarity + temperature-softmax classification rule, and the
// per-region/per-frame entry points `worker.ts` calls — against which a real encoder is wired in
// once weights exist. `classifyRegion` and `screenLabel` both return `null` today: nothing
// downstream (fusion, the compositor's clearance rule) assumes ViT recall it doesn't have. Faces
// (`models/face.ts`, real) and DOM-derived signals carry Channel V's real detections this phase.

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
] as const;

export type PromptLabel = (typeof PROMPT_VOCABULARY)[number];

/** design.md §6.4: "Sensitive top class above threshold (0.35 for ID/card, 0.45 otherwise)." */
const SENSITIVE_LABELS = new Set<PromptLabel>(['identity card', 'Aadhaar card', 'PAN card', 'passport page', 'credit or debit card', 'handwritten signature', 'QR code', 'barcode']);

export function thresholdFor(label: PromptLabel): number {
  return SENSITIVE_LABELS.has(label) && label !== 'handwritten signature' && label !== 'QR code' && label !== 'barcode' ? 0.35 : 0.45;
}

export function isSensitiveLabel(label: PromptLabel): boolean {
  return SENSITIVE_LABELS.has(label);
}

export interface RegionClassification {
  label: PromptLabel;
  score: number;
}

/** design.md §6.4's cosine-similarity + temperature-softmax rule, factored out so it is testable
 * independent of whether a real encoder ever produces `embedding`/`promptEmbeddings`. */
export function classifyByCosine(embedding: Float32Array, promptEmbeddings: ReadonlyMap<PromptLabel, Float32Array>, temperature = 0.07): RegionClassification {
  const sims = new Map<PromptLabel, number>();
  for (const [label, vec] of promptEmbeddings) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < embedding.length; i++) {
      dot += embedding[i]! * vec[i]!;
      normA += embedding[i]! ** 2;
      normB += vec[i]! ** 2;
    }
    sims.set(label, dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1));
  }
  const exps = [...sims.entries()].map(([label, s]) => [label, Math.exp(s / temperature)] as const);
  const sum = exps.reduce((a, [, v]) => a + v, 0);
  const softmax = exps.map(([label, v]) => [label, v / sum] as const);
  const [topLabel, topScore] = softmax.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  return { label: topLabel, score: topScore };
}

/** No encoder is loaded — see this file's top-of-file doc comment. Always returns null, meaning
 * "not screened," never "screened and found nothing" (the compositor's clearance rule in
 * `compose/clearance.ts` treats a region with no ViT input as unanalysed, not cleared). */
export async function classifyRegion(_crop: ImageBitmap | OffscreenCanvas): Promise<RegionClassification | null> {
  return null;
}

/** design.md's per-capture screen-state label (§4.3) — same disclosed gap. */
export async function screenLabel(_frame: ImageBitmap | OffscreenCanvas): Promise<{ label: string; score: number } | null> {
  return null;
}
