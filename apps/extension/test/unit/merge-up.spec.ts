import { describe, expect, it } from 'vitest';
import { mergeUp } from '../../src/perception/compose/merge-up';

describe('mergeUp (phase_4_vision.md §7.2)', () => {
  it('leaves well-separated boxes alone', () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 10, 10],
      [100, 100, 10, 10],
    ];
    expect(mergeUp(boxes)).toHaveLength(2);
  });

  it('merges two touching boxes into their bounding union', () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 10, 10],
      [10, 0, 10, 10],
    ];
    const merged = mergeUp(boxes);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual([0, 0, 20, 10]);
  });

  it('merges boxes within the gap tolerance', () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 10, 10],
      [12, 0, 10, 10], // 2px gap, within default 4px tolerance
    ];
    const merged = mergeUp(boxes);
    expect(merged).toHaveLength(1);
  });

  it('does not merge boxes further apart than the gap tolerance', () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 10, 10],
      [50, 0, 10, 10],
    ];
    expect(mergeUp(boxes, 4)).toHaveLength(2);
  });

  it('chains transitively: A-B-C merges into one region even though A and C alone would not', () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 10, 10],
      [10, 0, 10, 10],
      [20, 0, 10, 10],
    ];
    const merged = mergeUp(boxes);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual([0, 0, 30, 10]);
  });

  it('handles an empty list', () => {
    expect(mergeUp([])).toEqual([]);
  });
});
