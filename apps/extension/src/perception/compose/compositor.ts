// design.md §7.5 — the additive compositor, the phase's most important 20 lines (phase_4_vision.md
// §7). Grey by default; only positively-cleared regions (`cleared`, already decided by the host —
// see `host/privacy/context/clearance.ts`'s doc comment for why that decision lives host-side) are
// copied in. A crash, a timeout, or a region nobody analysed all produce grey, because grey is the
// default and content is the exception (architecture §7.7) — this function has no code path that
// draws anything it wasn't explicitly told is clear.

import { mergeUp, type Box } from './merge-up';

export const GREY_FILL = '#8A8A8A';
const MIN_LABEL_BOX_PX = 40;

export interface RedactionBoxSet {
  entity: string;
  boxes: readonly Box[];
  /** The typed placeholder to draw inside the box (`⟪AADHAAR#2⟫`), or null for entities that are
   * never resolvable to a vault ref (design.md §7.3 — `FACE`, `ID_DOCUMENT`, `SIGNATURE`,
   * `QR_CODE` draw their entity name instead). */
  placeholder: string | null;
}

export interface ComposeInput {
  bitmap: ImageBitmap;
  cleared: readonly Box[];
  regions: readonly RedactionBoxSet[];
  scale: number;
  /** T-6.9, the black-box ablation arm: "render redactions as unlabelled black boxes... send no
   * refs." The JSON side already sends no ref (every `placeholder` is `null` under that arm —
   * `replacementFor`'s own ablation check, `host/privacy/context/builder.ts`); this is the image
   * side's half — without it, the entity-type fallback label below (`FACE`, `ID_DOCUMENT`, ...)
   * would still visually leak the entity TYPE even with no ref in the JSON. Defaults to `false`. */
  unlabelled?: boolean;
}

export interface ComposeOutput {
  canvas: OffscreenCanvas;
  coverage: { cleared: number; redacted: number; unanalysed: number };
}

const NON_RESOLVABLE_LABELS = new Set(['FACE', 'ID_DOCUMENT', 'SIGNATURE', 'QR_CODE']);

const CLEARED = 1;
const REDACTED = 2;

/** Marks `box` (source-pixel units) on a width×height mask of the output frame, clipped to it. */
function paint(mask: Uint8Array, width: number, height: number, [x, y, w, h]: Box, scale: number, value: number): void {
  const x0 = Math.max(0, Math.floor(x * scale));
  const x1 = Math.min(width, Math.ceil((x + Math.max(0, w)) * scale));
  const y0 = Math.max(0, Math.floor(y * scale));
  const y1 = Math.min(height, Math.ceil((y + Math.max(0, h)) * scale));
  if (x1 <= x0) return;
  for (let row = y0; row < y1; row++) mask.fill(value, row * width + x0, row * width + x1);
}

/** Coverage fractions of the frame actually sent. Measured on a mask rather than by summing box
 * areas: real pages yield overlapping and partly off-frame boxes, and summed areas reached 57× the
 * frame on Wikipedia — an out-of-range payload the guard's schema check then blocked outright.
 * Redaction boxes take precedence, matching the draw order below. */
export function measureCoverage(width: number, height: number, scale: number, cleared: readonly Box[], redacted: readonly Box[]): ComposeOutput['coverage'] {
  const total = width * height;
  if (total === 0) return { cleared: 0, redacted: 0, unanalysed: 0 };
  const mask = new Uint8Array(total);
  for (const box of cleared) paint(mask, width, height, box, scale, CLEARED);
  for (const box of redacted) paint(mask, width, height, box, scale, REDACTED);
  let clearedPx = 0;
  let redactedPx = 0;
  for (let i = 0; i < total; i++) {
    if (mask[i] === CLEARED) clearedPx++;
    else if (mask[i] === REDACTED) redactedPx++;
  }
  return { cleared: clearedPx / total, redacted: redactedPx / total, unanalysed: (total - clearedPx - redactedPx) / total };
}

export function compose(input: ComposeInput): ComposeOutput {
  const { bitmap, cleared, regions, scale, unlabelled = false } = input;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  // Grey by DEFAULT — drawn before anything else, so any code path that returns early still
  // ships a fully-grey canvas rather than a partially-uninitialized one.
  ctx.fillStyle = GREY_FILL;
  ctx.fillRect(0, 0, width, height);

  const mergedCleared = mergeUp(cleared);
  for (const [x, y, w, h] of mergedCleared) {
    ctx.drawImage(bitmap, x, y, w, h, x * scale, y * scale, w * scale, h * scale);
  }

  ctx.fillStyle = '#000000';
  for (const region of regions) {
    for (const box of region.boxes) {
      const [x, y, w, h] = box;
      ctx.fillRect(x * scale, y * scale, w * scale, h * scale);

      const label = unlabelled ? null : region.placeholder ?? (NON_RESOLVABLE_LABELS.has(region.entity) ? region.entity : null);
      if (label && w * scale >= MIN_LABEL_BOX_PX && h * scale >= MIN_LABEL_BOX_PX / 2) {
        drawFittedLabel(ctx, label, x * scale, y * scale, w * scale, h * scale);
      }
    }
  }

  return {
    canvas,
    coverage: measureCoverage(width, height, scale, mergedCleared, regions.flatMap((r) => r.boxes)),
  };
}

function drawFittedLabel(ctx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number): void {
  let fontSize = Math.min(20, h * 0.4);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${fontSize}px sans-serif`;
  while (ctx.measureText(text).width > w * 0.9 && fontSize > 6) {
    fontSize -= 1;
    ctx.font = `${fontSize}px sans-serif`;
  }
  ctx.fillText(text, x + w / 2, y + h / 2);
}

export async function encodeWebp(canvas: OffscreenCanvas, quality = 0.8): Promise<ArrayBuffer> {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  return blob.arrayBuffer();
}
