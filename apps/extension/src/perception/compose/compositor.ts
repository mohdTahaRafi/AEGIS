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
}

export interface ComposeOutput {
  canvas: OffscreenCanvas;
  coverage: { cleared: number; redacted: number; unanalysed: number };
}

const NON_RESOLVABLE_LABELS = new Set(['FACE', 'ID_DOCUMENT', 'SIGNATURE', 'QR_CODE']);

function boxArea([, , w, h]: Box): number {
  return Math.max(0, w) * Math.max(0, h);
}

export function compose(input: ComposeInput): ComposeOutput {
  const { bitmap, cleared, regions, scale } = input;
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
  let clearedArea = 0;
  for (const [x, y, w, h] of mergedCleared) {
    ctx.drawImage(bitmap, x, y, w, h, x * scale, y * scale, w * scale, h * scale);
    clearedArea += boxArea([x, y, w, h]);
  }

  let redactedArea = 0;
  ctx.fillStyle = '#000000';
  for (const region of regions) {
    for (const box of region.boxes) {
      const [x, y, w, h] = box;
      ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
      redactedArea += boxArea(box);

      const label = region.placeholder ?? (NON_RESOLVABLE_LABELS.has(region.entity) ? region.entity : null);
      if (label && w * scale >= MIN_LABEL_BOX_PX && h * scale >= MIN_LABEL_BOX_PX / 2) {
        drawFittedLabel(ctx, label, x * scale, y * scale, w * scale, h * scale);
      }
    }
  }

  const totalArea = width * height * (1 / (scale * scale)); // back to source-pixel units
  const unanalysedArea = Math.max(0, totalArea - clearedArea - redactedArea);

  return {
    canvas,
    coverage: {
      cleared: totalArea > 0 ? clearedArea / totalArea : 0,
      redacted: totalArea > 0 ? redactedArea / totalArea : 0,
      unanalysed: totalArea > 0 ? unanalysedArea / totalArea : 0,
    },
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
