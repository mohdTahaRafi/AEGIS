// Text runs as the recognizers and the whole-frame OCR see them: a paragraph with inline links is
// ONE run of its whole text (its own words used to be read by nobody), and a value inside it can be
// measured to its own rectangles on screen.
import { afterEach, describe, expect, it } from 'vitest';
import { extractTextRuns, measureRunSpan } from '../../src/content/detect/spans';
import { waitForVisualReady, pendingViewportImages } from '../../src/content/observe/ready';

const VIEWPORT = { width: 1280, height: 800, verticalMarginPx: 800 };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('text runs', () => {
  it('a paragraph with inline links is one run of its whole text', () => {
    document.body.innerHTML = '<p style="width:600px;font:16px monospace">Call <a href="#">me</a> at 98765 43210 <b>today</b></p>';
    const runs = extractTextRuns(document.body, VIEWPORT);
    expect(runs.map((r) => r.text)).toEqual(['Call me at 98765 43210 today']);
  });

  it('block children keep their own runs', () => {
    document.body.innerHTML = '<div>Intro<div>First block</div><div>Second block</div></div>';
    const texts = extractTextRuns(document.body, VIEWPORT).map((r) => r.text);
    expect(texts).toEqual(expect.arrayContaining(['First block', 'Second block']));
  });

  it("measures a value's own rectangle inside the paragraph", () => {
    document.body.innerHTML = '<p style="width:600px;font:16px monospace;margin:0">Call <a href="#">me</a> at 98765 43210 today</p>';
    const [run] = extractTextRuns(document.body, VIEWPORT);
    const start = run!.text.indexOf('98765');
    const rects = measureRunSpan(run!.id, start, start + '98765 43210'.length);
    expect(rects.length).toBe(1);
    const [x, , w] = rects[0]!;
    // 11 monospace characters, starting after "Call me at " (11 characters).
    const char = w / 11;
    expect(x).toBeGreaterThan(char * 10);
    expect(w).toBeLessThan(run!.box[2]);
  });
});

describe('page readiness', () => {
  it('waits for a picture in the viewport to finish loading', async () => {
    document.body.innerHTML = '<img id="p" width="100" height="100">';
    const img = document.getElementById('p') as HTMLImageElement;
    // A picture that has not loaded yet: complete stays false until a src arrives.
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>')}`;
    const ready = await waitForVisualReady(3000);
    expect(ready.timedOut).toBe(false);
    expect(pendingViewportImages()).toBe(0);
  });
});
