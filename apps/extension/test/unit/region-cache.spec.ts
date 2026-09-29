import { describe, expect, it } from 'vitest';
import { pixelKey, RegionResultCache } from '../../src/perception/region-cache';
import type { Box } from '../../src/shared/worker-protocol';

type Hit = { entity: string; box: Box; regionId?: string };

function pixels(seed: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < a.length; i++) a[i] = (i * 31 + seed) & 0xff;
  return a;
}

describe('region result cache', () => {
  it('any changed pixel is a different key (never reuses a result for different content)', () => {
    const a = pixels(1);
    const b = pixels(1);
    b[123] = (b[123]! + 1) & 0xff;
    expect(pixelKey(16, 16, a, 'fov')).toBe(pixelKey(16, 16, pixels(1), 'fov'));
    expect(pixelKey(16, 16, a, 'fov')).not.toBe(pixelKey(16, 16, b, 'fov'));
    expect(pixelKey(16, 16, a, 'fov')).not.toBe(pixelKey(16, 16, a, 'fo')); // different models ran
  });

  it('re-places a cached result at the region’s new position and id', () => {
    const cache = new RegionResultCache<Hit, { regionId: string }>();
    cache.set('k', [100, 200, 50, 50], {
      faces: [{ box: [110, 210, 20, 20], score: 0.9 }],
      ocrHits: [{ entity: 'AADHAAR', box: [105, 240, 30, 8], regionId: 'n-1' }],
      vitEntity: null,
      diagnostic: { regionId: 'n-1' },
    });
    const hit = cache.get('k', [100, 500, 50, 50], 'n-9')!;
    expect(hit.faces[0]!.box).toEqual([110, 510, 20, 20]);
    expect(hit.ocrHits[0]).toEqual({ entity: 'AADHAAR', box: [105, 540, 30, 8], regionId: 'n-9' });
    expect(cache.get('other', [0, 0, 1, 1], 'x')).toBeUndefined();
  });
});
