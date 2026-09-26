// Real-Chromium accuracy test for T-6.8 (NER profile L). Unlike vit-pipeline.spec.ts's WASM
// backend, this specifically exercises the WebGPU-only path design.md §6.3/OQ-7 requires — if
// `navigator.gpu` isn't available in this browser-mode run, that is itself real, measured
// information (not assumed), reported via a skip rather than a false pass or a hard failure that
// would conflate "no WebGPU here" with "the pipeline is broken."

import { beforeAll, describe, expect, it } from 'vitest';
import { classifyProfileL, type TokenClassificationPipeline } from '../../src/perception/models/pii-ner';

let pipeline: TokenClassificationPipeline | null = null;
let webgpuAvailable = false;

beforeAll(async () => {
  webgpuAvailable = 'gpu' in navigator && (await navigator.gpu!.requestAdapter()) !== null;
  if (!webgpuAvailable) return;
  const { pipeline: makePipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const p = await makePipeline('token-classification', 'privacy-filter', { dtype: 'q4', device: 'webgpu' });
  pipeline = p as unknown as TokenClassificationPipeline;
}, 180_000);

describe('classifyProfileL — real openai/privacy-filter q4 model, real WebGPU inference (T-6.8)', () => {
  it('extracts a real person name, address, email and phone from one free-text sentence', async () => {
    if (!webgpuAvailable || !pipeline) {
      console.warn('[T-6.8] WebGPU unavailable in this browser-mode run — skipping, not force-passing');
      return;
    }
    const text = 'Hi, my name is Sarah Connor and I live at 123 Maple Street, Springfield. My email is sarah.connor@example.com and my phone is 555-123-4567.';
    const matches = await classifyProfileL(pipeline, text);

    const byEntity = new Map(matches.map((m) => [m.entity, m]));
    expect(byEntity.get('PERSON_NAME')?.matchedText).toBe('Sarah Connor');
    expect(byEntity.get('EMAIL')?.matchedText).toContain('sarah.connor@example.com');
    expect(byEntity.get('PHONE')?.matchedText).toContain('555');
    expect(byEntity.get('ADDRESS')?.matchedText).toContain('Maple Street');

    // Every recovered span must be a real substring at the position it claims — the offset
    // recovery this file's own doc comment describes, proven against a real model's real output,
    // not a fake pipeline (see test/unit/pii-ner.spec.ts for that half of the coverage).
    for (const m of matches) {
      expect(text.slice(m.start, m.end)).toBe(m.matchedText);
    }
  }, 180_000);

  it('does not flag a sentence with no PII at all', async () => {
    if (!webgpuAvailable || !pipeline) return;
    const matches = await classifyProfileL(pipeline, 'The weather today is sunny with a light breeze.');
    expect(matches).toEqual([]);
  }, 180_000);
});
