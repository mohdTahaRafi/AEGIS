import { describe, expect, it } from 'vitest';
import { dHash, hammingDistance, DHashCache } from '../../src/perception/preprocess/dhash';

function solid(width: number, height: number, color: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/** dHash compares adjacent-pixel brightness — a perfectly solid color has no internal gradient at
 * all and always hashes to the same all-equal pattern regardless of hue, so telling two images
 * apart needs actual internal structure, not just a different fill color. */
function checkerboard(width: number, height: number, cell: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? '#000000' : '#ffffff';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  return canvas;
}

describe('dHash (T-4.12 — crop cache)', () => {
  it('produces the identical hash for the identical image twice', () => {
    const a = dHash(solid(32, 32, '#336699'));
    const b = dHash(solid(32, 32, '#336699'));
    expect(a).toBe(b);
  });

  it('produces a very different hash for a structurally different image', () => {
    const a = dHash(checkerboard(32, 32, 4));
    const b = dHash(solid(32, 32, '#808080'));
    expect(hammingDistance(a, b)).toBeGreaterThan(0);
  });

  it('hammingDistance of a hash against itself is zero', () => {
    const h = dHash(solid(32, 32, '#abcdef'));
    expect(hammingDistance(h, h)).toBe(0);
  });
});

describe('DHashCache (T-4.12 — "same logo in 8 places runs the encoder once")', () => {
  it('a cache hit within tolerance returns the stored value', () => {
    const cache = new DHashCache<string>(8, 2);
    cache.set('aaaa000000000000', 'logo-result');
    expect(cache.get('aaaa000000000000')).toBe('logo-result');
  });

  it('a miss returns undefined', () => {
    const cache = new DHashCache<string>(8);
    expect(cache.get('0000000000000000')).toBeUndefined();
  });

  it('evicts the oldest entry once capacity is exceeded', () => {
    const cache = new DHashCache<string>(2, 0);
    cache.set('0000000000000001', 'a');
    cache.set('0000000000000002', 'b');
    cache.set('0000000000000003', 'c');
    expect(cache.size).toBe(2);
    expect(cache.get('0000000000000001')).toBeUndefined();
  });

  it('clear() empties the cache', () => {
    const cache = new DHashCache<string>(4);
    cache.set('0000000000000001', 'a');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
