// design.md §6.4 (Channel V OCR detection) / architecture.md §6.3, T-6.3 — PP-OCRv5 mobile
// detector integration. The bundled `.onnx` (a DBNet/DB-style segmentation head, confirmed by
// real ORT introspection — see models.manifest.json's `ocr-det-ppocrv5-mobile` entry) outputs a
// per-pixel text-probability map, not boxes directly; turning that into boxes is PaddleOCR's own
// `DBPostProcess` (`ppocr/postprocess/db_postprocess.py`), transcribed from its real source
// (`thresh=0.3`, `box_thresh=0.7`, `unclip_ratio=2.0`, `min_size=3` are its real defaults, not
// re-derived) — NOT re-implemented in full.
//
// [A] DISCLOSED SIMPLIFICATION: PaddleOCR's real post-process fits a rotated `cv2.minAreaRect`
// per contour (via OpenCV's contour-finding) and unclips via Vatti polygon clipping (pyclipper).
// This implementation uses axis-aligned connected-component bounding boxes and an axis-aligned
// unclip (the same `area * unclip_ratio / perimeter` distance formula, applied uniformly on all
// four sides of the axis-aligned box) instead of full rotated-rectangle geometry. This is a
// deliberate scope cut, not an oversight: AEGIS's OCR targets are web pages, canvas apps and PDF
// viewers (design.md §6.4's own stated categories) — screen-rendered text, which is essentially
// always axis-aligned — not photographs of documents at arbitrary angles, where minAreaRect earns
// its complexity. If a future fixture shows rotated on-screen text this misses, revisit; until
// then this is the same "fail toward line-level redaction over precise geometry" choice design.md
// §6.4 itself makes for word-vs-line boxes, applied one level up.

import type * as ort from 'onnxruntime-web';
import type { Box } from '../../shared/worker-protocol';
import { resizeForDetection, toCHWFloat32BGRNormalized } from '../preprocess/ocr-resize';

const PROB_THRESHOLD = 0.3; // DBPostProcess `thresh`
const BOX_SCORE_THRESHOLD = 0.7; // DBPostProcess `box_thresh`
const UNCLIP_RATIO = 2.0; // DBPostProcess `unclip_ratio`
const MIN_SIZE = 3; // DBPostProcess `min_size`

export interface DetectedLine {
  box: Box;
  score: number;
}

/** 4-connected component labeling over a boolean mask, iterative (a stack, not recursion — a
 * ~960×960 mask has up to ~10^6 pixels, well past a safe call-stack depth for a recursive
 * flood-fill). Returns one axis-aligned bounding box per component. */
function connectedComponentBoxes(mask: Uint8Array, width: number, height: number): { x0: number; y0: number; x1: number; y1: number }[] {
  const visited = new Uint8Array(width * height);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let x0 = start % width;
    let x1 = x0;
    let y0 = Math.floor(start / width);
    let y1 = y0;
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length) continue;
        // Guard against horizontal wraparound (idx-1/idx+1 crossing a row boundary).
        if ((n === idx - 1 || n === idx + 1) && Math.floor(n / width) !== y) continue;
        if (mask[n] && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

function boxMeanScore(probMap: Float32Array, width: number, box: { x0: number; y0: number; x1: number; y1: number }): number {
  let sum = 0;
  let count = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      sum += probMap[y * width + x]!;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Pure decode over an already-extracted probability map — separated from `detectText` so it can
 * be unit-tested against synthetic maps without a real ONNX session. `probMap`/`width`/`height`
 * are in the detector's own (resized+padded) input space; boxes come back in that same space. */
export function decodeDbOutput(probMap: Float32Array, width: number, height: number): DetectedLine[] {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < probMap.length; i++) {
    mask[i] = probMap[i]! > PROB_THRESHOLD ? 1 : 0;
  }

  const lines: DetectedLine[] = [];
  for (const box of connectedComponentBoxes(mask, width, height)) {
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    if (w < MIN_SIZE || h < MIN_SIZE) continue;

    const score = boxMeanScore(probMap, width, box);
    if (score < BOX_SCORE_THRESHOLD) continue;

    // DBPostProcess's unclip: distance = area * unclip_ratio / perimeter, expanded uniformly
    // (the axis-aligned analogue of the real polygon offset — see this file's top comment).
    const area = w * h;
    const perimeter = 2 * (w + h);
    const distance = (area * UNCLIP_RATIO) / perimeter;

    const x0 = Math.max(0, box.x0 - distance);
    const y0 = Math.max(0, box.y0 - distance);
    const x1 = Math.min(width, box.x1 + 1 + distance);
    const y1 = Math.min(height, box.y1 + 1 + distance);

    lines.push({ box: [x0, y0, x1 - x0, y1 - y0], score });
  }
  return lines;
}

/** Runs the bundled PP-OCRv5 detector over `crop` (already isolated to one unexplained region by
 * the caller, design.md §6.4) and returns detected text-line boxes in `crop`'s own coordinates
 * (the caller offsets into source-page coordinates, same convention as `detectFaces`). */
export async function detectText(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas): Promise<DetectedLine[]> {
  const resized = resizeForDetection(crop);
  const tensor = new ort_.Tensor('float32', toCHWFloat32BGRNormalized(resized.canvas), [
    1,
    3,
    resized.canvas.height,
    resized.canvas.width,
  ]);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('OCR detection model exposes no input names');
  const results = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  if (!outputName) throw new Error('OCR detection model exposes no output names');
  const output = results[outputName]!;
  const [, , outH, outW] = output.dims as [number, number, number, number];

  const lines = decodeDbOutput(output.data as Float32Array, outW, outH);
  // Map from the (possibly-downsampled) probability-map space back to `crop`'s own coordinates.
  // The prob map's own resolution can differ from the padded input's if the model's stride isn't
  // exactly 1 (verify against `resized.canvas` dims in the real-Chromium test rather than assume
  // they always match 1:1).
  const scaleX = resized.canvas.width / outW / resized.scale;
  const scaleY = resized.canvas.height / outH / resized.scale;
  return lines.map((l) => ({
    box: [l.box[0] * scaleX, l.box[1] * scaleY, l.box[2] * scaleX, l.box[3] * scaleY],
    score: l.score,
  }));
}
