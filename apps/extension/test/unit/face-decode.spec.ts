import { describe, expect, it } from 'vitest';
import { decodeYunetOutputs, type StrideOutputs } from '../../src/perception/models/face';

const INPUT_SIZE = 640;

function emptyStride(stride: number): StrideOutputs {
  const cells = (INPUT_SIZE / stride) ** 2;
  return { stride, cls: new Float32Array(cells), obj: new Float32Array(cells), bbox: new Float32Array(cells * 4) };
}

function plantDetection(out: StrideOutputs, row: number, col: number, cols: number, score = 1, reg: [number, number, number, number] = [0.5, 0.5, 0, 0]): void {
  const idx = row * cols + col;
  out.cls[idx] = score;
  out.obj[idx] = score;
  out.bbox[idx * 4] = reg[0];
  out.bbox[idx * 4 + 1] = reg[1];
  out.bbox[idx * 4 + 2] = reg[2];
  out.bbox[idx * 4 + 3] = reg[3];
}

describe('decodeYunetOutputs — pure decode arithmetic (T-4.4)', () => {
  // [A] Validates the transcribed OpenCV decode formula against synthetic tensors built to the
  // documented output contract — NOT against a real photograph (this sandboxed, network-restricted
  // environment has no licensable face-photo fixture; see face.ts's top-of-file doc comment).

  it('decodes a single stride-8 cell into a box at the expected source-space location', () => {
    const stride8 = emptyStride(8);
    const cols = INPUT_SIZE / 8; // 80
    plantDetection(stride8, 10, 10, cols, 1, [0.5, 0.5, 0, 0]);
    const dets = decodeYunetOutputs([stride8, emptyStride(16), emptyStride(32)]);
    expect(dets).toHaveLength(1);
    const [x, y, w, h] = dets[0]!.box;
    // cx = (10+0.5)*8 = 84, cy = 84, w = h = exp(0)*8 = 8 → box = [80, 80, 8, 8]
    expect(x).toBeCloseTo(80, 5);
    expect(y).toBeCloseTo(80, 5);
    expect(w).toBeCloseTo(8, 5);
    expect(h).toBeCloseTo(8, 5);
    expect(dets[0]!.score).toBeCloseTo(1, 5);
  });

  it('scales box size correctly for a larger regression (exp of a positive log-size)', () => {
    const stride32 = emptyStride(32);
    const cols = INPUT_SIZE / 32; // 20
    // w = h = exp(1) * 32 ≈ 86.97
    plantDetection(stride32, 5, 5, cols, 0.9, [0, 0, 1, 1]);
    const dets = decodeYunetOutputs([emptyStride(8), emptyStride(16), stride32]);
    expect(dets).toHaveLength(1);
    const [, , w, h] = dets[0]!.box;
    expect(w).toBeCloseTo(Math.exp(1) * 32, 3);
    expect(h).toBeCloseTo(Math.exp(1) * 32, 3);
  });

  it('drops detections below the 0.5 score threshold', () => {
    const stride8 = emptyStride(8);
    plantDetection(stride8, 1, 1, INPUT_SIZE / 8, 0.3);
    const dets = decodeYunetOutputs([stride8, emptyStride(16), emptyStride(32)]);
    expect(dets).toHaveLength(0);
  });

  it('score is sqrt(cls*obj), not a simple average or max', () => {
    const stride8 = emptyStride(8);
    const idx = 0;
    stride8.cls[idx] = 1;
    stride8.obj[idx] = 0.36; // sqrt(1 * 0.36) = 0.6, above threshold
    const dets = decodeYunetOutputs([stride8, emptyStride(16), emptyStride(32)]);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.score).toBeCloseTo(0.6, 5);
  });

  it('NMS collapses two heavily-overlapping detections into one, keeping the higher score', () => {
    const stride8 = emptyStride(8);
    const cols = INPUT_SIZE / 8;
    // Adjacent cells (centers 8px apart) with a large regressed box (~59px) so they overlap
    // heavily despite the different cell — a tight 8px box at adjacent cells would NOT overlap.
    plantDetection(stride8, 10, 10, cols, 0.7, [0.5, 0.5, 2, 2]);
    plantDetection(stride8, 10, 11, cols, 0.95, [0.5, 0.5, 2, 2]);
    const dets = decodeYunetOutputs([stride8, emptyStride(16), emptyStride(32)]);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.score).toBeCloseTo(0.95, 5);
  });

  it('two well-separated detections both survive NMS', () => {
    const stride8 = emptyStride(8);
    const cols = INPUT_SIZE / 8;
    plantDetection(stride8, 5, 5, cols, 0.8, [0.5, 0.5, 0, 0]);
    plantDetection(stride8, 60, 60, cols, 0.9, [0.5, 0.5, 0, 0]);
    const dets = decodeYunetOutputs([stride8, emptyStride(16), emptyStride(32)]);
    expect(dets).toHaveLength(2);
  });
});
