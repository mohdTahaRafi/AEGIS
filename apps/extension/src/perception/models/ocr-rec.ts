// design.md §6.4 (Channel V OCR recognition) / architecture.md §6.3, T-6.3/T-6.4 — PP-OCRv5
// mobile recognizer integration (English/Latin and Devanagari, design.md's script-routing
// requirement). CTC decode is transcribed from PaddleOCR's real `CTCLabelDecode` source
// (`ppocr/postprocess/rec_postprocess.py`), not re-derived: `add_special_char` builds the
// vocabulary as `['blank'] + dict_character`, where `dict_character` already has a trailing space
// appended (PaddleOCR's `use_space_char=True`, PP-OCRv5's default). Verified against the REAL
// bundled models, not just the public source: `ocr-rec-ppocrv5-mobile-en`'s output is [N,T,438]
// and `ocr_rec_ppocrv5_mobile_en.dict.txt` has 436 lines — 1 (blank) + 436 (dict) + 1 (space) =
// 438, exactly. Same check for the Devanagari model (570 = 1 + 568 + 1). See models.manifest.json
// for the real ORT introspection this was checked against.

import type * as ort from 'onnxruntime-web';
import { resizeForRecognition, toCHWFloat32BGRNormalized } from '../preprocess/ocr-resize';

const CTC_BLANK_INDEX = 0;

/** Builds the exact PaddleOCR CTC vocabulary from a loaded dict file's lines: index 0 = blank,
 * indices 1..N = the dict's characters in order, index N+1 = space. `dictLines` must already have
 * blank/trailing-newline lines stripped by the caller (a dict file's own literal empty lines, if
 * any, are real vocabulary entries in PaddleOCR's convention and must not be silently dropped —
 * only the trailing-newline artifact of reading the file as text should be). */
export function buildCtcVocabulary(dictLines: readonly string[]): string[] {
  return ['', ...dictLines, ' '];
}

/** Greedy CTC decode (PaddleOCR's `CTCLabelDecode.decode` with `is_remove_duplicate=True`):
 * argmax per timestep, collapse consecutive-duplicate indices, then drop blanks. Pure function
 * over already-extracted logits/probabilities so it can be unit-tested without a real ONNX
 * session — same separation-of-concerns as `decodeYunetOutputs`/`decodeDbOutput`. */
export function ctcGreedyDecode(logits: Float32Array, seqLen: number, vocabSize: number, vocabulary: readonly string[]): { text: string; confidence: number; steps: number[] } {
  if (vocabulary.length !== vocabSize) {
    throw new Error(`CTC vocabulary size ${vocabulary.length} does not match model output width ${vocabSize} — dict file and model are mismatched`);
  }

  let text = '';
  // Timestep of each emitted character (one per UTF-16 unit of `text`): where it sits along the line.
  const steps: number[] = [];
  let lastIndex = -1;
  let confSum = 0;
  let confCount = 0;

  for (let t = 0; t < seqLen; t++) {
    const offset = t * vocabSize;
    let bestIndex = 0;
    let bestValue = logits[offset]!;
    for (let v = 1; v < vocabSize; v++) {
      const value = logits[offset + v]!;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = v;
      }
    }
    if (bestIndex !== CTC_BLANK_INDEX && bestIndex !== lastIndex) {
      const ch = vocabulary[bestIndex] ?? '';
      text += ch;
      for (let k = 0; k < ch.length; k++) steps.push(t);
      confSum += bestValue;
      confCount++;
    }
    lastIndex = bestIndex;
  }

  return { text, confidence: confCount === 0 ? 0 : confSum / confCount, steps };
}

export interface RecognizedLine {
  text: string;
  confidence: number;
  /** Per character of `text`: its horizontal extent in the line crop's own pixels. */
  charSpans?: [number, number][];
}

/** Horizontal pixel range `[x0, x1)` of `text[start..end)` in the line crop, from the CTC timesteps
 * (each timestep covers a fixed slice of the line's width). Padded by half a character on each
 * side; null when positions are unknown. */
export function spanExtent(line: RecognizedLine, start: number, end: number, lineWidth: number): [number, number] | null {
  const spans = line.charSpans;
  if (!spans || spans.length === 0 || start >= end) return null;
  const first = spans[Math.max(0, Math.min(start, spans.length - 1))]!;
  const last = spans[Math.max(0, Math.min(end - 1, spans.length - 1))]!;
  const charW = spans.length > 1 ? (spans[spans.length - 1]![1] - spans[0]![0]) / spans.length : first[1] - first[0];
  const x0 = Math.max(0, first[0] - charW * 0.6);
  const x1 = Math.min(lineWidth, last[1] + charW * 0.6);
  return x1 > x0 ? [x0, x1] : null;
}

/** Runs a bundled PP-OCRv5 recognizer (English or Devanagari, chosen by the caller via
 * `script-route.ts`) over one already-detected text-line crop and returns the decoded text.
 * `logits` here are whatever the model's own final layer emits — PP-OCRv5's rec export ends in a
 * softmax (confirmed by a real inference run producing values in [0,1] summing to ~1 per
 * timestep, see this module's test), so `ctcGreedyDecode`'s "confidence" is a real per-character
 * probability, not a raw logit. */
export async function recognizeLine(session: ort.InferenceSession, ort_: typeof ort, crop: ImageBitmap | OffscreenCanvas, vocabulary: readonly string[]): Promise<RecognizedLine> {
  const resized = resizeForRecognition(crop);
  const tensor = new ort_.Tensor('float32', toCHWFloat32BGRNormalized(resized.canvas), [
    1,
    3,
    resized.canvas.height,
    resized.canvas.width,
  ]);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('OCR recognition model exposes no input names');
  const results = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  if (!outputName) throw new Error('OCR recognition model exposes no output names');
  const output = results[outputName]!;
  const [, seqLen, vocabSize] = output.dims as [number, number, number];

  const decoded = ctcGreedyDecode(output.data as Float32Array, seqLen, vocabSize, vocabulary);
  // Timestep t covers [t, t+1) * (input width / seqLen) of the resized line; mapped back to the
  // crop through the resize scale.
  const stepPx = resized.canvas.width / seqLen / resized.scale;
  const charSpans = decoded.steps.map((t) => [t * stepPx, (t + 1) * stepPx] as [number, number]);
  return { text: decoded.text, confidence: decoded.confidence, charSpans };
}
