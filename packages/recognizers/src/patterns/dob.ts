import { scoreByContext } from '../context/boost';
import { DOB_LEXICON } from '../context/lexicons';
import type { Recognizer, RecognizerContext, RecognizerMatch } from '../types';

// design.md §6.2 — date patterns, label context required to be usable (a bare date is LOW/
// pass-through per §3.3; only a date in a birth-date-labelled field is DOB/HIGH).
const DATE_RE = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;

export const dobRecognizer: Recognizer = {
  id: 'pattern:dob',
  entity: 'DOB',
  find(text: string, ctx?: RecognizerContext): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];
    const score = scoreByContext(ctx, DOB_LEXICON, 0.3, 0.85);
    for (const m of text.matchAll(DATE_RE)) {
      matches.push({
        entity: 'DOB',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score,
        source: 'pattern:dob',
        valid: true,
      });
    }
    return matches;
  },
};
