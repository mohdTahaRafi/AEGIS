// Real-Chromium test for the halo re-scan's OCR half (T-6.3, design.md §7.6 step 5 / phase_4_vision.md
// §8), wired for real this phase — `checkHalosForText` was a permanent stub (always `[]`) through
// Phases 4-5 with no OCR model to back it. This is the first test this function has ever had: its
// stub behaviour never needed one (an unconditional `[]` can't be wrong), but real logic can be.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as ort from 'onnxruntime-web';
import { checkHalosForText, haloAround, type OcrRescanModels } from '../../src/perception/rescan/halo';
import { buildCtcVocabulary } from '../../src/perception/models/ocr-rec';
import { encodeWebp } from '../../src/perception/compose/compositor';

async function loadDictLines(path: string): Promise<string[]> {
  const res = await fetch(path);
  const text = await res.text();
  return text.split('\n').filter((line) => line.length > 0);
}

describe('checkHalosForText — real OCR halo re-scan (T-6.3)', () => {
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

  it('finds readable text left behind inside a redaction halo — a real insufficient-redaction catch', async () => {
    // design.md §7.6 step 5's actual scenario: dilation covers MOST of a value but a sliver of it
    // survives right at the redaction box's own edge (not a whole separate word sitting well
    // outside it — a realistic-sized halo, HALO_PX=24, would never reach that far past a value
    // this font size). Draw a full value first, then an undersized grey box over most (not all)
    // of it, leaving its last couple of characters exposed by a few pixels — exactly what
    // "insufficient dilation" looks like.
    const canvas = new OffscreenCanvas(400, 200);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 24px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('SECRET123', 50, 50);
    const textWidth = ctx.measureText('SECRET123').width;

    const redactionBox: [number, number, number, number] = [50, 50, textWidth - 15, 30]; // covers all but the trailing ~15px ("3")
    ctx.fillStyle = '#808080';
    ctx.fillRect(...redactionBox);

    const webpBytes = await encodeWebp(canvas);
    const halo = haloAround(redactionBox);

    const hits = await checkHalosForText(ort, models, webpBytes, [halo]);

    expect(hits.length).toBeGreaterThan(0);
  });

  it('finds nothing in a halo over a clean, fully-redacted region', async () => {
    const canvas = new OffscreenCanvas(400, 200);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 200);
    const redactionBox: [number, number, number, number] = [50, 50, 100, 40];
    ctx.fillStyle = '#808080';
    ctx.fillRect(...redactionBox);
    // No leftover text anywhere near this box this time.

    const webpBytes = await encodeWebp(canvas);
    const halo = haloAround(redactionBox);

    const hits = await checkHalosForText(ort, models, webpBytes, [halo]);

    expect(hits).toHaveLength(0);
  });

  it('returns no hits when passed no OCR models (a graceful, disclosed degradation, not a throw)', async () => {
    const canvas = new OffscreenCanvas(100, 100);
    canvas.getContext('2d')!.fillRect(0, 0, 100, 100);
    const webpBytes = await encodeWebp(canvas);

    const hits = await checkHalosForText(ort, null, webpBytes, [[0, 0, 100, 100]]);

    expect(hits).toHaveLength(0);
  });
});
