// design.md §7.5 — the additive compositor. Real Chromium (browser project), not jsdom:
// `OffscreenCanvas`, `ImageBitmap` and 2D canvas drawing need a real implementation, exactly the
// same reasoning phase_2_spine.md's DOM-layout tests already established for this repo.

import { describe, expect, it } from 'vitest';
import { compose, GREY_FILL } from '../../src/perception/compose/compositor';

async function solidBitmap(width: number, height: number, color: string): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return createImageBitmap(canvas);
}

function pixelAt(canvas: OffscreenCanvas, x: number, y: number): [number, number, number, number] {
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(x, y, 1, 1);
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Text rendering leaves gaps between/within glyphs — the exact center pixel of a label isn't
 * reliably "inside a stroke," so label-presence checks scan a horizontal band through the box's
 * vertical center for at least one white pixel, rather than asserting one exact coordinate.
 * "White" is a near-white threshold, not an exact (255,255,255) match — real, measured (T-6.1,
 * 2026-09-26): real headless Firefox's small-font (~9-10px) text anti-aliasing at this exact
 * placeholder string's row tops out at 239 per channel, never hitting pure 255, while Chromium's
 * own anti-aliasing does — both browsers genuinely render the label, this is a rasterizer
 * precision difference between engines, not a redaction/compositor bug. */
const NEAR_WHITE_THRESHOLD = 200;
function hasWhitePixelInRow(canvas: OffscreenCanvas, y: number, xStart: number, xEnd: number): boolean {
  for (let x = xStart; x <= xEnd; x++) {
    const [r, g, b] = pixelAt(canvas, x, y);
    if (r >= NEAR_WHITE_THRESHOLD && g >= NEAR_WHITE_THRESHOLD && b >= NEAR_WHITE_THRESHOLD) return true;
  }
  return false;
}

describe('compose (T-4.16, phase_4_vision.md §7)', () => {
  it('a region with no positive clearance is grey by default', async () => {
    const bitmap = await solidBitmap(100, 100, '#ff0000');
    const output = compose({ bitmap, cleared: [], regions: [], scale: 1 });
    const [r, g, b] = pixelAt(output.canvas, 50, 50);
    const [gr, gg, gb] = hexToRgb(GREY_FILL);
    expect([r, g, b]).toEqual([gr, gg, gb]);
  });

  it('a positively-cleared region is copied in from the real bitmap', async () => {
    const bitmap = await solidBitmap(100, 100, '#00ff00');
    const output = compose({ bitmap, cleared: [[0, 0, 100, 100]], regions: [], scale: 1 });
    const [r, g, b] = pixelAt(output.canvas, 50, 50);
    expect([r, g, b]).toEqual([0, 255, 0]);
  });

  it('a redaction box is drawn solid black over cleared content, never left showing through', async () => {
    const bitmap = await solidBitmap(100, 100, '#00ff00');
    const output = compose({
      bitmap,
      cleared: [[0, 0, 100, 100]],
      regions: [{ entity: 'AADHAAR', boxes: [[10, 10, 30, 30]], placeholder: '⟪AADHAAR#1⟫' }],
      scale: 1,
    });
    const [r, g, b] = pixelAt(output.canvas, 20, 20);
    expect([r, g, b]).toEqual([0, 0, 0]);
  });

  it('coverage sums to ~1 across cleared + redacted + unanalysed', async () => {
    const bitmap = await solidBitmap(100, 100, '#0000ff');
    const output = compose({
      bitmap,
      cleared: [[0, 0, 50, 100]],
      regions: [{ entity: 'FACE', boxes: [[60, 0, 20, 20]], placeholder: null }],
      scale: 1,
    });
    const { cleared, redacted, unanalysed } = output.coverage;
    expect(cleared + redacted + unanalysed).toBeCloseTo(1, 1);
    expect(cleared).toBeGreaterThan(0);
    expect(redacted).toBeGreaterThan(0);
    expect(unanalysed).toBeGreaterThan(0);
  });

  it('a crashed/uncleared capture (no cleared boxes, no regions) is entirely grey — AC-7', async () => {
    const bitmap = await solidBitmap(50, 50, '#ffffff');
    const output = compose({ bitmap, cleared: [], regions: [], scale: 1 });
    expect(output.coverage.cleared).toBe(0);
    expect(output.coverage.redacted).toBe(0);
    for (const [x, y] of [[0, 0], [49, 49], [25, 25]] as const) {
      const [r, g, b] = pixelAt(output.canvas, x, y);
      const [gr, gg, gb] = hexToRgb(GREY_FILL);
      expect([r, g, b]).toEqual([gr, gg, gb]);
    }
  });

  // T-6.9, design.md §18.3 — the black-box ablation arm's image-side half: "render redactions as
  // unlabelled black boxes." The JSON side already sends no ref under that arm
  // (`host/privacy/context/builder.ts`'s own `ablation === 'blackbox'` check); this is the only
  // place a NON-resolvable entity's type name (`FACE` etc, drawn even with `placeholder: null`
  // today) could still visually leak through the image alone.
  describe('unlabelled (T-6.9, black-box ablation arm)', () => {
    const bigBox: [number, number, number, number] = [10, 10, 100, 60];

    it('by default, a real placeholder ref is drawn as a white label inside the box', async () => {
      const bitmap = await solidBitmap(150, 100, '#00ff00');
      const output = compose({
        bitmap,
        cleared: [[0, 0, 150, 100]],
        regions: [{ entity: 'AADHAAR', boxes: [bigBox], placeholder: '⟪AADHAAR#1⟫' }],
        scale: 1,
      });
      expect(hasWhitePixelInRow(output.canvas, 40, 10, 109)).toBe(true);
    });

    it('by default, a non-resolvable entity (FACE) still draws its type name as a fallback label', async () => {
      const bitmap = await solidBitmap(150, 100, '#00ff00');
      const output = compose({
        bitmap,
        cleared: [[0, 0, 150, 100]],
        regions: [{ entity: 'FACE', boxes: [bigBox], placeholder: null }],
        scale: 1,
      });
      expect(hasWhitePixelInRow(output.canvas, 40, 10, 109)).toBe(true);
    });

    it('unlabelled: true suppresses the placeholder label — pure black, no text', async () => {
      const bitmap = await solidBitmap(150, 100, '#00ff00');
      const output = compose({
        bitmap,
        cleared: [[0, 0, 150, 100]],
        regions: [{ entity: 'AADHAAR', boxes: [bigBox], placeholder: '⟪AADHAAR#1⟫' }],
        scale: 1,
        unlabelled: true,
      });
      expect(hasWhitePixelInRow(output.canvas, 40, 10, 109)).toBe(false);
    });

    it('unlabelled: true ALSO suppresses the non-resolvable-entity type-name fallback (FACE etc)', async () => {
      const bitmap = await solidBitmap(150, 100, '#00ff00');
      const output = compose({
        bitmap,
        cleared: [[0, 0, 150, 100]],
        regions: [{ entity: 'FACE', boxes: [bigBox], placeholder: null }],
        scale: 1,
        unlabelled: true,
      });
      expect(hasWhitePixelInRow(output.canvas, 40, 10, 109)).toBe(false);
    });
  });
});
