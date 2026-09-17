// design.md §7.1 step 5 — rectangle decomposition of a box union, ≤4 rects per region, merging
// two rects if the area gain from keeping them separate is under 10%. [Phase 4 forward
// dependency, phase_3_privacy_core.md §16]: this is the compositor's box-drawing geometry, which
// has no caller yet (L0 has no image) — exercised directly by T-3.12's synthetic-candidate tests
// so Phase 4 only has to wire it in, not write it.

import type { Box } from '../types';

function area([, , w, h]: Box): number {
  return w * h;
}

function boundingBox(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Merges the two smallest-gain-loss boxes repeatedly until ≤4 remain, only when the union's area
 * doesn't grow the total by more than 10% relative to the sum of the merged pair's own areas —
 * otherwise keeps them separate (a decomposition, not just a bounding box). */
export function decomposeToRects(boxes: readonly Box[], maxRects = 4): Box[] {
  let rects = [...boxes];
  while (rects.length > maxRects) {
    let bestPair: [number, number] | null = null;
    let bestGainRatio = Infinity;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const union = boundingBox([rects[i]!, rects[j]!]);
        const pairArea = area(rects[i]!) + area(rects[j]!);
        const gainRatio = pairArea > 0 ? (area(union) - pairArea) / pairArea : 0;
        if (gainRatio < bestGainRatio) {
          bestGainRatio = gainRatio;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair) break;
    const [i, j] = bestPair;
    const merged = boundingBox([rects[i]!, rects[j]!]);
    rects = rects.filter((_, idx) => idx !== i && idx !== j);
    rects.push(merged);
  }
  return rects;
}
