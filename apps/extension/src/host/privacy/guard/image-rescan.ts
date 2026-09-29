// design.md §7.6 step 5 / phase_4_vision.md §8 — the guard's image re-scan, run on the *composed
// output* rather than the input: independent checks that a wrongly-cleared region didn't let a
// face or readable sensitive text at a redaction box's edge through. Each finding is blacked out
// where it is and the image re-checked, a bounded number of times; an image that still is not clean
// is never sent — the guard then blocks the step, which is retried from a fresh capture (every step
// carries a screenshot, so there is no text-only fallback).

import type { Box } from '../types';

export interface RescanHit {
  box: Box;
}

export interface RescanResult {
  /** Faces found on the composed image — always hits. */
  hits: RescanHit[];
  /** Text read in the rings around the redaction boxes (boxes masked first). Only text the guard's
   * `isSensitiveText` flags counts as a hit; with no predicate, any text counts. */
  ringText?: { box: Box; text: string }[];
}

export interface RedactionRegion {
  entity: string;
  boxes: Box[];
  placeholder: string | null;
}

export interface ImageRescanDeps {
  /** Runs face-detection (+ OCR halo check, once Phase 6 wires it) over the composed image. */
  rescan: (imageBytes: ArrayBuffer, redactionBoxes: readonly Box[]) => Promise<RescanResult>;
  /** Recomposes with the given (already-dilated) regions, returning new image bytes. Takes whole
   * regions, not a flat box list, so entity/placeholder association survives the dilation —
   * `compose()`'s label-drawing step needs to know which placeholder belongs to which box. */
  recompose: (dilatedRegions: readonly RedactionRegion[]) => Promise<ArrayBuffer>;
  /** Supplied by the guard (it holds the recognizers and the vault). */
  isSensitiveText?: (text: string) => boolean;
}

export type ImageRescanOutcome =
  | { verdict: 'clean'; imageBytes: ArrayBuffer }
  | { verdict: 'recomposed'; imageBytes: ArrayBuffer }
  | { verdict: 'dropped' };

const DILATION_FACTOR = 0.5;
/** Recompose-and-recheck rounds before the image is given up on for this capture. */
export const MAX_RECOMPOSE_ROUNDS = 3;

/** design.md §7.5's box-dilation for this step specifically (distinct from `fusion/dilate.ts`'s
 * fixed +2px/+8% text-label dilation, which serves a different purpose — clamping a text span's
 * highlight box against siblings, not widening a redaction box before a pixel re-check). Expands
 * symmetrically around the box's own center by `factor`. */
export function dilateForRescan([x, y, w, h]: Box, factor = DILATION_FACTOR): Box {
  const dx = (w * factor) / 2;
  const dy = (h * factor) / 2;
  return [x - dx, y - dy, w + dx * 2, h + dy * 2];
}

function hitBoxes(result: RescanResult, isSensitiveText: ((text: string) => boolean) | undefined): { faces: Box[]; text: Box[] } {
  const ring = result.ringText ?? [];
  return {
    faces: result.hits.map((h) => h.box),
    text: (isSensitiveText ? ring.filter((r) => isSensitiveText(r.text)) : ring).map((r) => r.box),
  };
}

/**
 * `imageBytes`/`regions` are the just-composed L1/L2 output and the regions that produced it. A hit
 * is covered where it is — the face or the text found gets its own black box and every redaction
 * box is widened — rather than greying the whole picture: the rest of the frame was screened and is
 * no less clean than before. Coverage only ever grows between rounds (bounded by
 * `MAX_RECOMPOSE_ROUNDS`, so it cannot spin).
 */
export async function runImageRescan(imageBytes: ArrayBuffer, regions: readonly RedactionRegion[], deps: ImageRescanDeps): Promise<ImageRescanOutcome> {
  let found = hitBoxes(await deps.rescan(imageBytes, regions.flatMap((r) => r.boxes)), deps.isSensitiveText);
  if (found.faces.length === 0 && found.text.length === 0) return { verdict: 'clean', imageBytes };

  let covered: RedactionRegion[] = regions.map((r) => ({ ...r, boxes: r.boxes.map((b) => dilateForRescan(b)) }));
  for (let round = 0; round < MAX_RECOMPOSE_ROUNDS; round++) {
    covered = [
      ...covered,
      ...found.faces.map((box) => ({ entity: 'FACE', boxes: [dilateForRescan(box, 0.2)], placeholder: null })),
      ...found.text.map((box) => ({ entity: 'UNKNOWN_SENSITIVE', boxes: [dilateForRescan(box, 0.2)], placeholder: null })),
    ];
    const recomposedBytes = await deps.recompose(covered);
    found = hitBoxes(await deps.rescan(recomposedBytes, covered.flatMap((r) => r.boxes)), deps.isSensitiveText);
    if (found.faces.length === 0 && found.text.length === 0) return { verdict: 'recomposed', imageBytes: recomposedBytes };
  }
  return { verdict: 'dropped' };
}
