// Real-Chromium pipeline-integrity check against the bundled model (T-4.4). This is NOT an
// accuracy test — there is no licensable face photograph reachable in this sandboxed,
// network-restricted environment to detect a real face in (see `models/face.ts`'s top-of-file
// doc comment for the full disclosure). What this proves: the actual bundled
// `face_detection_yunet_2023mar.onnx`, loaded and run through real `onnxruntime-web` WASM
// inference, produces outputs `decodeYunetOutputs` can consume without throwing, and the full
// preprocess→inference→decode→coordinate-mapping pipeline executes end-to-end.

import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { detectFaces } from '../../src/perception/models/face';
import einsteinUrl from '../fixtures/real-face-einstein-1947-pd.jpg?url';
import qrCodeUrl from '../fixtures/qr-code-sample.png?url';

describe('detectFaces — real model pipeline integrity (T-4.4)', () => {
  it('runs the bundled YuNet session on a real crop without throwing, and returns well-formed detections', async () => {
    const session = await ort.InferenceSession.create('/models/face_detection_yunet_2023mar.onnx', {
      executionProviders: ['wasm'],
    });

    const canvas = new OffscreenCanvas(300, 200);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#7a5a4a';
    ctx.fillRect(0, 0, 300, 200);
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(150, 100, 15, 20, 0, 0, Math.PI * 2); // a crude eye-like blob — not a real face
    ctx.fill();
    const bitmap = await createImageBitmap(canvas);

    const detections = await detectFaces(session, ort, bitmap, [0, 0, 300, 200]);

    // No assertion on *whether* it detects anything — a crude synthetic blob is not a real face,
    // and YuNet was never trained on one. The contract under test is structural.
    for (const d of detections) {
      expect(d.box).toHaveLength(4);
      expect(Number.isFinite(d.box[0])).toBe(true);
      expect(Number.isFinite(d.box[1])).toBe(true);
      expect(d.box[2]).toBeGreaterThan(0);
      expect(d.box[3]).toBeGreaterThan(0);
      expect(d.score).toBeGreaterThanOrEqual(0.5);
      expect(d.score).toBeLessThanOrEqual(1);
    }

    await session.release();
  });
});

// Real-photograph accuracy. Fixture: Albert Einstein, Oren Jack Turner 1947 (public domain in the
// US; Wikimedia Commons "Albert_Einstein_Head_cleaned.jpg", 250px thumbnail). Before the input
// convention was fixed (`toYunetInput`), this exact image scored 0.054 — no face was ever found in
// a real page, and the compositor then cleared and SENT the unredacted face region.
describe('detectFaces — real photograph accuracy', () => {
  async function bitmapFrom(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    return createImageBitmap(await response.blob());
  }

  it('finds the face in a real portrait, inside the face area, well above the score floor', async () => {
    const session = await ort.InferenceSession.create('/models/face_detection_yunet_2023mar.onnx', { executionProviders: ['wasm'] });
    const bitmap = await bitmapFrom(einsteinUrl);
    const detections = await detectFaces(session, ort, bitmap, [100, 50, bitmap.width, bitmap.height]);
    expect(detections.length).toBeGreaterThanOrEqual(1);
    const best = detections.reduce((a, b) => (b.score > a.score ? b : a));
    expect(best.score).toBeGreaterThan(0.8);
    // Box is mapped into the given source offset and lies within the image, over its upper half.
    const [x, y, w, h] = best.box;
    expect(x).toBeGreaterThanOrEqual(100 - w * 0.1);
    expect(y).toBeGreaterThanOrEqual(50 - h * 0.1);
    expect(x + w).toBeLessThanOrEqual(100 + bitmap.width + w * 0.1);
    expect(y + h / 2).toBeLessThan(50 + bitmap.height * 0.7);
    await session.release();
  });

  it('does not report a face in a QR code (no false positive from the fix)', async () => {
    const session = await ort.InferenceSession.create('/models/face_detection_yunet_2023mar.onnx', { executionProviders: ['wasm'] });
    const bitmap = await bitmapFrom(qrCodeUrl);
    expect(await detectFaces(session, ort, bitmap, [0, 0, bitmap.width, bitmap.height])).toEqual([]);
    await session.release();
  });
});
