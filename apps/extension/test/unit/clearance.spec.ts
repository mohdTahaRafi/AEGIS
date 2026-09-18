import { describe, expect, it } from 'vitest';
import { computeClearedBoxes, isPositivelyCleared, type ClearanceCandidate } from '../../src/host/privacy/context/clearance';

function candidate(overrides: Partial<ClearanceCandidate> = {}): ClearanceCandidate {
  return { box: [0, 0, 10, 10], kind: 'structural-text', fullyAnalysed: true, hadAcceptedFinding: false, ...overrides };
}

describe('isPositivelyCleared (design.md §7.1)', () => {
  it('rule 1: a fully-analysed structural text node with no finding is cleared', () => {
    expect(isPositivelyCleared(candidate())).toBe(true);
  });

  it('a node with an accepted finding is never cleared, even if fully analysed', () => {
    expect(isPositivelyCleared(candidate({ hadAcceptedFinding: true }))).toBe(false);
  });

  it('a node not yet fully analysed is never cleared', () => {
    expect(isPositivelyCleared(candidate({ fullyAnalysed: false }))).toBe(false);
  });

  it('structural text containing unanalysed image content is not cleared even with clean text', () => {
    expect(isPositivelyCleared(candidate({ hasUnanalysedImageContent: true }))).toBe(false);
  });

  it('rule 2: a vision-analysed region with no accepted detection is cleared', () => {
    expect(isPositivelyCleared(candidate({ kind: 'vision-region', fullyAnalysed: true, hadAcceptedFinding: false }))).toBe(true);
  });

  it('rule 2: a vision region never analysed (timed out) is not cleared', () => {
    expect(isPositivelyCleared(candidate({ kind: 'vision-region', fullyAnalysed: false }))).toBe(false);
  });

  it('rule 3: known chrome with no text findings is cleared', () => {
    expect(isPositivelyCleared(candidate({ kind: 'chrome' }))).toBe(true);
  });
});

describe('computeClearedBoxes', () => {
  it('returns only the boxes of positively-cleared candidates — absence means grey, never "otherwise clear"', () => {
    const candidates: ClearanceCandidate[] = [
      candidate({ box: [0, 0, 10, 10] }), // cleared
      candidate({ box: [20, 0, 10, 10], hadAcceptedFinding: true }), // redacted, not cleared
      candidate({ box: [40, 0, 10, 10], fullyAnalysed: false }), // unanalysed, not cleared
    ];
    expect(computeClearedBoxes(candidates)).toEqual([[0, 0, 10, 10]]);
  });

  it('an empty candidate list clears nothing', () => {
    expect(computeClearedBoxes([])).toEqual([]);
  });
});
