// design.md §6.4's OCR preprocessing. PP-OCRv5's det/rec models were trained with PaddleOCR's own
// `DetResizeForTest`/`RecResizeImg` + `NormalizeImage` pipeline, not the square letterbox
// `letterbox.ts` uses for YuNet/the ViT encoder — transcribed from PaddleOCR's real config/source,
// not re-derived, per this project's standing rule for model-specific pre/post-processing:
//   - `configs/det/PP-OCRv5/PP-OCRv5_mobile_det.yml`: `DecodeImage: img_mode: BGR`,
//     `NormalizeImage: scale: 1./255., mean: [0.485,0.456,0.406], std: [0.229,0.224,0.225]`.
//   - `ppocr/data/imaug/operators.py`'s `DetResizeForTest` (default `limit_side_len=960`,
//     `limit_type='max'`): resize so the long side is at most `limit_side_len`, never upscale,
//     then round both dimensions up to the nearest multiple of 32 (the detector's FPN backbone
//     needs dimensions divisible by its largest stride) — matches design.md §6.4's own "long side
//     ≤ 960 px" citation exactly, corroborating rather than contradicting it.
//   - PaddleOCR's recognizer preprocessing resizes to a fixed height (48px, design.md §6.4) at
//     the source aspect ratio, no padding needed for a single-image (batch=1) inference call.

export interface OcrResizeResult {
  canvas: OffscreenCanvas;
  /** Scale applied to the source before placement — used to map detected boxes back. */
  scale: number;
}

const DET_LIMIT_SIDE_LEN = 960;
const DET_STRIDE = 32;
const REC_HEIGHT = 48;

/** DetResizeForTest, `limit_type='max'`: only ever downscales (never upscales past 1:1), then
 * pads up to a multiple of 32 on the right/bottom (padding, not stretching, so the padded region
 * contributes no signal the model wasn't trained to see as background). */
export function resizeForDetection(source: ImageBitmap | OffscreenCanvas, limitSideLen = DET_LIMIT_SIDE_LEN): OcrResizeResult {
  const longSide = Math.max(source.width, source.height);
  const scale = longSide > limitSideLen ? limitSideLen / longSide : 1;
  const resizedW = Math.round(source.width * scale);
  const resizedH = Math.round(source.height * scale);
  const paddedW = Math.ceil(resizedW / DET_STRIDE) * DET_STRIDE;
  const paddedH = Math.ceil(resizedH / DET_STRIDE) * DET_STRIDE;

  const canvas = new OffscreenCanvas(paddedW, paddedH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, paddedW, paddedH);
  ctx.drawImage(source, 0, 0, resizedW, resizedH);

  return { canvas, scale };
}

/** RecResizeImg: fixed height, aspect-preserving width. No upper bound on width here — the
 * recognizer is only ever run on an already-cropped, already-line-sized detection box (design.md
 * §6.4's "recognizer on detected lines"), never a whole page. */
export function resizeForRecognition(source: ImageBitmap | OffscreenCanvas, targetHeight = REC_HEIGHT): OcrResizeResult {
  const scale = targetHeight / source.height;
  const targetWidth = Math.max(1, Math.round(source.width * scale));

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

  return { canvas, scale };
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const; // indexed B,G,R — see this file's top comment
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/** BGR, CHW, ImageNet-normalized float32 tensor data — PP-OCRv5 det/rec's real expected input
 * layout (this file's top comment), deliberately different from `letterbox.ts`'s `toCHWFloat32`
 * (RGB, [0,1] only, no mean/std) which is correct for YuNet/the ViT encoder but wrong here. */
export function toCHWFloat32BGRNormalized(canvas: OffscreenCanvas): Float32Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4]! / 255;
    const g = data[i * 4 + 1]! / 255;
    const b = data[i * 4 + 2]! / 255;
    out[i] = (b - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // B plane
    out[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // G plane
    out[2 * plane + i] = (r - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // R plane
  }
  return out;
}
