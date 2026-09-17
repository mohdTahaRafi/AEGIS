import { afterEach, describe, expect, it } from 'vitest';
import { getCharSpanRects, readBoxesInOnePass } from '../../src/content/screen-graph/geometry';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readBoxesInOnePass (T-2.10 — one uninterrupted read pass)', () => {
  it('reads every element exactly once, with no redundant re-reads', () => {
    document.body.innerHTML = '<div></div><div></div><div></div><div></div><div></div>';
    const elements = Array.from(document.querySelectorAll('div'));
    let callCount = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      callCount += 1;
      return original.call(this);
    };
    try {
      const boxes = readBoxesInOnePass(elements);
      expect(callCount).toBe(elements.length);
      expect(boxes.size).toBe(elements.length);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('returns the real rect for each element, keyed by element identity', () => {
    document.body.innerHTML = '<div id="a" style="width:10px;height:5px;"></div><div id="b" style="width:20px;height:8px;"></div>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const boxes = readBoxesInOnePass([a, b]);
    expect(boxes.get(a)!.width).toBe(10);
    expect(boxes.get(a)!.height).toBe(5);
    expect(boxes.get(b)!.width).toBe(20);
    expect(boxes.get(b)!.height).toBe(8);
  });
});

describe('getCharSpanRects (T-2.11 — Range.getClientRects() character-span geometry)', () => {
  it('gives a phone number inside a paragraph a tight rect, not the paragraph rect', () => {
    document.body.innerHTML =
      '<p id="p" style="width:180px;font-family:monospace;font-size:14px;">' +
      'Contact us at 555-123-4567 for support any time of day or night.</p>';
    const p = document.getElementById('p')!;
    const textNode = p.firstChild as Text;
    const text = textNode.textContent!;
    const phone = '555-123-4567';
    const start = text.indexOf(phone);
    const end = start + phone.length;

    const phoneRects = getCharSpanRects(textNode, start, end);
    const paragraphBox = p.getBoundingClientRect();
    const phoneWidth = phoneRects.reduce((sum, [, , w]) => sum + w, 0);

    expect(phoneRects.length).toBeGreaterThan(0);
    expect(phoneWidth).toBeLessThan(paragraphBox.width * 0.6);
    for (const [x, , w] of phoneRects) {
      expect(x).toBeGreaterThanOrEqual(paragraphBox.left - 1);
      expect(x + w).toBeLessThanOrEqual(paragraphBox.right + 1);
    }
  });

  it('returns one rect per visual line for a span crossing a soft line-break', () => {
    document.body.innerHTML =
      '<p id="p" style="width:80px;font-family:monospace;font-size:16px;">alpha beta gamma delta epsilon</p>';
    const p = document.getElementById('p')!;
    const textNode = p.firstChild as Text;
    const text = textNode.textContent!;

    // Measure each word's own line (top y) without assuming font metrics.
    const words = text.split(' ');
    const wordSpans: { start: number; end: number; top: number }[] = [];
    let offset = 0;
    for (const word of words) {
      const start = offset;
      const end = offset + word.length;
      const rects = getCharSpanRects(textNode, start, end);
      const [, top] = rects[0]!;
      wordSpans.push({ start, end, top });
      offset = end + 1;
    }

    const boundary = wordSpans.slice(0, -1).findIndex((w, i) => w.top !== wordSpans[i + 1]!.top);
    expect(boundary).toBeGreaterThanOrEqual(0); // sanity: the paragraph really did wrap

    const crossing = getCharSpanRects(textNode, wordSpans[boundary]!.start, wordSpans[boundary + 1]!.end);
    expect(crossing.length).toBe(2);
  });

  it('returns a single rect for a span that stays on one line', () => {
    document.body.innerHTML = '<p id="p" style="width:400px;">short line</p>';
    const p = document.getElementById('p')!;
    const textNode = p.firstChild as Text;
    const rects = getCharSpanRects(textNode, 0, textNode.textContent!.length);
    expect(rects.length).toBe(1);
  });
});
