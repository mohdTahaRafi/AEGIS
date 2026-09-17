// design.md §5.3 — visibility test and occlusion probe. Needs real layout (getBoundingClientRect,
// elementsFromPoint, checkVisibility), so this module is exercised by test/browser/ (real
// Chromium via Playwright), never jsdom (phase_2_spine.md §3.3).

interface CheckVisibilityCapable {
  checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
}

function passesCheckVisibility(el: Element): boolean {
  const capable = el as unknown as CheckVisibilityCapable;
  if (typeof capable.checkVisibility === 'function') {
    return capable.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  // Style-based fallback for engines without checkVisibility (design.md §5.3).
  let current: Element | null = el;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === 'none') return false;
    if (current === el && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    if (current === el && parseFloat(style.opacity) === 0) return false;
    current = current.parentElement;
  }
  return true;
}

function isInert(el: Element): boolean {
  return el.closest('[inert]') != null;
}

function isAriaHidden(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') != null;
}

export interface ViewportExtent {
  width: number;
  height: number;
  /** Extra vertical margin above and below the viewport that still counts as "visible" (design.md §5.2: one viewport height). */
  verticalMarginPx: number;
}

function intersectsExtendedViewport(box: DOMRectReadOnly, viewport: ViewportExtent): boolean {
  const top = -viewport.verticalMarginPx;
  const bottom = viewport.height + viewport.verticalMarginPx;
  const verticallyIn = box.bottom > top && box.top < bottom;
  const horizontallyIn = box.right > 0 && box.left < viewport.width;
  return verticallyIn && horizontallyIn;
}

/**
 * design.md §5.3: visible requires checkVisibility, not inert, not aria-hidden, a non-zero box,
 * and intersection with the extended viewport. `box` is passed in (not re-read) so callers can
 * share one `getBoundingClientRect()` result with geometry extraction (T-2.10's one-pass rule).
 */
export function isVisible(el: Element, box: DOMRectReadOnly, viewport: ViewportExtent): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  if (!passesCheckVisibility(el)) return false;
  if (isInert(el)) return false;
  if (isAriaHidden(el)) return false;
  if (!intersectsExtendedViewport(box, viewport)) return false;
  return true;
}

/**
 * design.md §5.3: a 3×3 grid inside `box`, sampled with `elementsFromPoint`. Fewer than 3 hits on
 * `el` or one of its descendants marks the element occluded — kept, not dropped; the pre-flight
 * hit test (§5.9) is what actually refuses to act on it.
 *
 * `elementsFromPoint` returns the *entire* z-order stack at a point (every element whose box
 * contains it, topmost first) — not just the hit-test winner. Only the topmost entry reflects
 * what is actually drawn on top at that point, so only `stack[0]` counts as a hit.
 */
export function isOccluded(el: Element, box: DOMRectReadOnly): boolean {
  const fractions = [1 / 6, 3 / 6, 5 / 6];
  let hits = 0;
  for (const fy of fractions) {
    for (const fx of fractions) {
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      const [topmost] = document.elementsFromPoint(x, y);
      if (topmost && el.contains(topmost)) hits += 1;
    }
  }
  return hits < 3;
}

/**
 * design.md §3.1's `z` field: "stacking rank from occlusion probing" — where `el` (or its
 * descendant) sits in the full z-order stack at the box's center point. 0 is topmost; a higher
 * number means more elements are drawn on top of it there.
 */
export function computeStackingRank(el: Element, box: DOMRectReadOnly): number {
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const stack = document.elementsFromPoint(centerX, centerY);
  const index = stack.findIndex((candidate) => el.contains(candidate));
  return index === -1 ? stack.length : index;
}
