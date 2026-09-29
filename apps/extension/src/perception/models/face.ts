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
  /** YuNet's five landmarks (right eye, left eye, nose tip, right and left mouth corner, as seen
   * from the subject), in the same space as `box`. */
  landmarks?: [number, number][];
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
  /** 10 values per anchor (5 landmark x,y offsets, in stride units from the anchor). */
  kps?: Float32Array;
}

/** Pure decode over already-extracted tensor data — separated from `detectFaces` so it can be
 * unit-tested against synthetic tensors without a real ONNX session (see this file's top comment
 * on why real-photo validation isn't possible in this sandbox). Boxes are in the model's own
 * 640×640 input space; `detectFaces` maps them back to source coordinates. */
export function decodeYunetOutputs(outputs: readonly StrideOutputs[]): FaceDetection[] {
  const dets: FaceDetection[] = [];
  for (const { stride, cls, obj, bbox, kps } of outputs) {
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
        const det: FaceDetection = { box: [cx - w / 2, cy - h / 2, w, h], score };
        if (kps) {
          det.landmarks = [0, 1, 2, 3, 4].map((n) => [(c + kps[idx * 10 + 2 * n]!) * stride, (r + kps[idx * 10 + 2 * n + 1]!) * stride]);
        }
        dets.push(det);
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

// Decode keeps YuNet's own 0.5 floor; a detection is only reported as a face above this, and only
// if its geometry is a face's. Web pages are full of face-like texture (logos, icons, product
// shots, text glyphs upscaled); the landmark layout is what those almost never reproduce.
export const FACE_ACCEPT_SCORE = 0.6;
const SMALL_FACE_PX = 24;
const SMALL_FACE_ACCEPT_SCORE = 0.75;
const MIN_FACE_PX = 8;

/** Rejects detections whose box or landmark layout is not a plausible upright face: eyes above
 * the nose, nose above the mouth, the eyes apart, every landmark inside the (slightly grown) box. */
export function isPlausibleFace(det: FaceDetection): boolean {
  const [x, y, w, h] = det.box;
  if (w < MIN_FACE_PX || h < MIN_FACE_PX) return false;
  const aspect = w / h;
  if (aspect < 0.5 || aspect > 1.6) return false;
  const floor = Math.min(w, h) < SMALL_FACE_PX ? SMALL_FACE_ACCEPT_SCORE : FACE_ACCEPT_SCORE;
  if (det.score < floor) return false;
  const lm = det.landmarks;
  if (!lm || lm.length !== 5) return true;
  const [re, le, nose, rm, lmth] = lm as [[number, number], [number, number], [number, number], [number, number], [number, number]];
  const slackX = w * 0.2;
  const slackY = h * 0.2;
  for (const [px, py] of lm) {
    if (px < x - slackX || px > x + w + slackX || py < y - slackY || py > y + h + slackY) return false;
  }
  const eyeY = (re[1] + le[1]) / 2;
  const mouthY = (rm[1] + lmth[1]) / 2;
  if (mouthY - eyeY < h * 0.15) return false;
  if (nose[1] < eyeY - h * 0.05 || nose[1] > mouthY + h * 0.05) return false;
  if (Math.abs(le[0] - re[0]) < w * 0.08) return false;
  if (Math.abs(lmth[0] - rm[0]) < w * 0.05) return false;
  return true;
}

function boxIou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const smaller = Math.min(a[2] * a[3], b[2] * b[3]);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  // Also suppress a box mostly inside another: the same face seen at two scales/tiles.
  return Math.max(union <= 0 ? 0 : inter / union, smaller <= 0 ? 0 : inter / smaller >= 0.7 ? 1 : 0);
}

/** Merges detections from overlapping passes (full frame + tiles): best score wins. */
export function mergeFaceDetections(dets: readonly FaceDetection[]): FaceDetection[] {
  const kept: FaceDetection[] = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => boxIou(k.box, d.box) < NMS_IOU_THRESHOLD)) kept.push(d);
  }
  return kept;
}

const TILE_PX = INPUT_SIZE;
const TILE_OVERLAP_PX = 96;

/** Tile origins covering `length` with `TILE_PX` windows overlapping by `TILE_OVERLAP_PX`. */
export function tileOrigins(length: number): number[] {
  if (length <= TILE_PX) return [0];
  const step = TILE_PX - TILE_OVERLAP_PX;
  const out: number[] = [];
  for (let at = 0; at + TILE_PX < length; at += step) out.push(at);
  out.push(length - TILE_PX);
  return out;
}

/** Face detection over the WHOLE frame: one pass over the full frame (large faces), then native-
 * resolution 640 px tiles (small faces a downscaled full-frame pass would lose: a 1280 px frame
 * halves every face). Returns plausible faces in frame coordinates, boxes pre-expanded 10%. */
export async function detectFacesFullFrame(session: ort.InferenceSession, ort_: typeof ort, frame: ImageBitmap | OffscreenCanvas): Promise<{ faces: FaceDetection[]; passes: number }> {
  const all: FaceDetection[] = [];
  let passes = 0;
  all.push(...(await detectFacesRaw(session, ort_, frame, [0, 0, frame.width, frame.height])));
  passes += 1;
  if (Math.max(frame.width, frame.height) > INPUT_SIZE * 1.1) {
    for (const ty of tileOrigins(frame.height)) {
      for (const tx of tileOrigins(frame.width)) {
        const w = Math.min(TILE_PX, frame.width - tx);
        const h = Math.min(TILE_PX, frame.height - ty);
        const tile = new OffscreenCanvas(w, h);
        tile.getContext('2d')!.drawImage(frame, tx, ty, w, h, 0, 0, w, h);
        all.push(...(await detectFacesRaw(session, ort_, tile, [tx, ty, w, h])));
        passes += 1;
      }
    }
  }
  const faces = mergeFaceDetections(all.filter(isPlausibleFace)).map((d) => ({ ...d, box: expandBox(d.box, BOX_EXPANSION) }));
  return { faces, passes };
}

function expandBox([x, y, w, h]: Box, fraction: number): Box {
  const dx = (w * fraction) / 2;
  const dy = (h * fraction) / 2;
  return [x - dx, y - dy, w + dx * 2, h + dy * 2];
}

/** One YuNet pass over `crop` (already cropped to `sourceBox`), detections in source coordinates,
 * unfiltered and unexpanded. */
async function detectFacesRaw(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas, sourceBox: Box): Promise<FaceDetection[]> {
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
    kps: results[`kps_${stride}`]?.data as Float32Array | undefined,
  }));

  const [srcX, srcY] = sourceBox;
  const toSource = (px: number, py: number): [number, number] => {
    const [ux, uy] = unletterboxPoint(px, py, lb);
    return [srcX + ux, srcY + uy];
  };
  return decodeYunetOutputs(outputs).map((d) => {
    const [x1, y1] = toSource(d.box[0], d.box[1]);
    const [x2, y2] = toSource(d.box[0] + d.box[2], d.box[1] + d.box[3]);
    const out: FaceDetection = { box: [x1, y1, x2 - x1, y2 - y1], score: d.score };
    if (d.landmarks) out.landmarks = d.landmarks.map(([px, py]) => toSource(px, py));
    return out;
  });
}

/** Runs the bundled YuNet session over one region (already cropped to `sourceBox` in source
 * coordinates by the caller) and returns plausible faces in source coordinates, boxes pre-expanded
 * 10%. */
export async function detectFaces(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas, sourceBox: Box): Promise<FaceDetection[]> {
  const raw = await detectFacesRaw(session, ort_, crop, sourceBox);
  return raw.filter(isPlausibleFace).map((d) => ({ ...d, box: expandBox(d.box, BOX_EXPANSION) }));
}
