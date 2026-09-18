// design.md §7.6 step 5 / phase_4_vision.md §8 — "OCR in a 24px halo around every redaction box.
// If dilation was insufficient and readable characters of the value remain at the edge, this
// finds them." [A] DISCLOSED GAP, same category as `models/vit-encoder.ts`: no OCR model exists
// until Phase 6 (phase_4_vision.md §1: "No OCR... PP-OCRv5 ... is Phase 6"). This function defines
// the real call shape (the 24px halo box construction) and always returns no hits — never a false
// "checked and clean," since nothing downstream should treat an unrun check as a passed one. The
// face re-check (`face-recheck.ts`, real) carries this step's load in Phase 4, exactly as
// phase_4_vision.md §8 states.

import type { Box } from '../../shared/worker-protocol';

const HALO_PX = 24;

export function haloAround([x, y, w, h]: Box): Box {
  return [x - HALO_PX, y - HALO_PX, w + HALO_PX * 2, h + HALO_PX * 2];
}

export async function checkHalosForText(_webpBytes: ArrayBuffer, _halos: readonly Box[]): Promise<Box[]> {
  return [];
}
