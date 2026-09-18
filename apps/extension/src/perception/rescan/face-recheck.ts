// design.md §7.6 step 5 / phase_4_vision.md §8 — face detection over the WHOLE composed image, as
// opposed to `models/face.ts`'s per-region detection over the raw capture. If a face survives
// composition (it was in a region the host wrongly marked cleared), this finds it: the composed
// image is decoded back into an `ImageBitmap` and run through the same detector, full-frame.

import type * as ort from 'onnxruntime-web';
import type { Box } from '../../shared/worker-protocol';
import { detectFaces } from '../models/face';

export async function recheckFacesOnComposedImage(session: ort.InferenceSession, ort_: typeof ort, webpBytes: ArrayBuffer): Promise<Box[]> {
  const blob = new Blob([webpBytes], { type: 'image/webp' });
  const bitmap = await createImageBitmap(blob);
  try {
    const detections = await detectFaces(session, ort_, bitmap, [0, 0, bitmap.width, bitmap.height]);
    return detections.map((d) => d.box);
  } finally {
    bitmap.close();
  }
}
