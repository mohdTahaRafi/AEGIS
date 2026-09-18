// design.md §7.6 step 5 / phase_4_vision.md §8 — the guard's image re-scan, run on the *composed
// output* rather than the input: independent checks that a wrongly-cleared region didn't let a
// face (or, once Phase 6's OCR exists, readable text at a redaction box's edge) through. One
// recompose at +50% dilation, then drop the image entirely and fall back to L0 — sending a
// questionable image is never an option; degrading to text-only always is.

import type { Box } from '../types';

export interface RescanHit {
  box: Box;
}

export interface RescanResult {
  hits: RescanHit[];
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
}

export type ImageRescanOutcome =
  | { verdict: 'clean'; imageBytes: ArrayBuffer }
  | { verdict: 'recomposed'; imageBytes: ArrayBuffer }
  | { verdict: 'dropped' };

const DILATION_FACTOR = 0.5;

/** design.md §7.5's box-dilation for this step specifically (distinct from `fusion/dilate.ts`'s
 * fixed +2px/+8% text-label dilation, which serves a different purpose — clamping a text span's
 * highlight box against siblings, not widening a redaction box before a pixel re-check). Expands
 * symmetrically around the box's own center by `factor`. */
export function dilateForRescan([x, y, w, h]: Box, factor = DILATION_FACTOR): Box {
  const dx = (w * factor) / 2;
  const dy = (h * factor) / 2;
  return [x - dx, y - dy, w + dx * 2, h + dy * 2];
}

/**
 * `imageBytes`/`regions` are the just-composed L1/L2 output and the regions that produced it.
 * Runs at most one recompose cycle (design.md's "one recompose ... then drop" — never a second
 * retry loop that could spin).
 */
export async function runImageRescan(imageBytes: ArrayBuffer, regions: readonly RedactionRegion[], deps: ImageRescanDeps): Promise<ImageRescanOutcome> {
  const flatBoxes = regions.flatMap((r) => r.boxes);
  const first = await deps.rescan(imageBytes, flatBoxes);
  if (first.hits.length === 0) return { verdict: 'clean', imageBytes };

  const dilatedRegions = regions.map((r) => ({ ...r, boxes: r.boxes.map((b) => dilateForRescan(b)) }));
  const recomposedBytes = await deps.recompose(dilatedRegions);
  const second = await deps.rescan(recomposedBytes, dilatedRegions.flatMap((r) => r.boxes));
  if (second.hits.length === 0) return { verdict: 'recomposed', imageBytes: recomposedBytes };

  return { verdict: 'dropped' };
}
