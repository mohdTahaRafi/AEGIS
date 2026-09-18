import { describe, expect, it } from 'vitest';
import { letterbox, toCHWFloat32, unletterboxPoint } from '../../src/perception/preprocess/letterbox';

function solid(width: number, height: number, color: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

describe('letterbox (T-4.4/T-4.6 — fixed-size model input)', () => {
  it('produces exactly the requested square size regardless of source aspect ratio', () => {
    const result = letterbox(solid(400, 100, '#ffffff'), 224);
    expect(result.canvas.width).toBe(224);
    expect(result.canvas.height).toBe(224);
  });

  it('centers a wide source with vertical padding, preserving aspect ratio', () => {
    const result = letterbox(solid(400, 100, '#ffffff'), 200);
    expect(result.scale).toBeCloseTo(0.5, 5); // 200/400
    expect(result.offsetY).toBeGreaterThan(0);
    expect(result.offsetX).toBe(0);
  });

  it('unletterboxPoint inverts the transform back to source coordinates', () => {
    const result = letterbox(solid(400, 100, '#ffffff'), 200);
    const [sx, sy] = unletterboxPoint(result.offsetX + 10, result.offsetY + 10, result);
    expect(sx).toBeCloseTo(20, 3); // 10 / scale(0.5)
    expect(sy).toBeCloseTo(20, 3);
  });

  it('toCHWFloat32 produces a plane-separated, normalized [0,1] tensor of the right length', () => {
    const canvas = solid(4, 4, '#ff0000');
    const data = toCHWFloat32(canvas);
    expect(data.length).toBe(3 * 4 * 4);
    // Pure red: R plane ~1, G/B planes ~0.
    expect(data[0]).toBeCloseTo(1, 2);
    expect(data[16]).toBeCloseTo(0, 2); // G plane starts at index 16 (4*4)
    expect(data[32]).toBeCloseTo(0, 2); // B plane starts at index 32
  });
});
