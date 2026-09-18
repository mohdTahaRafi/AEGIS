// design.md §7.5 / phase_4_vision.md §7.2 — `mergeUp`: merges cleared regions into their common
// container so the composited image isn't "swiss cheese" (technically safe, visually incoherent —
// damages metric 1, since the model can't read a page made of disconnected fragments).
//
// [A] ASSUMPTION, disclosed: design.md's pseudocode places `mergeUp` inside `compose()` (the
// worker, which only ever receives a flat `cleared: Box[]` over the wire — no DOM parent/child
// structure, which cannot cross the host↔worker message boundary as anything richer than boxes
// without duplicating the whole screen graph into every `compose` call). §7.2's prose describes it
// in DOM terms ("common container," "descendants") but the mechanism implemented here, consistent
// with where the design places the call, is purely geometric: adjacent/overlapping cleared boxes
// merge into their bounding union. This recovers the same practical benefit (fewer disconnected
// fragments) without requiring tree structure the worker never has.

export type Box = readonly [x: number, y: number, w: number, h: number];

function closeEnough(a: Box, b: Box, gap: number): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ax2 = ax + aw;
  const ay2 = ay + ah;
  const bx2 = bx + bw;
  const by2 = by + bh;
  const xGap = Math.max(ax - bx2, bx - ax2);
  const yGap = Math.max(ay - by2, by - ay2);
  return xGap <= gap && yGap <= gap;
}

function union(a: Box, b: Box): Box {
  const x1 = Math.min(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const x2 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x1, y1, x2 - x1, y2 - y1];
}

/** Merges cleared boxes that touch, overlap, or sit within `gapPx` of each other into their
 * bounding union. Deterministic single pass to a fixed point — safe to call on an empty or
 * single-element list. */
export function mergeUp(boxes: readonly Box[], gapPx = 4): Box[] {
  let current = [...boxes];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        if (closeEnough(current[i]!, current[j]!, gapPx)) {
          const merged = union(current[i]!, current[j]!);
          current = [merged, ...current.filter((_, idx) => idx !== i && idx !== j)];
          changed = true;
          break outer;
        }
      }
    }
  }
  return current;
}
