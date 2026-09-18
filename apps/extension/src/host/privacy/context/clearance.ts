// design.md §7.5's clearance rules (phase_4_vision.md §7.1) — decides which boxes may be copied
// into the composited image. Lives host-side, not in the compositor itself: only the host has the
// fused knowledge (structural analysis state from Channel D/T, vision results already returned
// from a prior `perceived` message, and the page-chrome heuristic) needed to decide "positively
// cleared." The compositor (`perception/compose/compositor.ts`) only ever receives the resulting
// flat `Box[]` — it has no basis of its own to decide anything is safe to draw, by construction.
//
// A region gets a box here for exactly one of three reasons (§7.1) — anything not covered by one
// of them is absent from the returned list, and absence means grey. This function has no
// "otherwise clear" branch.

import type { Box } from '../../../shared/worker-protocol';

export interface ClearanceCandidate {
  box: Box;
  /** Rule 1: a structural (DOM) node/text run whose text Channel D+T fully analysed, with no
   * accepted region and no unanalysed image content nested inside it (e.g. a `<div>` containing
   * only plain text and no `<img>`/`<canvas>`/avatar). */
  kind: 'structural-text' | 'vision-region' | 'chrome';
  fullyAnalysed: boolean;
  hadAcceptedFinding: boolean;
  /** Rule 1 only: true if this structural node contains image content that vision has not (yet)
   * screened — disqualifies it even if its own text was clean. */
  hasUnanalysedImageContent?: boolean;
}

export function isPositivelyCleared(c: ClearanceCandidate): boolean {
  if (!c.fullyAnalysed || c.hadAcceptedFinding) return false;
  if (c.kind === 'structural-text' && c.hasUnanalysedImageContent) return false;
  return true;
}

export function computeClearedBoxes(candidates: readonly ClearanceCandidate[]): Box[] {
  return candidates.filter(isPositivelyCleared).map((c) => c.box);
}
