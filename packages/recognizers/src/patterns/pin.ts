import { scoreByContext } from '../context/boost';
import { ADDRESS_LEXICON } from '../context/lexicons';
import type { Recognizer, RecognizerContext, RecognizerMatch } from '../types';

// design.md §6.2 — [1-9][0-9]{5}, only usable with address context (a bare 6-digit run collides
// with too many other numbers — order counts, years, amounts).
const PIN_RE = /\b([1-9]\d{5})\b/g;

export const pinRecognizer: Recognizer = {
  id: 'pattern:pin',
  entity: 'PIN_CODE',
  find(text: string, ctx?: RecognizerContext): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];
    const score = scoreByContext(ctx, ADDRESS_LEXICON, 0.2, 0.7);
    for (const m of text.matchAll(PIN_RE)) {
      matches.push({
        entity: 'PIN_CODE',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score,
        source: 'pattern:pin-in',
        valid: true,
      });
    }
    return matches;
  },
};
