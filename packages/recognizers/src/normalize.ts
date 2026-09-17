// design.md §6.2 — normalisation before matching: NFKC, Indic digits → ASCII, zero-width
// characters removed, full-width forms folded. T-3.4. Not optional: A-4 assumes page content may
// include Indic scripts, so a recognizer that only sees ASCII digits has a silent recall hole.

// Devanagari (U+0966-096F), Bengali (U+09E6-09EF), Gurmukhi (U+0A66-0A6F), Gujarati
// (U+0AE6-0AEF), Tamil (U+0BE6-0BEF), Telugu (U+0C66-0C6F), Kannada (U+0CE6-0CEF), Malayalam
// (U+0D66-0D6F) — each block is 10 consecutive code points 0-9, same order as ASCII.
const INDIC_DIGIT_BLOCKS: ReadonlyArray<number> = [
  0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0be6, 0x0c66, 0x0ce6, 0x0d66,
];

const ZERO_WIDTH_RE = /[​‌‍⁠﻿]/g;

function foldIndicDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    const block = INDIC_DIGIT_BLOCKS.find((start) => cp >= start && cp <= start + 9);
    out += block !== undefined ? String(cp - block) : ch;
  }
  return out;
}

/** Applied to all text before recognizers run over it. Order matters: NFKC first (folds
 * full-width forms and many compatibility characters), then Indic-digit mapping (NFKC does not
 * touch these — they are canonical, not compatibility, code points), then zero-width stripping. */
export function normalizeForMatching(input: string): string {
  return foldIndicDigits(input.normalize('NFKC')).replace(ZERO_WIDTH_RE, '');
}

/** Digits-only, whitespace/hyphen/grouping-agnostic form used by checksum validators and by the
 * guard's `normalizedContains` (design.md §7.6) — `1234 5678 9012` and `123456789012` must match. */
export function digitsOnly(input: string): string {
  return normalizeForMatching(input).replace(/[^\d]/g, '');
}
