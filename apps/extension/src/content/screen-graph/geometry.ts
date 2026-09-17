// design.md §5.2/§10.2's performance note: read all geometry in one pass, never interleaved with
// writes — the easiest way to blow the ≤10ms observe budget is layout thrash. Needs real layout,
// so this is exercised by test/browser/ (real Chromium), not jsdom.

export type Box = [x: number, y: number, w: number, h: number];

export function boxFromRect(rect: DOMRectReadOnly): Box {
  return [rect.x, rect.y, rect.width, rect.height];
}

/**
 * Reads `getBoundingClientRect()` for every element in one uninterrupted pass. Callers must not
 * perform any DOM write between calling this and using the results — that reintroduces the layout
 * thrash this function exists to avoid (T-2.10).
 */
export function readBoxesInOnePass(elements: readonly Element[]): Map<Element, DOMRectReadOnly> {
  const boxes = new Map<Element, DOMRectReadOnly>();
  for (const el of elements) {
    boxes.set(el, el.getBoundingClientRect());
  }
  return boxes;
}

/**
 * design.md §5.2's highest-leverage primitive: the exact pixel rectangle(s) of a character span
 * inside a text node, via `Range.getClientRects()`. A span that wraps across a line break returns
 * one rect per visual line — that is a feature, not a bug, for redaction geometry (metric 3).
 */
export function getCharSpanRects(textNode: Text, start: number, end: number): Box[] {
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = Array.from(range.getClientRects());
  range.detach();
  return rects.map(boxFromRect);
}
