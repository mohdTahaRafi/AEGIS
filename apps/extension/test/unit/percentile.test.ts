import { describe, expect, it } from 'vitest';

// Mirrors the private percentile/at helpers in src/perception/worker.ts. Not imported directly
// because the worker module has top-level side effects (onnxruntime-web env setup) that require
// a worker global scope; this locks down the pure math they depend on.
function at(sorted: readonly number[], idx: number): number {
  const v = sorted[idx];
  if (v === undefined) throw new Error('percentile index out of range on an empty sample');
  return v;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return at(sorted, Math.max(0, idx));
}

describe('percentile', () => {
  it('returns NaN for an empty sample', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('p50 of a sorted sample matches the middle value', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 50)).toBe(30);
  });

  it('p95 of a small sample never indexes past the end', () => {
    const sorted = [1, 2, 3];
    expect(percentile(sorted, 95)).toBe(3);
  });

  it('single-element sample returns that element at any percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe('at', () => {
  it('throws rather than returning undefined out of range', () => {
    expect(() => at([], 0)).toThrow(/out of range/);
  });
});
