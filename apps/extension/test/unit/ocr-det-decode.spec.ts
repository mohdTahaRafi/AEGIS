import { describe, expect, it } from 'vitest';
import { decodeDbOutput } from '../../src/perception/models/ocr-det';

const WIDTH = 64;
const HEIGHT = 64;

function emptyProbMap(): Float32Array {
  return new Float32Array(WIDTH * HEIGHT);
}

function fillRect(map: Float32Array, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      map[y * WIDTH + x] = value;
    }
  }
}

describe('decodeDbOutput — pure DB post-process arithmetic (T-6.3)', () => {
  // [A] Validates the transcribed PaddleOCR DBPostProcess arithmetic (thresh/box_thresh/
  // unclip_ratio/min_size, all real defaults — see ocr-det.ts's top comment) against synthetic
  // probability maps, the same "pure decode against a documented contract" pattern as
  // face-decode.spec.ts — not against a real detector run (that's the browser-mode integration
  // test, which CAN use real rendered text since no photo-licensing issue applies to OCR).

  it('extracts one box, expanded by the unclip distance, from a single high-confidence region', () => {
    const map = emptyProbMap();
    fillRect(map, 10, 10, 29, 19, 0.9); // a 20×10 "text line"
    const lines = decodeDbOutput(map, WIDTH, HEIGHT);
    expect(lines).toHaveLength(1);
    const [x, y, w, h] = lines[0]!.box;
    // unclip distance = area*2/perimeter = (20*10*2)/(2*(20+10)) = 400/60 = 6.667, expanded on all sides
    expect(x).toBeCloseTo(10 - 400 / 60, 3);
    expect(y).toBeCloseTo(10 - 400 / 60, 3);
    expect(w).toBeCloseTo(20 + (400 / 60) * 2, 3);
    expect(h).toBeCloseTo(10 + (400 / 60) * 2, 3);
    expect(lines[0]!.score).toBeCloseTo(0.9, 5);
  });

  it('rejects a region below the 0.3 probability threshold entirely', () => {
    const map = emptyProbMap();
    fillRect(map, 10, 10, 29, 19, 0.2);
    expect(decodeDbOutput(map, WIDTH, HEIGHT)).toHaveLength(0);
  });

  it('rejects a thresholded region below the 0.7 box-score threshold (a weak, noisy blob)', () => {
    const map = emptyProbMap();
    // Just above 0.3 (passes the pixel threshold, forming a component) but well below the 0.7
    // box-score threshold once averaged — a real "detected something, but not confidently" case.
    fillRect(map, 10, 10, 29, 19, 0.35);
    expect(decodeDbOutput(map, WIDTH, HEIGHT)).toHaveLength(0);
  });

  it('rejects a component smaller than min_size (3px) even at high confidence', () => {
    const map = emptyProbMap();
    fillRect(map, 10, 10, 11, 11, 0.95); // 2×2, below MIN_SIZE
    expect(decodeDbOutput(map, WIDTH, HEIGHT)).toHaveLength(0);
  });

  it('separates two disjoint high-confidence regions into two boxes', () => {
    const map = emptyProbMap();
    fillRect(map, 5, 5, 14, 9, 0.9);
    fillRect(map, 40, 40, 49, 44, 0.9);
    const lines = decodeDbOutput(map, WIDTH, HEIGHT);
    expect(lines).toHaveLength(2);
  });
});
