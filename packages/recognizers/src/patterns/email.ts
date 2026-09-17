import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — RFC-5322-lite with a TLD sanity check.
const EMAIL_RE = /\b[a-zA-Z0-9.\-_+]{1,64}@[a-zA-Z0-9.\-]{1,255}\.[a-zA-Z]{2,24}\b/g;

export const emailRecognizer: Recognizer = {
  id: 'pattern:email',
  entity: 'EMAIL',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(EMAIL_RE)) {
      matches.push({
        entity: 'EMAIL',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.95,
        source: 'pattern:email',
        valid: true,
      });
    }
    return matches;
  },
};
