// design.md §6.4/§7.1, T-6.5/T-6.6 — OCR on the DETECTION side: finding NEW PII in a region the
// DOM never explained (canvas, video, img), as opposed to `rescan/halo.ts`'s post-compose safety
// net, which only re-checks pixels already decided to be redacted (T-4.18). Reuses that file's
// detect→crop→recognize→"non-empty decode" bar, then runs the decoded line text through the same
// deterministic recognizers Channel T already uses for DOM text (`@aegis/recognizers`'s
// `findAll`) — `perception` may import `packages/*` at runtime (architecture §15.3: pure logic,
// no browser APIs), so this stays a self-contained worker-side pass rather than a new host round
// trip carrying raw decoded text back across the worker/host boundary.
//
// Script routing (T-6.4) is deliberately NOT applied here: like `rescan/halo.ts`, this always
// uses the Latin/English recognizer, a disclosed coarse simplification (a Devanagari canvas/PDF
// region would OCR-detect but fail to recognize) — not this task's scope, since it would need the
// page's language threaded into the `perceive` message, which nothing currently does.

import type * as ort from 'onnxruntime-web';
import { findAll } from '@aegis/recognizers';
import type { Box, Candidate } from '../../shared/worker-protocol';
import { detectText } from '../models/ocr-det';
import { recognizeLine } from '../models/ocr-rec';
import type { OcrRescanModels } from '../rescan/halo';

function hasReadableContent(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * `regionCrop` is already isolated to one vision node's box by the caller (the same `cropRegion`
 * call site `detectFaces` shares). `sourceBox` is that box's own page-coordinate offset.
 *
 * Design.md §7.1 step 8 ("OCR line fallback"): this recognizer's CTC decode gives per-line text,
 * not per-character positions, so there is nothing to proportionally split — every match fails
 * closed to the whole detected line's box, never a guessed sub-span. That makes this the
 * "otherwise line-level redaction" branch unconditionally, not a fallback from a word-level path
 * that doesn't exist here.
 */
export async function detectTextEntitiesInRegion(
  ort_: typeof ort,
  models: OcrRescanModels,
  regionCrop: OffscreenCanvas,
  regionId: string,
  sourceBox: Box,
): Promise<Candidate[]> {
  const [srcX, srcY] = sourceBox;
  const candidates: Candidate[] = [];

  const lines = await detectText(models.detSession, ort_, regionCrop);
  for (const line of lines) {
    const [lx, ly, lw, lh] = line.box;
    const w = Math.max(1, Math.round(lw));
    const h = Math.max(1, Math.round(lh));
    const lineCanvas = new OffscreenCanvas(w, h);
    lineCanvas.getContext('2d')!.drawImage(regionCrop, lx, ly, lw, lh, 0, 0, w, h);

    const recognized = await recognizeLine(models.recSession, ort_, lineCanvas, models.vocabulary);
    if (!hasReadableContent(recognized.text)) continue;

    const box: Box = [srcX + lx, srcY + ly, lw, lh];
    for (const match of findAll(recognized.text)) {
      candidates.push({
        entity: match.entity,
        box,
        score: match.score,
        regionId,
        channel: 'text-ocr',
        source: match.source,
        value: match.matchedText,
      });
    }
  }
  return candidates;
}
