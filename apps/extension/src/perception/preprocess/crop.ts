// Extracts a sub-region of a full-frame `ImageBitmap` into its own `OffscreenCanvas` — the shape
// `models/face.ts`'s `detectFaces` and `models/vit-encoder.ts`'s `classifyRegion` expect (a crop
// already isolated to one candidate region, box-relative decode handled by the caller).

import type { Box } from '../../shared/worker-protocol';

export function cropRegion(source: ImageBitmap, box: Box): OffscreenCanvas {
  const [x, y, w, h] = box;
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(source, x, y, cw, ch, 0, 0, cw, ch);
  return canvas;
}
