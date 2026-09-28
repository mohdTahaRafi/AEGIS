// The compositor's coverage fractions go straight into the payload, whose schema caps each at 1.
// Summing box areas produced `cleared: 57.8` on a real Wikipedia article (overlapping containers
// plus nodes up to a viewport below the fold), which the guard then blocked as SCHEMA-invalid.

import { describe, expect, it } from 'vitest';
import { measureCoverage } from '../../src/perception/compose/compositor';
import type { Box } from '../../src/perception/compose/merge-up';

describe('measureCoverage', () => {
  const W = 100;
  const H = 50;

  it('overlapping and off-frame cleared boxes never exceed the frame', () => {
    const cleared: Box[] = [
      [0, 0, 100, 50],
      [0, 0, 100, 50],
      [-500, -500, 2000, 5000], // a whole-document container
      [0, 400, 100, 300], // entirely below the frame
    ];
    const c = measureCoverage(W, H, 1, cleared, []);
    expect(c).toEqual({ cleared: 1, redacted: 0, unanalysed: 0 });
  });

  it('redactions take precedence over cleared pixels and the three fractions sum to 1', () => {
    const c = measureCoverage(W, H, 1, [[0, 0, 50, 50]], [[25, 0, 50, 50]]);
    expect(c.cleared).toBeCloseTo(0.25);
    expect(c.redacted).toBeCloseTo(0.5);
    expect(c.unanalysed).toBeCloseTo(0.25);
    expect(c.cleared + c.redacted + c.unanalysed).toBeCloseTo(1);
  });

  it('measures in output-frame pixels when the image is downscaled', () => {
    // Source 200×100 at scale 0.5 → a 100×50 frame; a source box covering the left half stays half.
    const c = measureCoverage(W, H, 0.5, [[0, 0, 100, 100]], []);
    expect(c.cleared).toBeCloseTo(0.5);
  });

  it('nothing cleared is fully unanalysed (fail-closed default)', () => {
    expect(measureCoverage(W, H, 1, [], [])).toEqual({ cleared: 0, redacted: 0, unanalysed: 1 });
  });
});
