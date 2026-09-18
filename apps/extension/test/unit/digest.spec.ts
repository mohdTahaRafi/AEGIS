import { describe, expect, it } from 'vitest';
import { computeGeometryDigest, GeometryDigestGuard } from '../../src/host/capture/digest';

describe('computeGeometryDigest (design.md §5.8)', () => {
  it('is stable for the same geometry regardless of input order', async () => {
    const a = await computeGeometryDigest([{ id: 'n-1', box: [0, 0, 10, 10] }, { id: 'n-2', box: [10, 10, 5, 5] }]);
    const b = await computeGeometryDigest([{ id: 'n-2', box: [10, 10, 5, 5] }, { id: 'n-1', box: [0, 0, 10, 10] }]);
    expect(a).toBe(b);
  });

  it('is insensitive to sub-pixel jitter (rounds to whole pixels)', async () => {
    const a = await computeGeometryDigest([{ id: 'n-1', box: [0.001, 0, 10, 10] }]);
    const b = await computeGeometryDigest([{ id: 'n-1', box: [0.4, 0, 10, 10] }]);
    expect(a).toBe(b);
  });

  it('changes when a box actually moves', async () => {
    const a = await computeGeometryDigest([{ id: 'n-1', box: [0, 0, 10, 10] }]);
    const b = await computeGeometryDigest([{ id: 'n-1', box: [0, 40, 10, 10] }]);
    expect(a).not.toBe(b);
  });
});

describe('GeometryDigestGuard (phase_4_vision.md §5.2)', () => {
  it('reports ok on a matching digest and resets the mismatch counter', () => {
    const guard = new GeometryDigestGuard();
    expect(guard.check('a', 'b')).toBe('retry');
    expect(guard.check('a', 'a')).toBe('ok');
    expect(guard.check('a', 'b')).toBe('retry'); // counter reset, not yet at 3
  });

  it('degrades after 3 consecutive mismatches, per phase_4_vision.md §5.2', () => {
    const guard = new GeometryDigestGuard();
    expect(guard.check('a', 'b')).toBe('retry');
    expect(guard.check('a', 'b')).toBe('retry');
    expect(guard.check('a', 'b')).toBe('degrade');
  });

  it('reset() clears the counter explicitly', () => {
    const guard = new GeometryDigestGuard();
    guard.check('a', 'b');
    guard.check('a', 'b');
    guard.reset();
    expect(guard.check('a', 'b')).toBe('retry');
  });
});
