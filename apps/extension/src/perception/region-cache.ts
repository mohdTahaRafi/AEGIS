// Per-crop reuse of face/OCR/CLIP results across steps. Keyed by an EXACT hash of the crop's
// pixels (plus its size and which models ran), never a perceptual hash: the models are
// deterministic, so identical pixels give identical findings, while any changed pixel (new text
// in an image, a different CAPTCHA) is a miss and is analysed afresh. Nothing here can make a
// region look cleaner than a fresh run would.
//
// Stored boxes are relative to the crop, so a cached image that merely moved (scrolling) is
// re-placed at its new position.

import type { Box } from '../shared/worker-protocol';

export interface CachedRegionResult<TCandidate extends { box: Box; entity: string }, TDiagnostic> {
  faces: { box: Box; score: number }[];
  ocrHits: TCandidate[];
  vitEntity: TCandidate['entity'] | null;
  vitScore?: number;
  diagnostic: TDiagnostic;
}

const MAX_ENTRIES = 128;

/** FNV-1a over the RGBA bytes, two independent 32-bit lanes (≈64 bits), plus the dimensions. */
export function pixelKey(width: number, height: number, rgba: Uint8ClampedArray, modelsTag: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    a = Math.imul(a ^ w, 0x01000193);
    b = Math.imul(b ^ ((w >>> 16) | (w << 16)), 0x01000193) + i;
  }
  return `${modelsTag}:${width}x${height}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function shift(box: Box, dx: number, dy: number): Box {
  return [box[0] + dx, box[1] + dy, box[2], box[3]];
}

export class RegionResultCache<TCandidate extends { box: Box; entity: string; regionId?: string }, TDiagnostic> {
  private readonly entries = new Map<string, CachedRegionResult<TCandidate, TDiagnostic>>();

  /** The cached result re-placed at `regionBox`/`regionId`, or undefined on a miss. */
  get(key: string, regionBox: Box, regionId: string): CachedRegionResult<TCandidate, TDiagnostic> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key); // LRU: re-insert as most recent
    this.entries.set(key, hit);
    const [x, y] = regionBox;
    return {
      ...hit,
      faces: hit.faces.map((f) => ({ ...f, box: shift(f.box, x, y) })),
      ocrHits: hit.ocrHits.map((c) => ({ ...c, box: shift(c.box, x, y), regionId })),
    };
  }

  /** Stores `result` (boxes absolute at `regionBox`) in crop-relative form. */
  set(key: string, regionBox: Box, result: CachedRegionResult<TCandidate, TDiagnostic>): void {
    const [x, y] = regionBox;
    this.entries.set(key, {
      ...result,
      faces: result.faces.map((f) => ({ ...f, box: shift(f.box, -x, -y) })),
      ocrHits: result.ocrHits.map((c) => ({ ...c, box: shift(c.box, -x, -y) })),
    });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}
