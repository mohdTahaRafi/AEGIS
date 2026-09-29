import { digitsOnly } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — optional +91/0 then a [6-9] mobile number, contiguous or in the 5-5 / 3-3-4
// groupings Indian pages print ("98765 43210"). `\b` cannot precede `+`, so a digit/plus
// lookbehind anchors the start instead.
const INDIAN_MOBILE_RE = /(?<![\d+])(?:\+91[ -]?|0)?([6-9]\d{9}|[6-9]\d{4}[ -]\d{5}|[6-9]\d{2}[ -]\d{3}[ -]\d{4})(?!\d)/g;
// A small per-country length table for E.164-like international numbers (design.md's "length by
// country" — deliberately small, not a full libphonenumber port).
const COUNTRY_LENGTHS: Record<string, number> = {
  '1': 10, // US/Canada
  '44': 10, // UK
  '61': 9, // Australia
  '971': 9, // UAE
  '65': 8, // Singapore
};
const INTL_RE = /\+(\d{1,3})[ -]?(\d{6,12})\b/g;

export const phoneRecognizer: Recognizer = {
  id: 'pattern:phone',
  entity: 'PHONE',
  find(text: string): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];

    for (const m of text.matchAll(INDIAN_MOBILE_RE)) {
      matches.push({
        entity: 'PHONE',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.8,
        source: 'pattern:phone-in',
        valid: true,
      });
    }

    for (const m of text.matchAll(INTL_RE)) {
      const cc = m[1]!;
      // +91 handled by the Indian-mobile pattern above; skip to avoid double-counting.
      if (cc === '91') continue;
      const expectedLen = COUNTRY_LENGTHS[cc];
      const nationalDigits = digitsOnly(m[2]!);
      if (expectedLen !== undefined && nationalDigits.length !== expectedLen) continue;
      matches.push({
        entity: 'PHONE',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.7,
        source: 'pattern:phone-intl',
        valid: true,
      });
    }

    return matches;
  },
};
