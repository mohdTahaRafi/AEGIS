// CLIP region decision: trained temperature (0.01) and per-entity probability pooling. Regression
// for the 2026-09-28 finding that the old temperature (0.07) + top-1 rule accepted 0/69 real
// sensitive images (docs/HISTORY.md).
import { describe, expect, it } from 'vitest';
import { acceptedEntity, classifyByCosine, CLIP_TEMPERATURE, PROMPT_VOCABULARY, type PromptLabel } from '../../src/perception/models/vit-encoder';

// One orthonormal axis per label plus one padding axis, so a unit test embedding's cosine to each
// label is exactly its weight — realistic CLIP magnitudes (image-text cosines of ~0.2-0.3).
const DIM = PROMPT_VOCABULARY.length + 1;
const PROMPTS = new Map<PromptLabel, Float32Array>(PROMPT_VOCABULARY.map((label, i) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return [label, v];
}));

function embeddingWith(weights: Partial<Record<PromptLabel, number>>, base = 0.2): Float32Array {
  const v = new Float32Array(DIM).fill(base);
  for (const [label, w] of Object.entries(weights)) v[PROMPT_VOCABULARY.indexOf(label as PromptLabel)] = w;
  let sq = 0;
  for (let i = 0; i < DIM - 1; i++) sq += v[i]! ** 2;
  v[DIM - 1] = Math.sqrt(1 - sq);
  return v;
}

describe('classifyByCosine', () => {
  it('defaults to CLIP ViT-B/32\'s trained temperature 0.01', () => {
    expect(CLIP_TEMPERATURE).toBe(0.01);
  });

  it('pools sub-labels of one entity: an Aadhaar sample split across ID labels is still an ID document', () => {
    // Top-1 is "photo of a person" (the card holder's photo), but the three ID labels together
    // carry most of the probability.
    const r = classifyByCosine(embeddingWith({ 'photo of a person': 0.26, 'Aadhaar card': 0.255, 'identity card': 0.255, 'PAN card': 0.25 }), PROMPTS);
    expect(r.label).toBe('photo of a person');
    expect(r.entity).toBe('ID_DOCUMENT');
    expect(r.entityScore).toBeGreaterThan(0.35);
    expect(acceptedEntity(r)).toBe('ID_DOCUMENT');
  });

  it('a clear QR code is accepted as QR_CODE', () => {
    const r = classifyByCosine(embeddingWith({ 'QR code': 0.3 }), PROMPTS);
    expect(r.label).toBe('QR code');
    expect(acceptedEntity(r)).toBe('QR_CODE');
  });

  it('an ordinary photo lands on a non-sensitive label and is not accepted', () => {
    const r = classifyByCosine(embeddingWith({ 'landscape or scene': 0.3 }), PROMPTS);
    expect(r.label).toBe('landscape or scene');
    expect(acceptedEntity(r)).toBeNull();
  });

  it('an ambiguous crop (no label stands out) is not accepted', () => {
    const r = classifyByCosine(embeddingWith({}), PROMPTS);
    expect(acceptedEntity(r)).toBeNull();
  });

  it('the old temperature 0.07 flattens the same QR code below its threshold (the bug this fixes)', () => {
    const r = classifyByCosine(embeddingWith({ 'QR code': 0.3 }), PROMPTS, 0.07);
    expect(acceptedEntity(r)).toBeNull();
  });
});
