// phase_4_vision.md §6.2 / T-4.11 — the degradation ladder: "fewer crops → skip OCR on
// low-priority regions → structured-only mode," driven by measured frame times,
// `navigator.deviceMemory` and `hardwareConcurrency`. Thresholds are initial guesses, explicitly
// flagged in phase_4_vision.md §15 as a Phase 5 measurement target — kept as data here so
// retuning never requires touching the decision logic.
//
// Face detection is never dropped (FR-22 is unconditional, §4.1) — there is no rung of this
// ladder that can produce a decision disabling it; `LadderLevel.faceDetection` does not exist as
// a field, so there is nothing for a future edit to accidentally set to false.

export type LadderLevel = 'full' | 'reduced-crops' | 'no-ocr' | 'structured-only';

export interface LadderInput {
  recentFrameMsP95: number;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
}

export interface LadderThresholds {
  reducedCropsFrameMs: number;
  noOcrFrameMs: number;
  structuredOnlyFrameMs: number;
  lowMemoryGB: number;
  lowConcurrency: number;
}

export const DEFAULT_LADDER_THRESHOLDS: LadderThresholds = {
  reducedCropsFrameMs: 150,
  noOcrFrameMs: 250,
  structuredOnlyFrameMs: 400,
  lowMemoryGB: 4,
  lowConcurrency: 2,
};

/** A weak device (low memory or few cores) starts one rung down even before any frame timing
 * evidence exists — measured frame time can only push it further down, never back up past what
 * the device's own reported capability justifies. */
export function decideLadderLevel(input: LadderInput, thresholds = DEFAULT_LADDER_THRESHOLDS): LadderLevel {
  const weakDevice = (input.deviceMemoryGB !== null && input.deviceMemoryGB <= thresholds.lowMemoryGB) || input.hardwareConcurrency <= thresholds.lowConcurrency;

  if (input.recentFrameMsP95 >= thresholds.structuredOnlyFrameMs) return 'structured-only';
  if (input.recentFrameMsP95 >= thresholds.noOcrFrameMs) return 'no-ocr';
  if (input.recentFrameMsP95 >= thresholds.reducedCropsFrameMs || weakDevice) return 'reduced-crops';
  return 'full';
}

export function cropBudgetMultiplierFor(level: LadderLevel): number {
  switch (level) {
    case 'full':
      return 1;
    case 'reduced-crops':
      return 0.5;
    case 'no-ocr':
      return 0.5;
    case 'structured-only':
      return 0; // no vision jobs at all — L0, faces still run on avatar/img/canvas elements only
  }
}

export function ocrAllowedAt(level: LadderLevel): boolean {
  return level === 'full' || level === 'reduced-crops';
}
