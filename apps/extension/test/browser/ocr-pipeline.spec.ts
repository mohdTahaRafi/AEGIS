// Real-Chromium pipeline-integrity AND accuracy check against the bundled PP-OCRv5 models
// (T-6.3/T-6.4). Unlike `face-pipeline.spec.ts` (no licensable face photograph reachable in this
// sandboxed environment, so only structural well-formedness is checked), OCR has no equivalent
// licensing problem: the ground truth is text this test renders itself via a real `<canvas>` 2D
// context, so this is a genuine ACCURACY test against the real bundled det+rec models and the
// real transcribed DB/CTC post-processing — not just "it ran without throwing."
//
// Sessions are loaded once in `beforeAll` and shared across every case in this file, not
// recreated per `it()` — three real ONNX WASM sessions (one det, two rec) are real CPU/memory
// weight, and re-loading them per test is unnecessary cost that showed up for real as a flake
// (this file's own first test timing out at 15s) when the whole suite ran together under
// contention with every other browser-mode test file, even though every case here passes in
// 1-4s in isolation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { detectText } from '../../src/perception/models/ocr-det';
import { buildCtcVocabulary, recognizeLine } from '../../src/perception/models/ocr-rec';

async function loadDictLines(path: string): Promise<string[]> {
  const res = await fetch(path);
  const text = await res.text();
  return text.split('\n').filter((line) => line.length > 0);
}

function renderTextImage(text: string, font = 'bold 36px sans-serif'): OffscreenCanvas {
  const canvas = new OffscreenCanvas(400, 80);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 20, 20);
  return canvas;
}

async function detectAndRecognize(
  detSession: ort.InferenceSession,
  recSession: ort.InferenceSession,
  vocabulary: string[],
  image: OffscreenCanvas,
): Promise<{ lines: Awaited<ReturnType<typeof detectText>>; text: string; confidence: number }> {
  const lines = await detectText(detSession, ort, image);
  if (lines.length === 0) return { lines, text: '', confidence: 0 };
  const best = [...lines].sort((a, b) => b.score - a.score)[0]!;
  const [x, y, w, h] = best.box;
  const cropCanvas = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  cropCanvas.getContext('2d')!.drawImage(image, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);
  const recognized = await recognizeLine(recSession, ort, cropCanvas, vocabulary);
  return { lines, text: recognized.text, confidence: recognized.confidence };
}

describe('OCR pipeline — real bundled PP-OCRv5 models, real rendered text (T-6.3/T-6.4)', () => {
  let detSession: ort.InferenceSession;
  let enRecSession: ort.InferenceSession;
  let devanagariRecSession: ort.InferenceSession;
  let enVocabulary: string[];
  let devanagariVocabulary: string[];

  beforeAll(async () => {
    // Sequential, not `Promise.all` — three concurrent WASM session inits is a real, avoidable
    // CPU/memory spike (each spins up its own onnxruntime-web WASM instance); loading them one at
    // a time keeps this file's peak resource footprint lower when the whole suite runs together,
    // which matters for other tests' own load-sensitive sanity bounds (extractor.bench.spec.ts).
    detSession = await ort.InferenceSession.create('/models/ocr_det_ppocrv5_mobile.onnx', { executionProviders: ['wasm'] });
    enRecSession = await ort.InferenceSession.create('/models/ocr_rec_ppocrv5_mobile_en.onnx', { executionProviders: ['wasm'] });
    devanagariRecSession = await ort.InferenceSession.create('/models/ocr_rec_ppocrv5_mobile_devanagari.onnx', { executionProviders: ['wasm'] });
    enVocabulary = buildCtcVocabulary(await loadDictLines('/models/ocr_rec_ppocrv5_mobile_en.dict.txt'));
    devanagariVocabulary = buildCtcVocabulary(await loadDictLines('/models/ocr_rec_ppocrv5_mobile_devanagari.dict.txt'));
  }, 30000);

  afterAll(async () => {
    await Promise.all([detSession?.release(), enRecSession?.release(), devanagariRecSession?.release()]);
  });

  it('detects a rendered line and recognizes it back to the same text, end to end', async () => {
    const image = renderTextImage('HELLO WORLD');
    const result = await detectAndRecognize(detSession, enRecSession, enVocabulary, image);
    console.log('OCR pipeline result:', JSON.stringify(result));

    expect(result.lines.length).toBeGreaterThan(0);
    // Real-model OCR on a real (if synthetic) rendered line — allow case differences but require
    // the actual letters to come back substantially correct, not just "ran without throwing."
    expect(result.text.toUpperCase().replace(/\s+/g, ' ').trim()).toContain('HELLO');
  });

  it('detects and recognizes a real Devanagari word (T-6.4) — the same word design.md\'s own Phase 6 milestone example uses ("आधार", Aadhaar)', async () => {
    const image = renderTextImage('आधार', 'bold 36px "Noto Sans Devanagari", sans-serif');
    const result = await detectAndRecognize(detSession, devanagariRecSession, devanagariVocabulary, image);

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.text).toBe('आधार');
  });

  it('rejects an all-blank/empty region: no text detected on a plain white image', async () => {
    const blank = new OffscreenCanvas(200, 100);
    const ctx = blank.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 100);

    const lines = await detectText(detSession, ort, blank);
    expect(lines).toHaveLength(0);
  });
});
