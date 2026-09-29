// design.md §7.6 step 5 / phase_4_vision.md §8 — "OCR in a 24px halo around every redaction box.
// If dilation was insufficient and readable characters of the value remain at the edge, this
// finds them." Real as of T-6.3/T-6.4 (Phase 6): the face re-check (`face-recheck.ts`) carried
// this step's whole load through Phase 4-5 while no OCR model existed; this now runs the real
// bundled PP-OCRv5 detector+recognizer over each halo crop of the COMPOSED (already-redacted)
// image. A "hit" here means detection found a text-shaped region AND recognition decoded
// non-trivial text from it — detection alone would flag DB's own thresholded-noise false
// positives too often to be a useful safety net; requiring an actual decoded character is what
// "readable characters... remain" in the design doc's own wording means.

import type * as ort from 'onnxruntime-web';
import type { Box } from '../../shared/worker-protocol';
import { detectText } from '../models/ocr-det';
import { recognizeLine } from '../models/ocr-rec';
import { mergeUp } from '../compose/merge-up';

const HALO_PX = 24;

export function haloAround([x, y, w, h]: Box): Box {
  return [x - HALO_PX, y - HALO_PX, w + HALO_PX * 2, h + HALO_PX * 2];
}

// A DB detector can fire on pure noise/compression artifacts at a very low, non-zero confidence;
// requiring at least one real decoded (non-space) character is the actual "readable" signal — an
// empty or all-space CTC decode means nothing survived the blank/duplicate collapse, i.e. no real
// character was confidently recognized, regardless of what the detector's own score said.
function hasReadableContent(text: string): boolean {
  return text.trim().length > 0;
}

export interface OcrRescanModels {
  detSession: ort.InferenceSession;
  recSession: ort.InferenceSession;
  vocabulary: readonly string[];
}

export async function checkHalosForText(ort_: typeof ort, models: OcrRescanModels | null, webpBytes: ArrayBuffer, halos: readonly Box[]): Promise<Box[]> {
  if (!models || halos.length === 0) return [];

  const blob = new Blob([webpBytes], { type: 'image/webp' });
  const bitmap = await createImageBitmap(blob);
  const hits: Box[] = [];

  try {
    for (const halo of halos) {
      const [hx, hy, hw, hh] = halo;
      // Clamp to the actual image bounds — a redaction box near an edge produces a halo that
      // extends past it, and `createImageBitmap`'s crop options don't clamp for you.
      const x = Math.max(0, hx);
      const y = Math.max(0, hy);
      const w = Math.min(bitmap.width, hx + hw) - x;
      const h = Math.min(bitmap.height, hy + hh) - y;
      if (w <= 0 || h <= 0) continue;

      const cropCanvas = new OffscreenCanvas(Math.round(w), Math.round(h));
      cropCanvas.getContext('2d')!.drawImage(bitmap, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);

      const lines = await detectText(models.detSession, ort_, cropCanvas);
      for (const line of lines) {
        const [lx, ly, lw, lh] = line.box;
        const lineCanvas = new OffscreenCanvas(Math.max(1, Math.round(lw)), Math.max(1, Math.round(lh)));
        lineCanvas.getContext('2d')!.drawImage(cropCanvas, lx, ly, lw, lh, 0, 0, lineCanvas.width, lineCanvas.height);

        const recognized = await recognizeLine(models.recSession, ort_, lineCanvas, models.vocabulary);
        if (hasReadableContent(recognized.text)) {
          hits.push([x + lx, y + ly, lw, lh]);
        }
      }
    }
  } finally {
    bitmap.close();
  }

  return hits;
}

function clampToImage([x, y, w, h]: Box, width: number, height: number): Box | null {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** Reads the text around redaction boxes on an image whose boxes have ALREADY been masked solid
 * black (so the placeholder labels the compositor drew inside them can never be read back and
 * mistaken for a leak). Overlapping halos are merged first, so a stack of adjacent rows costs one
 * detection pass instead of one per row. Returns what was read; deciding whether any of it is
 * sensitive is the host guard's job (it holds the recognizers and the vault). */
export async function readHaloText(ort_: typeof ort, models: OcrRescanModels | null, masked: OffscreenCanvas, halos: readonly Box[]): Promise<{ box: Box; text: string }[]> {
  if (!models || halos.length === 0) return [];
  const regions = mergeUp(halos.map((h) => clampToImage(h, masked.width, masked.height)).filter((b): b is Box => b !== null), 0);
  const out: { box: Box; text: string }[] = [];
  for (const [x, y, w, h] of regions) {
    const crop = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    crop.getContext('2d')!.drawImage(masked, x, y, w, h, 0, 0, crop.width, crop.height);
    for (const line of await detectText(models.detSession, ort_, crop)) {
      const [lx, ly, lw, lh] = line.box;
      const lineCanvas = new OffscreenCanvas(Math.max(1, Math.round(lw)), Math.max(1, Math.round(lh)));
      lineCanvas.getContext('2d')!.drawImage(crop, lx, ly, lw, lh, 0, 0, lineCanvas.width, lineCanvas.height);
      const recognized = await recognizeLine(models.recSession, ort_, lineCanvas, models.vocabulary);
      if (hasReadableContent(recognized.text)) out.push({ box: [x + lx, y + ly, lw, lh], text: recognized.text });
    }
  }
  return out;
}
