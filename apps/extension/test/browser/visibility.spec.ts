import { afterEach, describe, expect, it } from 'vitest';
import { isOccluded, isVisible, type ViewportExtent } from '../../src/content/screen-graph/visibility';

const viewport: ViewportExtent = { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isVisible (design.md §5.3, real Chromium layout)', () => {
  it('a plain visible element passes', () => {
    document.body.innerHTML = '<button id="t">Submit</button>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(true);
  });

  it('excludes a visibility:hidden element', () => {
    document.body.innerHTML = '<button id="t" style="visibility:hidden">Submit</button>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('excludes a display:none element (zero box)', () => {
    document.body.innerHTML = '<button id="t" style="display:none">Submit</button>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('excludes an inert element', () => {
    document.body.innerHTML = '<button id="t" inert>Submit</button>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('excludes an inert-ancestor element', () => {
    document.body.innerHTML = '<div inert><button id="t">Submit</button></div>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('excludes an element inside aria-hidden="true"', () => {
    document.body.innerHTML = '<div aria-hidden="true"><button id="t">Submit</button></div>';
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('excludes an element scrolled far outside the extended viewport', () => {
    document.body.innerHTML = `<button id="t" style="position:absolute; top:${window.innerHeight * 5}px;">Submit</button>`;
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(false);
  });

  it('includes an element one viewport height below the fold (the extended-viewport margin)', () => {
    document.body.innerHTML = `<button id="t" style="position:absolute; top:${window.innerHeight + 10}px;">Submit</button>`;
    const el = document.getElementById('t')!;
    expect(isVisible(el, el.getBoundingClientRect(), viewport)).toBe(true);
  });
});

describe('isOccluded — 3×3 elementsFromPoint probe (design.md §5.3)', () => {
  it('a plain unobstructed element is not occluded', () => {
    document.body.innerHTML = '<button id="t" style="width:120px;height:40px;">Submit</button>';
    const el = document.getElementById('t')!;
    expect(isOccluded(el, el.getBoundingClientRect())).toBe(false);
  });

  it('marks a fully covered element occluded, but isVisible still keeps it (kept, not dropped)', () => {
    // box-sizing/border/padding reset: a bare <button> has UA-default padding+border on top of
    // content-box sizing, so its rendered box would be larger than the 200×100 the overlay covers.
    document.body.innerHTML = `
      <div style="position:relative;width:200px;height:100px;">
        <button id="target" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:100px;">Submit</button>
        <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:100px;background:transparent;"></div>
      </div>
    `;
    const target = document.getElementById('target')!;
    const box = target.getBoundingClientRect();
    expect(isVisible(target, box, viewport)).toBe(true);
    expect(isOccluded(target, box)).toBe(true);
  });

  it('does not mark a partially covered element occluded when ≥3 of 9 samples still hit it', () => {
    document.body.innerHTML = `
      <div style="position:relative;width:200px;height:100px;">
        <button id="target" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:100px;">Submit</button>
        <div id="overlay" style="position:absolute;top:0;left:0;width:60px;height:100px;background:transparent;"></div>
      </div>
    `;
    const target = document.getElementById('target')!;
    const box = target.getBoundingClientRect();
    // Overlay covers the left third only: the middle and right columns of the 3×3 grid still hit target.
    expect(isOccluded(target, box)).toBe(false);
  });
});
