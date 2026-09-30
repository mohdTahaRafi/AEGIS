// A last check, independent of the redaction pipeline, that nothing raw reaches the model. The
// guard redacts before anything leaves the browser; this looks at the finished step once more. A
// step whose free text still carries a raw, checksum-valid identifier is refused
// (UNSANITIZED_CONTEXT) and never sent, and the session re-seals the text and tries again.
//
// Only high-precision patterns are used (checksums, strict formats), so a correctly sanitized page
// is not refused for ordinary text. Placeholders (⟪ENTITY#n⟫) are removed before scanning. What is
// found is reported as entity names only, never the matched text.

const PLACEHOLDER = /⟪[A-Z_]+(?:#\d+)?⟫/g;

// Keys whose values are protocol vocabulary, opaque ids or image bytes, never page text.
const STRUCTURAL_KEYS = new Set([
  'schema', 'step_id', 'delta_of', 'reason', 'category', 'status', 'id', 'role', 'frame', 'kind', 'entity', 'ref', 'class',
  'method', 'sources', 'affordances', 'level', 'sha256', 'data', 'format', 'op',
]);

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(ch)]!]!;
  });
  return c === 0;
}

function luhnValid(digits: string): boolean {
  let total = 0;
  [...digits].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) d = d > 4 ? d * 2 - 9 : d * 2;
    total += d;
  });
  return total % 10 === 0;
}

const AADHAAR = /(?<!\d)([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/g;
const PAN = /(?<![A-Z0-9])[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z](?![A-Z0-9])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const MOBILE = /(?<![\d+])(?:\+91[ -]?|0)?(?:[6-9]\d{9}|[6-9]\d{4}[ -]\d{5}|[6-9]\d{2}[ -]\d{3}[ -]\d{4})(?!\d)/;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function textLeaves(value: unknown, key?: string): string[] {
  if (key !== undefined && STRUCTURAL_KEYS.has(key)) return [];
  if (typeof value === 'string') return [value.replace(PLACEHOLDER, ' ')];
  if (Array.isArray(value)) return value.flatMap((item) => textLeaves(item));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => textLeaves(v, k));
  return [];
}

/** Entity names of raw identifiers found in the step's page/user text (empty = clean). */
export function findUnsanitized(step: object): string[] {
  const found = new Set<string>();
  for (const text of textLeaves(step)) {
    for (const m of text.matchAll(AADHAAR)) {
      if (verhoeffValid(`${m[1]}${m[2]}${m[3]}`)) found.add('AADHAAR');
    }
    if (PAN.test(text)) found.add('PAN');
    if (EMAIL.test(text)) found.add('EMAIL');
    if (MOBILE.test(text)) found.add('PHONE');
    for (const m of text.matchAll(CARD)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits) && new Set(digits).size > 1) found.add('CARD_NUMBER');
    }
  }
  return [...found].sort();
}
