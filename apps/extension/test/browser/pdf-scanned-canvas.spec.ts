// Real-Chromium test for T-6.6 (PDF.js viewer category): the design.md §7's milestone scenario is
// specifically a SCANNED enrolment form — a PDF page with no extractable text at all, only a
// rasterized image. That distinction matters: a typical PDF.js viewer also renders an invisible
// `.textLayer` of real DOM text on top of its canvas (for selection/accessibility), which Channel
// D/T would already read without any OCR. A scanned page has no text-showing operators in its
// content stream at all, so PDF.js's own text layer is genuinely empty — making it, from this
// extension's point of view, identical to the canvas-app case T-6.5 already covers (an opaque
// `<canvas>` the DOM cannot explain). This test proves both halves of that claim for real: (1) a
// hand-built single-page PDF with ONLY an image XObject (zero text operators) really does produce
// an empty `getTextContent()` from the real `pdfjs-dist` library, and (2) rendering that PDF page
// to a canvas and running it through the same detection-side OCR pass T-6.5 built
// (`detect/text-region.ts`) really does find the embedded ID number.
//
// The PDF bytes are built by hand (header/objects/xref/trailer) rather than via a PDF-writing
// library — the only thing under test is PDF.js's own reader/renderer, so the fixture itself
// should be as close to "PDF spec, nothing more" as practical. FlateDecode is PDF's zlib-wrapped
// deflate (RFC 1950), the exact format `CompressionStream('deflate')` produces in a browser.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { verhoeffGenerate } from '@aegis/recognizers';
import { detectTextEntitiesInRegion } from '../../src/perception/detect/text-region';
import { buildCtcVocabulary } from '../../src/perception/models/ocr-rec';
import type { OcrRescanModels } from '../../src/perception/rescan/halo';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function loadDictLines(path: string): Promise<string[]> {
  const res = await fetch(path);
  const text = await res.text();
  return text.split('\n').filter((line) => line.length > 0);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // TS's lib.dom types this generically over `ArrayBufferLike`, which doesn't structurally match
  // `BufferSource`'s `ArrayBuffer`-specific overloads — a real typed-array `Uint8Array` is a
  // valid `WritableStream.write()` argument at runtime regardless.
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Builds a minimal, valid, single-page PDF whose page is nothing but one FlateDecode-compressed
 * RGB image XObject — no font, no text-showing operator anywhere in its content stream. */
async function buildScannedPagePdf(rgbCanvas: OffscreenCanvas): Promise<Uint8Array> {
  const w = rgbCanvas.width;
  const h = rgbCanvas.height;
  const rgba = rgbCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]!;
    rgb[j + 1] = rgba[i + 1]!;
    rgb[j + 2] = rgba[i + 2]!;
  }
  const compressed = await deflate(rgb);

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const offsets: number[] = [];
  function pushBytes(bytes: Uint8Array): void {
    chunks.push(bytes);
    pos += bytes.length;
  }
  function pushStr(s: string): void {
    pushBytes(encoder.encode(s));
  }
  function beginObj(n: number): void {
    offsets[n] = pos;
  }

  pushStr('%PDF-1.4\n');
  beginObj(1);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  beginObj(3);
  pushStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  beginObj(4);
  pushStr(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  pushBytes(compressed);
  pushStr('\nendstream\nendobj\n');
  beginObj(5);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  pushStr(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefStart = pos;
  pushStr('xref\n0 6\n0000000000 65535 f\r\n');
  for (let n = 1; n <= 5; n++) {
    pushStr(`${offsets[n]!.toString().padStart(10, '0')} 00000 n\r\n`);
  }
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function renderScannedFormCanvas(labelText: string, valueText: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(400, 200);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = '20px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(labelText, 20, 30);
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(valueText, 20, 80);
  return canvas;
}

function validAadhaar(): string {
  const body = '23456789012';
  return body + verhoeffGenerate(body);
}

describe('a scanned PDF.js page, real end to end (T-6.6)', () => {
  let ocrModels: OcrRescanModels;

  beforeAll(async () => {
    const detSession = await ort.InferenceSession.create('/models/ocr_det_ppocrv5_mobile.onnx', { executionProviders: ['wasm'] });
    const recSession = await ort.InferenceSession.create('/models/ocr_rec_ppocrv5_mobile_en.onnx', { executionProviders: ['wasm'] });
    const vocabulary = buildCtcVocabulary(await loadDictLines('/models/ocr_rec_ppocrv5_mobile_en.dict.txt'));
    ocrModels = { detSession, recSession, vocabulary };
  }, 30000);

  afterAll(async () => {
    await ocrModels.detSession.release();
    await ocrModels.recSession.release();
  });

  it('a real PDF.js render of a scanned page has an empty text layer, and OCR over its canvas finds the Aadhaar number', async () => {
    const aadhaar = validAadhaar();
    const sourceCanvas = renderScannedFormCanvas('Aadhaar on file:', aadhaar);
    const pdfBytes = await buildScannedPagePdf(sourceCanvas);

    const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
    const doc = await loadingTask.promise;
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);

    // The load-bearing claim this test exists to check: a scanned page's real PDF.js text layer
    // is empty, so Channel D/T alone cannot see this value — only OCR over the rendered canvas
    // can. If this fixture accidentally carried a real text-showing operator, this would fail.
    const textContent = await page.getTextContent();
    expect(textContent.items).toHaveLength(0);

    const viewport = page.getViewport({ scale: 1 });
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = viewport.width;
    renderCanvas.height = viewport.height;
    const canvasContext = renderCanvas.getContext('2d')!;
    await page.render({ canvas: renderCanvas, canvasContext, viewport }).promise;

    // `detectTextEntitiesInRegion` takes the same OffscreenCanvas shape `cropRegion()` produces
    // for a real vision node's crop — converting the rendered <canvas> into one here stands in
    // for that, not a change to the OCR module itself.
    const regionCrop = new OffscreenCanvas(renderCanvas.width, renderCanvas.height);
    regionCrop.getContext('2d')!.drawImage(renderCanvas, 0, 0);

    // The PDF.js viewer element's own page position, in the same convention `detectFaces`'s
    // `sourceBox` and T-6.5's canvas test use.
    const sourceBox: [number, number, number, number] = [40, 60, renderCanvas.width, renderCanvas.height];
    const candidates = await detectTextEntitiesInRegion(ort, ocrModels, regionCrop, 'pdf-viewer-node', sourceBox);

    const hits = candidates.filter((c) => c.entity === 'AADHAAR');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.value).toContain(aadhaar);
    expect(hits[0]!.channel).toBe('text-ocr');
    await loadingTask.destroy();
  });
});
