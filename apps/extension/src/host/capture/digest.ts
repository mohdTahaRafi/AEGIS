// design.md §5.8 / phase_4_vision.md §5.2 — the redaction-geometry digest. A screenshot is
// asynchronous; between requesting it and receiving it the page can scroll, reflow or mutate, and
// redaction boxes computed from the *old* geometry would no longer cover the sensitive content in
// the *new* pixels. Hash the rounded boxes of every node/text-span carrying a redaction decision,
// computed in the same animation frame as the capture request, and recompute when the capture
// resolves — a mismatch discards the capture rather than shipping a black box next to exposed
// content.

export interface GeometryBox {
  id: string;
  box: readonly [number, number, number, number];
}

/** Rounds to whole pixels before hashing — sub-pixel layout jitter between two reads of the
 * *same* unchanged geometry must not register as a mismatch. */
function roundedKey(g: GeometryBox): string {
  const [x, y, w, h] = g.box;
  return `${g.id}:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

export async function computeGeometryDigest(boxes: readonly GeometryBox[]): Promise<string> {
  const sorted = [...boxes].map(roundedKey).sort();
  const bytes = new TextEncoder().encode(sorted.join('|'));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_CONSECUTIVE_MISMATCHES = 3;

export class GeometryDigestGuard {
  private consecutiveMismatches = 0;

  /** Returns `'ok'` when the pre- and post-capture digests match, `'retry'` on a mismatch under
   * the retry budget, or `'degrade'` after `MAX_CONSECUTIVE_MISMATCHES` in a row — the caller
   * proceeds as L0 with reason `CAPTURE_INCONSISTENT` on `'degrade'` (phase_4_vision.md §5.2). */
  check(before: string, after: string): 'ok' | 'retry' | 'degrade' {
    if (before === after) {
      this.consecutiveMismatches = 0;
      return 'ok';
    }
    this.consecutiveMismatches += 1;
    return this.consecutiveMismatches >= MAX_CONSECUTIVE_MISMATCHES ? 'degrade' : 'retry';
  }

  reset(): void {
    this.consecutiveMismatches = 0;
  }
}
