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
