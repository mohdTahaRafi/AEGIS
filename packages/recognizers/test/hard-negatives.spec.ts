import { describe, expect, it } from 'vitest';
import { ALL_RECOGNIZERS } from '../src/registry';

// T-3.5 / AC-11 — none of these should be detected as *valid* by any recognizer. A checksum-
// invalid hit is fine to *match* (that's the uncertainty band's job upstream in fusion) but must
// never report `valid: true` for a CRITICAL/HIGH entity, since that's what fusion accepts above
// threshold without a band discount.
// Entities backed by a checksum/structural validator: a hard negative must come back `valid:
// false` (the checksum itself catches it). Entities that are context-gated rather than
// checksum-gated (DOB, PIN_CODE, PASSPORT) have no checksum to fail — their hard-negative defence
// is scoring at the "no context" floor, which fusion's threshold band (design.md §7.1 step 2)
// then drops. Both are "not detected as this entity" in effect; they just get there differently.
const CHECKSUM_BACKED = new Set(['AADHAAR', 'CARD_NUMBER', 'GSTIN', 'PAN']);

const HARD_NEGATIVES: ReadonlyArray<{ text: string; label: string }> = [
  { text: 'Tracking number: 234567890128', label: 'a 12-digit tracking id shaped like Aadhaar' },
  { text: 'Order #1234567890123456', label: 'a 16-digit order number shaped like a card' },
  { text: 'Product code: ABCDE1234F', label: 'a PAN-shaped catalog product code' },
  { text: 'Price: 4567', label: 'a bare price' },
  { text: 'SKU-1234567890123', label: 'a SKU number' },
  { text: 'Reference: 27ZZZZZ0000Z1Z9', label: 'a GSTIN-shaped reference with a bad check char' },
];

describe('hard negatives (AC-11) — checksum-backed entities', () => {
  for (const { text, label } of HARD_NEGATIVES) {
    it(`no recognizer reports a valid CRITICAL/HIGH match for ${label}`, () => {
      for (const recognizer of ALL_RECOGNIZERS) {
        if (!CHECKSUM_BACKED.has(recognizer.entity)) continue;
        const matches = recognizer.find(text);
        for (const m of matches) {
          if (m.valid) {
            throw new Error(`${recognizer.id} reported a VALID match on hard negative "${text}": ${JSON.stringify(m)}`);
          }
        }
      }
    });
  }
});

describe('hard negatives (AC-11) — context-gated entities score at the no-context floor', () => {
  it('a date with no DOB context scores at the DOB no-context floor (0.30), well under threshold', () => {
    const [m] = ALL_RECOGNIZERS.find((r) => r.entity === 'DOB')!.find('Released on 2024-01-15');
    expect(m!.score).toBe(0.3);
  });

  it('a bare 6-digit number with no address context scores at the PIN_CODE no-context floor (0.20)', () => {
    const [m] = ALL_RECOGNIZERS.find((r) => r.entity === 'PIN_CODE')!.find('654321');
    expect(m!.score).toBe(0.2);
  });

  it('an alphanumeric code shaped like a passport with no label context scores at the floor (0.30)', () => {
    const [m] = ALL_RECOGNIZERS.find((r) => r.entity === 'PASSPORT')!.find('Model J1234567 in stock');
    expect(m!.score).toBe(0.3);
  });
});
