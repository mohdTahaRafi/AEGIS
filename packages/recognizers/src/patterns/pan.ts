import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — [A-Z]{5}[0-9]{4}[A-Z]; the 4th character encodes the holder type and must be
// one of a known set, which is what separates a real PAN from a catalog product code of the same
// shape (AC-11's hard negative).
const PAN_RE = /\b([A-Z]{3})([ABCFGHJLPT])([A-Z])(\d{4})([A-Z])\b/g;
const HOLDER_TYPES = new Set(['A', 'B', 'C', 'F', 'G', 'H', 'J', 'L', 'P', 'T']);

export const panRecognizer: Recognizer = {
  id: 'pattern:pan',
  entity: 'PAN',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(PAN_RE)) {
      const holderType = m[2]!;
      const valid = HOLDER_TYPES.has(holderType);
      if (!valid) continue;
      matches.push({
        entity: 'PAN',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.9,
        source: 'pattern:pan',
        valid: true,
      });
    }
    return matches;
  },
};
