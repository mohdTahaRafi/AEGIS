// design.md §6.4 / §11.1 — resize a crop into a model's fixed square input without distortion.
// YuNet's bundled ONNX graph (face_detection_yunet_2023mar) has a fixed [1,3,640,640] input
// (confirmed by real inference in this phase, T-4.4 — see models.manifest.json's corrected
// inputShape note); the ViT encoder's zero-shot prompt set (design.md §6.4) expects 224×224.
// Both need the same "fit inside a square, pad the rest" transform, parameterised by target size.

export interface LetterboxResult {
  canvas: OffscreenCanvas;
  /** Uniform scale applied to the source before placement. */
  scale: number;
  /** Top-left offset of the placed (unpadded) content within the output canvas. */
  offsetX: number;
  offsetY: number;
}

/** Fits `source` into a `size`×`size` canvas, preserving aspect ratio, centered, padded with
 * `padColor`. Used for both the face detector's fixed 640×640 input and the ViT encoder's 224×224
 * input — a distorted (stretched) resize would change face/object proportions the models were
 * trained on. */
export function letterbox(
  source: ImageBitmap | OffscreenCanvas,
  size: number,
  padColor = '#000000',
): LetterboxResult {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.fillStyle = padColor;
  ctx.fillRect(0, 0, size, size);

  const scale = Math.min(size / source.width, size / source.height);
  const drawW = source.width * scale;
  const drawH = source.height * scale;
  const offsetX = (size - drawW) / 2;
  const offsetY = (size - drawH) / 2;
  ctx.drawImage(source, offsetX, offsetY, drawW, drawH);

  return { canvas, scale, offsetX, offsetY };
}

/** Inverse of `letterbox`'s coordinate transform: maps a point in the padded/scaled output back
 * to source-image coordinates. */
export function unletterboxPoint(x: number, y: number, result: Pick<LetterboxResult, 'scale' | 'offsetX' | 'offsetY'>): [number, number] {
  return [(x - result.offsetX) / result.scale, (y - result.offsetY) / result.scale];
}

/** RGB, CHW, [0,1]-normalized float32 tensor data from an `OffscreenCanvas`'s pixels — the layout
 * both bundled models expect (design.md §11.1's `ToWorker.perceive` comment; confirmed against
 * YuNet's real `[1,3,640,640]` NCHW input via inference introspection this phase). */
export function toCHWFloat32(canvas: OffscreenCanvas): Float32Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = data[i * 4]! / 255; // R
    out[plane + i] = data[i * 4 + 1]! / 255; // G
    out[2 * plane + i] = data[i * 4 + 2]! / 255; // B
  }
  return out;
}
