import { describe, expect, it, vi } from 'vitest';
import { dilateForRescan, MAX_RECOMPOSE_ROUNDS, runImageRescan, type ImageRescanDeps, type RedactionRegion } from '../../src/host/privacy/guard/image-rescan';

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

  it('covers each new hit and re-checks, a bounded number of rounds, then gives the image up', async () => {
    const recompose = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    const rescan = vi.fn().mockResolvedValue({ hits: [{ box: [10, 10, 20, 20] }] });
    const outcome = await runImageRescan(IMAGE, REGIONS, { rescan, recompose });
    expect(outcome).toEqual({ verdict: 'dropped' });
    expect(recompose).toHaveBeenCalledTimes(MAX_RECOMPOSE_ROUNDS); // bounded: never an open loop
    expect(rescan).toHaveBeenCalledTimes(MAX_RECOMPOSE_ROUNDS + 1);
    // Coverage only grows: each round keeps every box of the round before.
    const sizes = recompose.mock.calls.map(([regions]) => (regions as RedactionRegion[]).length);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('a hit covered in the second round is enough', async () => {
    const recompose = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    const rescan = vi
      .fn()
      .mockResolvedValueOnce({ hits: [{ box: [10, 10, 20, 20] }] })
      .mockResolvedValueOnce({ hits: [{ box: [60, 10, 20, 20] }] })
      .mockResolvedValue({ hits: [] });
    const outcome = await runImageRescan(IMAGE, REGIONS, { rescan, recompose });
    expect(outcome.verdict).toBe('recomposed');
    expect(recompose).toHaveBeenCalledTimes(2);
    const lastRegions = recompose.mock.calls[1]![0] as RedactionRegion[];
    // The original FACE region plus one per hit, from both rounds.
    expect(lastRegions.filter((r) => r.entity === 'FACE')).toHaveLength(3);
  });
});

describe('runImageRescan — ring text is judged by the guard, not counted blindly (A2)', () => {
  const TEXT_REGIONS: RedactionRegion[] = [{ entity: 'AADHAAR', boxes: [[70, 40, 120, 19]], placeholder: '⟪AADHAAR#1⟫' }];

  it('text that is only a field label around the box leaves the image clean', async () => {
    const rescan = vi.fn().mockResolvedValue({ hits: [], ringText: [{ box: [0, 40, 60, 19], text: 'Aadhaar' }] });
    const outcome = await runImageRescan(IMAGE, TEXT_REGIONS, { rescan, recompose: vi.fn(), isSensitiveText: (t) => /\d{4}/.test(t) });
    expect(outcome.verdict).toBe('clean');
  });

  it('sensitive ring text (e.g. a digit tail escaping the box) forces recomposes, then a drop', async () => {
    const rescan = vi.fn().mockResolvedValue({ hits: [], ringText: [{ box: [190, 40, 30, 19], text: '5679' }] });
    const recompose = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    const outcome = await runImageRescan(IMAGE, TEXT_REGIONS, { rescan, recompose, isSensitiveText: (t) => /\d{4}/.test(t) });
    expect(outcome).toEqual({ verdict: 'dropped' });
    expect(recompose).toHaveBeenCalledTimes(MAX_RECOMPOSE_ROUNDS);
  });

  it('with no predicate, any ring text counts (fail closed)', async () => {
    const rescan = vi.fn().mockResolvedValue({ hits: [], ringText: [{ box: [0, 0, 1, 1], text: 'Aadhaar' }] });
    const outcome = await runImageRescan(IMAGE, TEXT_REGIONS, { rescan, recompose: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
    expect(outcome.verdict).toBe('dropped');
  });
});
