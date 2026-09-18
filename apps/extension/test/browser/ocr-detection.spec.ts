// Real-Chromium test for T-6.5/T-6.6's detection-side OCR pass (`perception/detect/text-region.ts`)
// — the first real consumer that finds NEW PII in a region the DOM never explained, as opposed to
// `rescan/halo.ts`'s post-compose safety net (T-4.18), which only re-checks pixels already
// decided to be redacted. Mirrors the real eval corpus's own canvas fixture shape
// (`eval/src/aegis_eval/corpus/generate_fixtures.py`'s `build_canvas`): a label line carrying no
// PII and a second line carrying the actual value, both drawn via a real <canvas> 2D context.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { verhoeffGenerate } from '@aegis/recognizers';
import { detectTextEntitiesInRegion } from '../../src/perception/detect/text-region';
import { buildCtcVocabulary } from '../../src/perception/models/ocr-rec';
import type { OcrRescanModels } from '../../src/perception/rescan/halo';

async function loadDictLines(path: string): Promise<string[]> {
  const res = await fetch(path);
  const text = await res.text();
  return text.split('\n').filter((line) => line.length > 0);
}

// A larger, more OCR-legible font than the real corpus fixture's 16px — this test verifies the
// wiring (region → lines → entities → page-coordinate boxes), not the corpus fixture's own OCR
// legibility at its exact font size, which is a separate, already-open harness-level question.
function renderCanvasRegion(labelText: string, valueText: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(400, 200);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = '20px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(labelText, 20, 30);
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(valueText, 20, 80);
  return canvas;
}

function validAadhaar(): string {
  const body = '23456789012'; // 11 digits, first digit 2–9 (design.md §6.2's pattern)
  return body + verhoeffGenerate(body);
}

describe('detectTextEntitiesInRegion — OCR detection-side pass (T-6.5/T-6.6)', () => {
  let models: OcrRescanModels;

  beforeAll(async () => {
    const detSession = await ort.InferenceSession.create('/models/ocr_det_ppocrv5_mobile.onnx', { executionProviders: ['wasm'] });
    const recSession = await ort.InferenceSession.create('/models/ocr_rec_ppocrv5_mobile_en.onnx', { executionProviders: ['wasm'] });
    const vocabulary = buildCtcVocabulary(await loadDictLines('/models/ocr_rec_ppocrv5_mobile_en.dict.txt'));
    models = { detSession, recSession, vocabulary };
  }, 30000);

  afterAll(async () => {
    await models.detSession.release();
    await models.recSession.release();
  });

  it('finds a real Aadhaar number rendered into a canvas the DOM never explained, translated into page coordinates', async () => {
    const aadhaar = validAadhaar();
    const region = renderCanvasRegion('Aadhaar on file:', aadhaar);

    // The canvas element's own page position — same convention `detectFaces`'s `sourceBox` uses.
    const sourceBox: [number, number, number, number] = [20, 80, 400, 200];
    const candidates = await detectTextEntitiesInRegion(ort, models, region, 'canvas-node-1', sourceBox);

    const hits = candidates.filter((c) => c.entity === 'AADHAAR');
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect(hit.channel).toBe('text-ocr');
    expect(hit.regionId).toBe('canvas-node-1');
    expect(hit.source).toBe('pattern:aadhaar+verhoeff');
    expect(hit.value).toContain(aadhaar);

    // Design.md §7.1 step 8: no character-position mapping exists, so the box is the whole
    // detected line, translated by the region's own page offset — never left in crop-local space.
    expect(hit.box[0]).toBeGreaterThanOrEqual(sourceBox[0]);
    expect(hit.box[1]).toBeGreaterThanOrEqual(sourceBox[1]);
    expect(hit.box[1]).toBeLessThan(sourceBox[1] + sourceBox[3]);

    // The label line ("Aadhaar on file:") carries no PII pattern and must not itself produce a
    // candidate of some other entity type.
    expect(candidates.every((c) => c.entity === 'AADHAAR')).toBe(true);
  });

  it('finds nothing in a canvas region with no PII-shaped text', async () => {
    const region = renderCanvasRegion('Just a caption', 'Nothing sensitive in here');
    const candidates = await detectTextEntitiesInRegion(ort, models, region, 'canvas-node-2', [0, 0, 400, 200]);
    expect(candidates).toHaveLength(0);
  });

  it('finds nothing on a blank canvas region', async () => {
    const blank = new OffscreenCanvas(200, 100);
    blank.getContext('2d')!.fillRect(0, 0, 200, 100);
    const candidates = await detectTextEntitiesInRegion(ort, models, blank, 'canvas-node-3', [0, 0, 200, 100]);
    expect(candidates).toHaveLength(0);
  });
});
