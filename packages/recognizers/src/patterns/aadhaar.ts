import { verhoeffValidate } from '../checksums/verhoeff';
import { AADHAAR_LEXICON } from '../context/lexicons';
import { scoreByContext } from '../context/boost';
import type { Recognizer, RecognizerContext, RecognizerMatch } from '../types';

// design.md §6.2 — 12 digits, optionally grouped 4-4-4 with space or hyphen, first digit 2–9.
const AADHAAR_RE = /\b([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})\b/g;
const MASKED_AADHAAR_RE = /\b[Xx*]{4}[ -]?[Xx*]{4}[ -]?(\d{4})\b/g;

export const aadhaarRecognizer: Recognizer = {
  id: 'pattern:aadhaar',
  entity: 'AADHAAR',
  find(text: string, ctx?: RecognizerContext): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];

    for (const m of text.matchAll(AADHAAR_RE)) {
      const digits = `${m[1]}${m[2]}${m[3]}`;
      const valid = verhoeffValidate(digits);
      const withContext = hasContext(ctx);
      // [Implementation note, deviates from design.md §6.2's literal "0.30" for invalid/no-context]:
      // 0.30 is exactly the CRITICAL class's accept threshold (packages/policy's default policy),
      // so a checksum-invalid, no-context 12-digit run — a plain tracking or order number — would
      // be *fully accepted* as AADHAAR, not merely marked unverified. That directly contradicts
      // AC-11 and design.md's own hard-negative example ("a 12-digit tracking id failing
      // Verhoeff"). Scored at 0.10 instead — matching the card recognizer's invalid score — so it
      // falls below even the fail-closed uncertainty band (floor 0.15) and produces no region at
      // all. The with-context score (0.60, well above the band) is untouched.
      const base = valid ? 0.95 : withContext ? 0.6 : 0.1;
      matches.push({
        entity: 'AADHAAR',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: base,
        source: 'pattern:aadhaar+verhoeff',
        valid,
      });
    }

    for (const m of text.matchAll(MASKED_AADHAAR_RE)) {
      matches.push({
        entity: 'AADHAAR',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.7,
        source: 'pattern:aadhaar-masked',
        valid: true,
      });
    }

    return matches;
  },
};

function hasContext(ctx: RecognizerContext | undefined): boolean {
  return scoreByContext(ctx, AADHAAR_LEXICON, 0, 1) === 1;
}
