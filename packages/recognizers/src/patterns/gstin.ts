import { gstinValidate } from '../checksums/gstin';
import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — 2-digit state code + embedded PAN + 1 entity char + 'Z' + check char.
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/g;

export const gstinRecognizer: Recognizer = {
  id: 'pattern:gstin',
  entity: 'GSTIN',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(GSTIN_RE)) {
      const candidate = m[1]!;
      const valid = gstinValidate(candidate);
      matches.push({
        entity: 'GSTIN',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: valid ? 0.95 : 0.4,
        source: 'pattern:gstin+checkchar',
        valid,
      });
    }
    return matches;
  },
};
