// design.md §7.1 step 6 (dilation, clamped against sibling boxes) and step 7 (token expansion).
// Step 6 is image-compositor geometry — [Phase 4 forward dependency], exercised here by T-3.12's
// synthetic fixtures. Step 7 (token expansion) DOES apply to this phase's text substitution
// (design.md §7.3): a regex match that stops mid-word must expand to the whole word before
// `substitute` replaces it, or the trailing half-word leaks next to the placeholder.

import type { Box } from '../types';

function intersects(a: Box, b: Box): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** +2px all sides, vertical +8% of line height (`box[3]`), clamped so the dilated box never
 * enters a non-sensitive sibling's box by more than 1px. Which edge gets pulled back is decided
 * by the *original* (undilated) box's position relative to the sibling — dilation is small
 * relative to typical field spacing, so the original box's side of the sibling is the side the
 * dilated box is intruding from. */
export function dilateBox(box: Box, siblingBoxes: readonly Box[]): Box {
  const [x, y, w, h] = box;
  const vExtra = h * 0.08;
  let [nx, ny, nx2, ny2] = [x - 2, y - 2 - vExtra, x + w + 2, y + h + 2 + vExtra];

  for (const sibling of siblingBoxes) {
    const dilated: Box = [nx, ny, nx2 - nx, ny2 - ny];
    if (!intersects(dilated, sibling)) continue;
    const [sx, sy, sw, sh] = sibling;
    const [sx2, sy2] = [sx + sw, sy + sh];
    const [origLeft, origTop, origRight, origBottom] = [x, y, x + w, y + h];

    if (origRight <= sx) nx2 = Math.min(nx2, sx + 1); // original box was left of the sibling
    if (origLeft >= sx2) nx = Math.max(nx, sx2 - 1); // original box was right of the sibling
    if (origBottom <= sy) ny2 = Math.min(ny2, sy + 1); // original box was above the sibling
    if (origTop >= sy2) ny = Math.max(ny, sy2 - 1); // original box was below the sibling
  }
  return [nx, ny, nx2 - nx, ny2 - ny];
}

/** Step 7 — expands `[start,end)` in `text` outward to the nearest whitespace boundaries so a
 * partial-token match (e.g. a regex that matched only the digits of "Card:4111...") never leaves
 * a dangling half-token next to the placeholder. */
export function expandToToken(text: string, span: [number, number]): [number, number] {
  let [start, end] = span;
  const isBoundary = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
  while (!isBoundary(text[start - 1])) start -= 1;
  while (!isBoundary(text[end])) end += 1;
  return [start, end];
}
