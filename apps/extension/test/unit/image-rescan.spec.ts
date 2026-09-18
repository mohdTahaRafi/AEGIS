import { describe, expect, it, vi } from 'vitest';
import { dilateForRescan, runImageRescan, type ImageRescanDeps, type RedactionRegion } from '../../src/host/privacy/guard/image-rescan';

const IMAGE = new ArrayBuffer(4);
const REGIONS: RedactionRegion[] = [{ entity: 'FACE', boxes: [[10, 10, 20, 20]], placeholder: null }];

describe('dilateForRescan', () => {
  it('expands symmetrically around the box center by the given factor', () => {
    expect(dilateForRescan([10, 10, 20, 20], 0.5)).toEqual([5, 5, 30, 30]);
  });
});

describe('runImageRescan (design.md §7.6 step 5, phase_4_vision.md §8)', () => {
  it('returns clean when the first rescan finds nothing', async () => {
    const deps: ImageRescanDeps = { rescan: vi.fn().mockResolvedValue({ hits: [] }), recompose: vi.fn() };
    const outcome = await runImageRescan(IMAGE, REGIONS, deps);
    expect(outcome).toEqual({ verdict: 'clean', imageBytes: IMAGE });
    expect(deps.recompose).not.toHaveBeenCalled();
  });

  it('recomposes once with dilated regions when the first rescan finds a hit, then accepts a clean second pass', async () => {
    const recomposed = new ArrayBuffer(8);
    const rescan = vi.fn().mockResolvedValueOnce({ hits: [{ box: [10, 10, 20, 20] }] }).mockResolvedValueOnce({ hits: [] });
    const recompose = vi.fn().mockResolvedValue(recomposed);
    const outcome = await runImageRescan(IMAGE, REGIONS, { rescan, recompose });
    expect(outcome).toEqual({ verdict: 'recomposed', imageBytes: recomposed });
    expect(recompose).toHaveBeenCalledTimes(1);
    const dilatedArg = recompose.mock.calls[0]![0] as RedactionRegion[];
    expect(dilatedArg[0]!.boxes[0]).toEqual(dilateForRescan([10, 10, 20, 20]));
    expect(dilatedArg[0]!.entity).toBe('FACE'); // entity/placeholder association preserved through dilation
  });

  it('drops the image after a second hit — never a second recompose attempt', async () => {
    const recompose = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    const rescan = vi.fn().mockResolvedValue({ hits: [{ box: [10, 10, 20, 20] }] });
    const outcome = await runImageRescan(IMAGE, REGIONS, { rescan, recompose });
    expect(outcome).toEqual({ verdict: 'dropped' });
    expect(recompose).toHaveBeenCalledTimes(1); // exactly one recompose cycle, never a retry loop
    expect(rescan).toHaveBeenCalledTimes(2);
  });
});
