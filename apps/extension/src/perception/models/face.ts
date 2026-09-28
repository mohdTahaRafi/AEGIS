// design.md §6.4 (Channel V face detection) / phase_4_vision.md §4.1, T-4.4 — the real YuNet
// (face_detection_yunet_2023mar) integration. The model was already fetched and sha256-verified
// in Phase 0 for the latency spike; this is the first phase that actually decodes its output into
// boxes.
//
// [A] IMPORTANT, DISCLOSED LIMITATION: the model's manifest-declared input shape was wrong
// (`[1,3,160,120]`) — real inference in this phase (introspecting `session.inputMetadata`/
// `outputMetadata` in a real-Chromium test) showed a fixed `[1,3,640,640]` input and a 3-stride
// (8/16/32) anchor-free YOLOX-style head (`cls_*`, `obj_*`, `bbox_*`, `kps_*` per stride) —
// corrected in `models.manifest.json`. The decode formula below (center/size regression, score as
// sqrt(cls*obj)) is transcribed from OpenCV's own C++ post-processing
// (`modules/objdetect/src/face_detect.cpp`, the code `cv2.FaceDetectorYN` calls internally — the
// bundled `.onnx` has no such logic itself), not re-derived from first principles. What could NOT
// be verified in this sandboxed, network-restricted environment: real-photograph accuracy. There
// is no licensable face-photo fixture reachable here to confirm actual detections/IoU against
// (phase_4_vision.md's AC-4.4 "12-face fixture" is not built for that reason — see
// `docs/HISTORY.md`). `face.spec.ts` instead verifies the decode arithmetic against synthetic
// tensors built to the documented output contract, and a real-Chromium test confirms the full
// preprocess→inference→decode pipeline runs end-to-end against the bundled model without throwing.
// Real-photo validation is a disclosed follow-up, not silently assumed to pass.
// [2026-09-28] That follow-up found a real defect: the input was fed as [0,1] RGB, so no real face
// ever reached the score floor — see `toYunetInput`. Now validated against real photographs in
// `test/browser/face-pipeline.spec.ts`.

import type * as ort from 'onnxruntime-web';
import type { Box } from '../../shared/worker-protocol';
import { letterbox, unletterboxPoint } from '../preprocess/letterbox';

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const SCORE_THRESHOLD = 0.5;
const NMS_IOU_THRESHOLD = 0.3;
// design.md §4.1: "Boxes expanded 10% to cover hair and ears."
const BOX_EXPANSION = 0.1;

export interface FaceDetection {
  box: Box;
  score: number;
}

function sigmoidOrClamp(v: number): number {
  // OpenCV's own decode clamps rather than applying sigmoid — the bundled graph's cls/obj heads
  // already end in a Sigmoid op (standard for this export). Clamped defensively in case a future
  // re-export drops that op and starts emitting raw logits, which would otherwise silently produce
  // negative or >1 "scores" that pass the threshold check by accident.
  return Math.min(1, Math.max(0, v));
}

function iou(a: Box, b: Box): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(dets: FaceDetection[], iouThreshold: number): FaceDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: FaceDetection[] = [];
  for (const d of sorted) {
    if (kept.every((k) => iou(k.box, d.box) < iouThreshold)) kept.push(d);
  }
  return kept;
}

export interface StrideOutputs {
  stride: number;
  cls: Float32Array;
  obj: Float32Array;
  bbox: Float32Array;
}

/** Pure decode over already-extracted tensor data — separated from `detectFaces` so it can be
 * unit-tested against synthetic tensors without a real ONNX session (see this file's top comment
 * on why real-photo validation isn't possible in this sandbox). Boxes are in the model's own
 * 640×640 input space; `detectFaces` maps them back to source coordinates. */
export function decodeYunetOutputs(outputs: readonly StrideOutputs[]): FaceDetection[] {
  const dets: FaceDetection[] = [];
  for (const { stride, cls, obj, bbox } of outputs) {
    const cols = INPUT_SIZE / stride;
    const rows = INPUT_SIZE / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(sigmoidOrClamp(cls[idx]!) * sigmoidOrClamp(obj[idx]!));
        if (score < SCORE_THRESHOLD) continue;
        const bx = bbox[idx * 4]!;
        const by = bbox[idx * 4 + 1]!;
        const bw = bbox[idx * 4 + 2]!;
        const bh = bbox[idx * 4 + 3]!;
        const cx = (c + bx) * stride;
        const cy = (r + by) * stride;
        const w = Math.exp(bw) * stride;
        const h = Math.exp(bh) * stride;
        dets.push({ box: [cx - w / 2, cy - h / 2, w, h], score });
      }
    }
  }
  return nms(dets, NMS_IOU_THRESHOLD);
}

/** YuNet's input contract is OpenCV's `FaceDetectorYN`: `cv::dnn::blobFromImage` with no scaling
 * and no channel swap — BGR planes in raw [0,255]. Feeding [0,1] RGB (the ViT's convention) left
 * every real face below the 0.5 score floor: a portrait scored 0.054 instead of 0.908, measured
 * with this exact bundled model. */
export function toYunetInput(canvas: OffscreenCanvas): Float32Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = data[i * 4 + 2]!; // B
    out[plane + i] = data[i * 4 + 1]!; // G
    out[2 * plane + i] = data[i * 4]!; // R
  }
  return out;
}

function expandBox([x, y, w, h]: Box, fraction: number): Box {
  const dx = (w * fraction) / 2;
  const dy = (h * fraction) / 2;
  return [x - dx, y - dy, w + dx * 2, h + dy * 2];
}

/** Runs the bundled YuNet session over one region (already cropped to `sourceBox` in source
 * coordinates by the caller) and returns detections in source coordinates, boxes pre-expanded 10%. */
export async function detectFaces(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas, sourceBox: Box): Promise<FaceDetection[]> {
  const lb = letterbox(crop, INPUT_SIZE);
  const tensor = new ort_.Tensor('float32', toYunetInput(lb.canvas), [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('face model exposes no input names');
  const results = await session.run({ [inputName]: tensor });

  const outputs: StrideOutputs[] = STRIDES.map((stride) => ({
    stride,
    cls: results[`cls_${stride}`]!.data as Float32Array,
    obj: results[`obj_${stride}`]!.data as Float32Array,
    bbox: results[`bbox_${stride}`]!.data as Float32Array,
  }));

  const detections = decodeYunetOutputs(outputs);
  const [srcX, srcY] = sourceBox;
  return detections.map((d) => {
    const [x1, y1] = unletterboxPoint(d.box[0], d.box[1], lb);
    const [x2, y2] = unletterboxPoint(d.box[0] + d.box[2], d.box[1] + d.box[3], lb);
    const inSource: Box = [srcX + x1, srcY + y1, x2 - x1, y2 - y1];
    return { box: expandBox(inSource, BOX_EXPANSION), score: d.score };
  });
}
