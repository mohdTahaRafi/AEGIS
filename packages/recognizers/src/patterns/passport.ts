import { scoreByContext } from '../context/boost';
import { PASSPORT_LEXICON } from '../context/lexicons';
import type { Recognizer, RecognizerContext, RecognizerMatch } from '../types';

// design.md §6.2 — [A-Z][0-9]{7}, label context required to be usable at all (0.30 without
// context, 0.85 with) since the bare pattern collides heavily with other alphanumeric codes.
const PASSPORT_RE = /\b([A-Z]\d{7})\b/g;

export const passportRecognizer: Recognizer = {
  id: 'pattern:passport',
  entity: 'PASSPORT',
  find(text: string, ctx?: RecognizerContext): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];
    const score = scoreByContext(ctx, PASSPORT_LEXICON, 0.3, 0.85);
    for (const m of text.matchAll(PASSPORT_RE)) {
      matches.push({
        entity: 'PASSPORT',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score,
        source: 'pattern:passport-in',
        valid: true,
      });
    }
    return matches;
  },
};
