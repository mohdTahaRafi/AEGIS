import { luhnValidate, matchesIinRange } from '../checksums/luhn';
import { digitsOnly } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — 13-19 digits, optionally grouped. Luhn + IIN range is what separates a card
// number from an order number of the same length (AC-11's hard negative).
const CARD_RE = /\b(\d[ -]?){13,19}\b/g;

export const cardRecognizer: Recognizer = {
  id: 'pattern:card',
  entity: 'CARD_NUMBER',
  find(text: string): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(CARD_RE)) {
      const digits = digitsOnly(m[0]);
      if (digits.length < 13 || digits.length > 19) continue;
      const luhnOk = luhnValidate(digits);
      const iinOk = matchesIinRange(digits);
      const valid = luhnOk && iinOk;
      matches.push({
        entity: 'CARD_NUMBER',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: valid ? 0.95 : 0.1,
        source: 'pattern:card+luhn',
        valid,
      });
    }
    return matches;
  },
};
