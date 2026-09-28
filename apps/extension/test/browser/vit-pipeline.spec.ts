// Real-Chromium accuracy test for T-4.5/T-4.6 (zero-shot ViT region screening). Unlike the face
// detector (no licensable face photo reachable in this sandbox — see `face-pipeline.spec.ts`'s
// own disclosure), a QR code has no licensing barrier: it's rendered from this project's own test
// data via the `qrcode` Python library (`tools/models/` — see `test/fixtures/qr-code-sample.png`).
// This proves real accuracy, not just structural well-formedness: the bundled int8 CLIP vision
// encoder plus the precomputed prompt embeddings correctly classify a genuine QR code as top-1
// "QR code" above its sensitive threshold, and a plain background as top-1 "plain background"
// (never triggering a region candidate) — cross-checked against the same result already verified
// independently in Python (`onnxruntime` against both the fp32 and int8 exports) during export,
// see docs/HISTORY.md's 2026-09-25 T-4.5/T-4.6 entry.

import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import qrCodeUrl from '../fixtures/qr-code-sample.png?url';
import { acceptedEntity, classifyRegion, entityForLabel, isSensitiveLabel, parsePromptEmbeddings } from '../../src/perception/models/vit-encoder';
import einsteinUrl from '../fixtures/real-face-einstein-1947-pd.jpg?url';

async function loadBitmapFromUrl(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function solidColorCanvas(w: number, h: number, color: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return canvas;
}

describe('classifyRegion — real model pipeline accuracy (T-4.5/T-4.6)', () => {
  it('classifies a real QR code image as top-1 "QR code" (real, measured — not asserted against design.md\'s threshold)', async () => {
    const session = await ort.InferenceSession.create('/models/vit-vision.onnx', { executionProviders: ['wasm'] });
    const promptRes = await fetch('/models/vit-prompts.bin');
    const promptEmbeddings = parsePromptEmbeddings(await promptRes.arrayBuffer());

    const bitmap = await loadBitmapFromUrl(qrCodeUrl);
    const result = await classifyRegion(session, ort, promptEmbeddings, bitmap);

    expect(result).not.toBeNull();
    expect(result!.label).toBe('QR code');
    expect(isSensitiveLabel(result!.label)).toBe(true);
    expect(entityForLabel(result!.label)).toBe('QR_CODE');
    // Until 2026-09-28 this scored ~0.21 — below its 0.45 threshold, so a real QR code was never
    // redacted by CLIP. Cause: temperature 0.07 instead of CLIP's trained 0.01, and a single
    // "a photo of a {label}" template (see vit-encoder.ts's CLIP_TEMPERATURE / docs/HISTORY.md).
    expect(acceptedEntity(result!)).toBe('QR_CODE');
    expect(result!.entityScore).toBeGreaterThanOrEqual(0.45);

    await session.release();
  });

  it('classifies a plain-color region as top-1 "plain background", never a sensitive entity', async () => {
    const session = await ort.InferenceSession.create('/models/vit-vision.onnx', { executionProviders: ['wasm'] });
    const promptRes = await fetch('/models/vit-prompts.bin');
    const promptEmbeddings = parsePromptEmbeddings(await promptRes.arrayBuffer());

    const canvas = solidColorCanvas(224, 224, '#788ca0');
    const result = await classifyRegion(session, ort, promptEmbeddings, canvas);

    expect(result).not.toBeNull();
    expect(result!.label).toBe('plain background');
    expect(isSensitiveLabel(result!.label)).toBe(false);
    expect(entityForLabel(result!.label)).toBeNull();

    await session.release();
  });

  it('a real portrait photo is not taken for an ID document, QR code or signature (YuNet owns faces)', async () => {
    const session = await ort.InferenceSession.create('/models/vit-vision.onnx', { executionProviders: ['wasm'] });
    const promptEmbeddings = parsePromptEmbeddings(await (await fetch('/models/vit-prompts.bin')).arrayBuffer());
    const result = await classifyRegion(session, ort, promptEmbeddings, await loadBitmapFromUrl(einsteinUrl));
    expect(result).not.toBeNull();
    expect(acceptedEntity(result!)).toBeNull();
    await session.release();
  });

  it('fails closed (returns null) when the session or prompt embeddings are unavailable', async () => {
    const canvas = solidColorCanvas(224, 224, '#788ca0');
    expect(await classifyRegion(null, ort, null, canvas)).toBeNull();

    const session = await ort.InferenceSession.create('/models/vit-vision.onnx', { executionProviders: ['wasm'] });
    expect(await classifyRegion(session, ort, null, canvas)).toBeNull();
    await session.release();
  });
});
