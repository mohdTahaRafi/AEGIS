import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — [A-Z]{4}0[A-Z0-9]{6}. IFSC classifies a bank branch, not a person — MEDIUM
// class per §3.3, but still a structural recognizer like the others.
const IFSC_RE = /\b([A-Z]{4}0[A-Z0-9]{6})\b/g;

export const ifscRecognizer: Recognizer = {
  id: 'pattern:ifsc',
  entity: 'IFSC',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(IFSC_RE)) {
      matches.push({
        entity: 'IFSC',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.85,
        source: 'pattern:ifsc',
        valid: true,
      });
    }
    return matches;
  },
};
