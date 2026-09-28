import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it } from 'vitest';
import { fuse, resetRegionCounterForTesting } from '../../src/host/privacy/fusion';
import { decomposeToRects } from '../../src/host/privacy/fusion/decompose';
import { dilateBox, expandToToken } from '../../src/host/privacy/fusion/dilate';
import type { Candidate } from '../../src/host/privacy/types';

describe('fuse — thresholding and the fail-closed uncertainty band (T-3.11, step 1-2)', () => {
  it('marks a below-threshold-but-above-band candidate unverified rather than dropping it', () => {
    resetRegionCounterForTesting();
    // AADHAAR/CRITICAL: threshold 0.30, band floor 0.15.
    const candidates: Candidate[] = [{ entity: 'AADHAAR', box: [0, 0, 10, 10], score: 0.2, channel: 'text-dom', source: 'pattern:aadhaar', nodeId: 'n-1', value: 'x' }];
    const regions = fuse(defaultPolicy, candidates);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.unverified).toBe(true);
  });

  it('drops a candidate scoring below the band floor entirely', () => {
    const candidates: Candidate[] = [{ entity: 'AADHAAR', box: [0, 0, 10, 10], score: 0.1, channel: 'text-dom', source: 'pattern:aadhaar', nodeId: 'n-1', value: 'x' }];
    expect(fuse(defaultPolicy, candidates)).toHaveLength(0);
  });

  it('LOW class produces no region (step 10)', () => {
    const candidates: Candidate[] = [{ entity: 'CITY', box: [0, 0, 10, 10], score: 0.99, channel: 'text-dom', source: 'pattern:city', nodeId: 'n-1', value: 'Pune' }];
    expect(fuse(defaultPolicy, candidates)).toHaveLength(0);
  });
});

describe('fuse — cross-channel grouping (T-3.11, step 4)', () => {
  it('two channels on the same node merge into one region, keeping the highest class', () => {
    const candidates: Candidate[] = [
      { entity: 'PERSON_NAME', box: [0, 0, 10, 10], score: 0.6, channel: 'dom', source: 'dom:person_name', nodeId: 'n-1', value: 'Ramesh Kumar' },
      { entity: 'USERNAME', box: [0, 0, 10, 10], score: 0.6, channel: 'text-dom', source: 'pattern:username', nodeId: 'n-1', value: 'Ramesh Kumar' },
    ];
    const regions = fuse(defaultPolicy, candidates);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.entities.sort()).toEqual(['PERSON_NAME', 'USERNAME']);
  });

  it('different entities on overlapping text-run spans keep the highest class', () => {
    const candidates: Candidate[] = [
      { entity: 'PERSON_NAME', box: [0, 0, 10, 10], score: 0.9, channel: 'text-dom', source: 'a', textRunId: 't-1', span: [0, 10], value: 'x' },
      { entity: 'AADHAAR', box: [0, 0, 10, 10], score: 0.95, channel: 'text-dom', source: 'b', textRunId: 't-1', span: [5, 15], value: 'y' },
    ];
    const regions = fuse(defaultPolicy, candidates);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.class).toBe('CRITICAL'); // AADHAAR's class wins over PERSON_NAME's MEDIUM
  });

  it('non-overlapping spans in the same run produce separate regions', () => {
    const candidates: Candidate[] = [
      { entity: 'EMAIL', box: [0, 0, 10, 10], score: 0.95, channel: 'text-dom', source: 'a', textRunId: 't-1', span: [0, 5], value: 'a@b.com' },
      { entity: 'PHONE', box: [0, 0, 10, 10], score: 0.9, channel: 'text-dom', source: 'b', textRunId: 't-1', span: [20, 30], value: '9876543210' },
    ];
    expect(fuse(defaultPolicy, candidates)).toHaveLength(2);
  });
});

describe('decomposeToRects (T-3.12)', () => {
  it('keeps ≤4 rects for any input size', () => {
    const boxes: Array<[number, number, number, number]> = Array.from({ length: 10 }, (_, i) => [i * 20, 0, 10, 10]);
    expect(decomposeToRects(boxes).length).toBeLessThanOrEqual(4);
  });

  it('leaves a small union alone', () => {
    const boxes: Array<[number, number, number, number]> = [
      [0, 0, 10, 10],
      [50, 50, 10, 10],
    ];
    expect(decomposeToRects(boxes)).toHaveLength(2);
  });
});

describe('dilateBox — clamped against siblings (T-3.12)', () => {
  it('dilates a box by roughly 2px on each side plus vertical line-height padding', () => {
    const dilated = dilateBox([100, 100, 50, 20], []);
    expect(dilated[0]).toBeLessThan(100);
    expect(dilated[1]).toBeLessThan(100);
    expect(dilated[2]).toBeGreaterThan(50);
  });

  it('never enters a non-sensitive sibling box by more than 1px, on a dense form fixture', () => {
    const target: [number, number, number, number] = [100, 100, 50, 20];
    const sibling: [number, number, number, number] = [150, 100, 50, 20]; // touching, dilation would normally overlap by 2px
    const dilated = dilateBox(target, [sibling]);
    const penetration = dilated[0] + dilated[2] - sibling[0];
    expect(penetration).toBeLessThanOrEqual(1.01);
  });
});

describe('expandToToken (T-3.13)', () => {
  it('expands a span covering half a token to the whole token', () => {
    const text = 'Card:4111111111111111 expires soon';
    const [start, end] = expandToToken(text, [7, 15]); // partway into the digit run
    expect(text.slice(start, end)).toBe('Card:4111111111111111');
  });

  it('leaves an already-whole-token span unchanged', () => {
    const text = 'hello world';
    expect(expandToToken(text, [0, 5])).toEqual([0, 5]);
  });
});

describe('fuse — semantic-first entity choice (field semantics outrank value format)', () => {
  const box: Candidate['box'] = [0, 0, 10, 10];

  it('a Username field holding an email-shaped value stays USERNAME, at the escalated class', () => {
    const regions = fuse(defaultPolicy, [
      { entity: 'USERNAME', box, score: 0.92, channel: 'dom', source: 'dom:username', nodeId: 'n-1', value: 'person@example.com', semanticRank: 0 },
      { entity: 'EMAIL', box, score: 0.95, channel: 'text-dom', source: 'pattern:email', nodeId: 'n-1', value: 'person@example.com' },
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.entity).toBe('USERNAME');
    expect(regions[0]!.class).toBe('HIGH');
  });

  it('a value recognizer picks among the label’s own alternatives ("Email / Mobile" + phone value → PHONE)', () => {
    const regions = fuse(defaultPolicy, [
      { entity: 'EMAIL', box, score: 0.92, channel: 'dom', source: 'dom:email', nodeId: 'n-1', value: '9876543210', semanticRank: 0 },
      { entity: 'PHONE', box, score: 0.92, channel: 'dom', source: 'dom:phone', nodeId: 'n-1', value: '9876543210', semanticRank: 1 },
      { entity: 'PHONE', box, score: 0.8, channel: 'text-dom', source: 'pattern:phone-in', nodeId: 'n-1', value: '9876543210' },
    ]);
    expect(regions[0]!.entity).toBe('PHONE');
  });

  it('with no value support, the primary semantic type wins ("Email / Mobile" + "abc" → EMAIL)', () => {
    const regions = fuse(defaultPolicy, [
      { entity: 'EMAIL', box, score: 0.92, channel: 'dom', source: 'dom:email', nodeId: 'n-1', value: 'abc', semanticRank: 0 },
      { entity: 'PHONE', box, score: 0.92, channel: 'dom', source: 'dom:phone', nodeId: 'n-1', value: 'abc', semanticRank: 1 },
    ]);
    expect(regions[0]!.entity).toBe('EMAIL');
  });

  it('with no semantic candidate at all, value recognizers still decide (unlabelled search box + Aadhaar)', () => {
    const regions = fuse(defaultPolicy, [{ entity: 'AADHAAR', box, score: 0.95, channel: 'text-dom', source: 'pattern:aadhaar+verhoeff', nodeId: 'n-1', value: 'x' }]);
    expect(regions[0]!.entity).toBe('AADHAAR');
  });
});
