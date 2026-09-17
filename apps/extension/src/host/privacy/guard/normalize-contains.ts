// design.md §7.6 — `normalizedContains`: "1234 5678 9012" and "123456789012" both match. Used by
// the guard's vault-leak sweep (T-3.23) against a value that is already the vault's *normalized*
// form (digits-only for numeric entities, NFKC-lowercased for the rest — see vault/index.ts's
// `normalizeValue`).

import { digitsOnly, normalizeForMatching } from '@aegis/recognizers';

const MIN_DIGIT_RUN_TO_MATCH = 4; // avoid false positives on trivial short digit runs

// A bounded run of digits with only spaces/hyphens as internal separators (design.md §7.6's own
// example: "1234 5678 9012" grouped). Deliberately NOT "strip every non-digit character from the
// whole payload and concatenate" — a JSON payload has many small, unrelated numbers (box
// coordinates, z-index, confidence scores, `len`) separated by commas/colons/brackets, and
// stripping those separators too would merge adjacent unrelated numbers into one digit river,
// producing false VAULT_LEAK blocks on a genuinely clean payload (caught by a real e2e test
// against an actual fixture, not by inspection). Commas/colons/brackets/quotes are NOT included
// as allowed separators, so each match stays scoped to digits that were actually adjacent (or
// grouped only by spacing/hyphens) in the source text.
const DIGIT_RUN_RE = /\d(?:[\d \-]*\d)?/g;

export function normalizedContains(haystack: string, normalizedNeedle: string): boolean {
  if (normalizedNeedle.length === 0) return false;

  if (haystack.includes(normalizedNeedle)) return true;

  if (/^\d+$/.test(normalizedNeedle) && normalizedNeedle.length >= MIN_DIGIT_RUN_TO_MATCH) {
    for (const run of haystack.match(DIGIT_RUN_RE) ?? []) {
      if (digitsOnly(run).includes(normalizedNeedle)) return true;
    }
  }

  const folded = normalizedNeedle.replace(/\s+/g, '');
  const foldedHaystack = normalizeForMatching(haystack).toLowerCase().replace(/\s+/g, '');
  if (folded.length > 0 && foldedHaystack.includes(folded)) return true;

  return false;
}
