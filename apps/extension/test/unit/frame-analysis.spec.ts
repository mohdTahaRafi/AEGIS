// The whole-frame analysis and what decides a redaction on it: the pixel verifiers CLIP's labels
// must agree with, the face-geometry check, the compose mode choice, the guard's text repair and
// the additive image re-scan.

import { describe, expect, it, vi } from 'vitest';
import { idDocumentTextEvidence, isNearUniform, looksLikeBarcode, looksLikeQrCode, looksLikeSignature, type GrayImage } from '../../src/perception/detect/verify';
import { isPlausibleFace, mergeFaceDetections, tileOrigins, type FaceDetection } from '../../src/perception/models/face';
import { confirmedEntity, type RegionClassification, type RegionEvidence } from '../../src/perception/models/vit-encoder';
import { composeOptionsFor } from '../../src/host/privacy/context/attach-image';
import { measureCoverage } from '../../src/perception/compose/compositor';
import { runImageRescan } from '../../src/host/privacy/guard/image-rescan';
import { scrubPayloadText } from '../../src/host/privacy/guard/sweeps';
import { Vault } from '../../src/host/privacy/vault';
import { defaultPolicy } from '@aegis/policy';
import type { SanitizedContext } from '@aegis/protocol';

function image(width: number, height: number, fill = 255): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

function rect(img: GrayImage, x: number, y: number, w: number, h: number, v: number): void {
  for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) img.data[r * img.width + c] = v;
}

/** A 7-module finder pattern at module size `m`. */
function finder(img: GrayImage, x: number, y: number, m: number): void {
  rect(img, x, y, 7 * m, 7 * m, 0);
  rect(img, x + m, y + m, 5 * m, 5 * m, 255);
  rect(img, x + 2 * m, y + 2 * m, 3 * m, 3 * m, 0);
}

function qrCode(): GrayImage {
  const m = 6;
  const size = 29 * m;
  const img = image(size + 4 * m, size + 4 * m);
  const o = 2 * m;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 2 === 0);
  for (let r = 0; r < 29; r++) for (let c = 0; c < 29; c++) if (rnd()) rect(img, o + c * m, o + r * m, m, m, 0);
  for (const [fx, fy] of [[0, 0], [22, 0], [0, 22]] as const) {
    rect(img, o + fx * m - (fx ? m : 0), o + fy * m - (fy ? m : 0), 8 * m, 8 * m, 255);
    finder(img, o + fx * m, o + fy * m, m);
  }
  return img;
}

function photoLike(): GrayImage {
  const img = image(200, 200);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) img.data[y * 200 + x] = Math.round(128 + 80 * Math.sin(x / 17) * Math.cos(y / 23));
  return img;
}

describe('pixel verifiers', () => {
  it('finds a QR code by its three finder patterns', () => {
    expect(looksLikeQrCode(qrCode())).toBe(true);
  });

  it('a photograph (smooth tones, no finder patterns) is not a QR code or a barcode', () => {
    expect(looksLikeQrCode(photoLike())).toBe(false);
    expect(looksLikeBarcode(photoLike())).toBe(false);
  });

  it('finds a barcode by parallel bars that repeat on every row', () => {
    const img = image(240, 100);
    let x = 5;
    for (let i = 0; i < 40; i++) {
      const w = 1 + (i % 3);
      rect(img, x, 10, w, 80, 0);
      x += w + 1 + ((i * 7) % 3);
    }
    expect(looksLikeBarcode(img)).toBe(true);
  });

  it('a signature is a few long strokes; printed text is many letter-sized blobs', () => {
    const sig = image(300, 100);
    for (let x = 20; x < 280; x++) {
      const y = Math.round(50 + 25 * Math.sin(x / 15));
      rect(sig, x, y, 2, 2, 20);
    }
    expect(looksLikeSignature(sig)).toBe(true);

    const text = image(300, 100);
    for (let row = 0; row < 3; row++) for (let i = 0; i < 25; i++) rect(text, 10 + i * 11, 15 + row * 28, 6, 12, 20);
    expect(looksLikeSignature(text)).toBe(false);
  });

  it('a blank placeholder is near-uniform', () => {
    expect(isNearUniform(image(64, 64, 240))).toBe(true);
    expect(isNearUniform(photoLike())).toBe(false);
  });

  it('ID-document evidence needs ID wording or an ID number, not just any text', () => {
    expect(idDocumentTextEvidence(['Government of India', 'Date of Birth: 01/01/1990'], 0)).toBe(true);
    expect(idDocumentTextEvidence(['65W GaN charger', '100W'], 0)).toBe(false);
    // A number alone (a PAN on a dashboard canvas, eval canvas-003) is not a document; with the
    // card's own wording it is.
    expect(idDocumentTextEvidence(['PAN ABCPE1234F'], 1)).toBe(false);
    expect(idDocumentTextEvidence(['Income Tax Department', 'ABCPE1234F'], 1)).toBe(true);
    expect(idDocumentTextEvidence(['P<INDDOE<<JOHN<<<<<<<<<<'], 0)).toBe(true);
  });
});

describe('CLIP labels must be confirmed by the pixels', () => {
  const ev = (over: Partial<RegionEvidence> = {}): RegionEvidence => ({ qr: false, barcode: false, signature: false, idText: false, face: false, lines: 0, aspect: 1, ...over });
  const clip = (pooled: RegionClassification['pooled'], label = 'QR code'): RegionClassification => ({ label: label as RegionClassification['label'], score: 0.9, entity: 'QR_CODE', entityScore: 0.9, pooled });

  it('a product photo CLIP calls a QR code is not redacted without finder patterns (Amazon, 2026-09-29)', () => {
    expect(confirmedEntity(clip({ QR_CODE: 0.92 }), ev())).toBeNull();
  });

  it('QR finder patterns or barcode bars are conclusive on their own', () => {
    expect(confirmedEntity(null, ev({ qr: true }))?.entity).toBe('QR_CODE');
    expect(confirmedEntity(clip({ QR_CODE: 0.01 }), ev({ barcode: true }))?.entity).toBe('QR_CODE');
  });

  it('an ID document needs CLIP plus its own text, or a face and text on it', () => {
    expect(confirmedEntity(clip({ ID_DOCUMENT: 0.6 }, 'identity card'), ev({ lines: 1 }))).toBeNull();
    expect(confirmedEntity(clip({ ID_DOCUMENT: 0.6 }, 'identity card'), ev({ idText: true }))?.entity).toBe('ID_DOCUMENT');
    expect(confirmedEntity(clip({ ID_DOCUMENT: 0.5 }, 'identity card'), ev({ face: true, lines: 3, aspect: 1.58 }))?.entity).toBe('ID_DOCUMENT');
    // A portrait advert banner (a model's face, promo text) is not a card (Amazon, 2026-09-29).
    expect(confirmedEntity(clip({ ID_DOCUMENT: 0.6 }, 'identity card'), ev({ face: true, lines: 4, aspect: 0.63 }))).toBeNull();
  });

  it('a signature needs CLIP and ink strokes', () => {
    expect(confirmedEntity(clip({ SIGNATURE: 0.6 }, 'handwritten signature'), ev())).toBeNull();
    expect(confirmedEntity(clip({ SIGNATURE: 0.6 }, 'handwritten signature'), ev({ signature: true }))?.entity).toBe('SIGNATURE');
  });
});

describe('face plausibility (YuNet landmarks)', () => {
  const upright: FaceDetection = { box: [100, 100, 80, 100], score: 0.9, landmarks: [[125, 135], [155, 135], [140, 160], [128, 180], [152, 180]] };

  it('accepts an upright face', () => {
    expect(isPlausibleFace(upright)).toBe(true);
  });

  it('rejects a detection whose mouth is above its eyes, whose eyes coincide, or whose score is low', () => {
    expect(isPlausibleFace({ ...upright, landmarks: [[125, 180], [155, 180], [140, 160], [128, 135], [152, 135]] })).toBe(false);
    expect(isPlausibleFace({ ...upright, landmarks: [[140, 135], [141, 135], [140, 160], [128, 180], [152, 180]] })).toBe(false);
    expect(isPlausibleFace({ ...upright, score: 0.55 })).toBe(false);
    expect(isPlausibleFace({ box: [0, 0, 20, 20], score: 0.7 })).toBe(false); // small faces need 0.75
  });

  it('rejects a face-shaped box with an impossible aspect ratio', () => {
    expect(isPlausibleFace({ box: [0, 0, 200, 40], score: 0.99 })).toBe(false);
  });

  it('merges the same face seen by the full-frame pass and a tile', () => {
    const merged = mergeFaceDetections([
      { box: [100, 100, 80, 100], score: 0.8 },
      { box: [104, 102, 76, 96], score: 0.9 },
      { box: [400, 100, 80, 100], score: 0.85 },
    ]);
    expect(merged.map((d) => d.score)).toEqual([0.9, 0.85]);
  });

  it('tiles cover the whole frame with overlap', () => {
    expect(tileOrigins(600)).toEqual([0]);
    const xs = tileOrigins(1280);
    expect(xs[0]).toBe(0);
    expect(xs.at(-1)! + 640).toBe(1280);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeLessThan(640);
  });
});

describe('compose mode', () => {
  it('shows the capture by default only when faces AND text were screened over the whole frame', () => {
    expect(composeOptionsFor({ faces: 'ok', text: 'ok', images: 'ok', unanalysed: [[1, 2, 3, 4]] })).toEqual({ clearDefault: true, grey: [[1, 2, 3, 4]] });
    expect(composeOptionsFor({ faces: 'failed', text: 'ok', images: 'ok', unanalysed: [] })).toEqual({});
    expect(composeOptionsFor({ faces: 'ok', text: 'unavailable', images: 'ok', unanalysed: [] })).toEqual({});
    expect(composeOptionsFor(undefined)).toEqual({});
  });

  it('coverage counts grey boxes as unanalysed even over a cleared frame', () => {
    const c = measureCoverage(100, 100, 1, [[0, 0, 100, 100]], [[0, 0, 10, 10]], [[50, 0, 50, 100]]);
    expect(c.unanalysed).toBeCloseTo(0.5);
    expect(c.redacted).toBeCloseTo(0.01);
    expect(c.cleared).toBeCloseTo(0.49);
  });
});

describe('guard repair and additive re-scan', () => {
  it('scrubs a recognizer match out of page text, keeping existing placeholders', () => {
    const payload = {
      task: 'reply to the mail',
      page: { category: 'unknown', title: 'Inbox' },
      nodes: [{ id: 'n-1', name: 'Call 98765 43210 or ⟪EMAIL#1⟫', value: { kind: 'text', text: 'ok' } }],
      text: [{ id: 't-1', box: [0, 0, 1, 1], text: 'nothing here' }],
      image: null,
    } as unknown as SanitizedContext;
    const out = scrubPayloadText(payload, defaultPolicy, new Vault());
    expect(out.nodes[0]!.name).toContain('⟪EMAIL#1⟫');
    expect(out.nodes[0]!.name).not.toMatch(/98765/);
    expect(out.text[0]!.text).toBe('nothing here');
    expect(out.nodes[0]!.id).toBe('n-1');
  });

  it('a face the re-scan finds gets its own box on top; the rest of the picture is kept', async () => {
    const recompose = vi.fn(async (_regions: readonly { entity: string }[]) => new ArrayBuffer(2));
    const rescan = vi
      .fn()
      .mockResolvedValueOnce({ hits: [{ box: [10, 10, 40, 40] }] })
      .mockResolvedValueOnce({ hits: [] });
    const outcome = await runImageRescan(new ArrayBuffer(1), [{ entity: 'EMAIL', boxes: [[100, 100, 50, 10]], placeholder: '⟪EMAIL#1⟫' }], { rescan, recompose });
    expect(outcome.verdict).toBe('recomposed');
    const regions = recompose.mock.calls[0]![0];
    expect(regions.map((r) => r.entity)).toEqual(['EMAIL', 'FACE']);
  });
});
