// design.md §6.2's `coverage.explained` — the fraction of the viewport's pixel area the DOM
// structure itself accounts for, which drives escalation.ts's L0/L1/L2 decision. Deliberately
// crude (summed, clamped node-box area over viewport area, no occlusion/overlap accounting): a
// precise pixel-coverage computation would need the same rasterization work the compositor
// already does, and this number only needs to be good enough to pick a *level*, not to size a
// redaction box.

import type { Box } from '../../../shared/worker-protocol';

export interface CoverageNode {
  box: Box;
  /** True for element kinds that need vision to be "explained" at all — an `<img>`/`<canvas>`/
   * `<video>` (role `'img'`, including Phase 4's CANVAS/VIDEO routing overload — see
   * `content/screen-graph/roles.ts`) never counts toward structural coverage on its own, even
   * though it has a box: its content is opaque to the DOM. */
  requiresVision: boolean;
}

export function structuralCoverage(nodes: readonly CoverageNode[], viewport: { w: number; h: number }): number {
  const viewportArea = viewport.w * viewport.h;
  if (viewportArea <= 0) return 1;
  let explained = 0;
  for (const node of nodes) {
    if (node.requiresVision) continue;
    const [, , w, h] = node.box;
    explained += Math.max(0, w) * Math.max(0, h);
  }
  return Math.min(1, explained / viewportArea);
}
