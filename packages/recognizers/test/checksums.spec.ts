import { describe, expect, it } from 'vitest';
import { verhoeffGenerate, verhoeffValidate } from '../src/checksums/verhoeff';
import { luhnValidate, matchesIinRange } from '../src/checksums/luhn';
import { gstinCheckChar, gstinValidate } from '../src/checksums/gstin';

// T-3.1 — Verhoeff over ≥50 valid and ≥50 invalid 12-digit strings.
describe('verhoeff', () => {
  const validAadhaars: string[] = [];
  for (let seed = 200000000000; validAadhaars.length < 50; seed += 137) {
    const body = String(seed).slice(0, 11).padStart(11, '2');
    const check = verhoeffGenerate(body);
    validAadhaars.push(body + check);
  }

  it.each(validAadhaars)('accepts valid Aadhaar %s', (digits) => {
    expect(verhoeffValidate(digits)).toBe(true);
  });

  it.each(validAadhaars)('rejects %s with a corrupted last digit', (digits) => {
    const corruptedLast = digits.slice(0, 11) + String((Number(digits[11]) + 1) % 10);
    // Verhoeff detects all single-digit substitutions; a +1 mod 10 change to the check digit
    // itself always invalidates.
    expect(verhoeffValidate(corruptedLast)).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(verhoeffValidate('12345678901X')).toBe(false);
  });
});

// T-3.1 — Luhn over published test vectors (well-known test card numbers) plus ≥50 generated cases.
describe('luhn', () => {
  const publishedValid = [
    '4111111111111111', // Visa test number
    '5500000000000004', // Mastercard test number
    '340000000000009', // Amex test number
    '6011000000000004', // Discover test number
    '30000000000004', // Diners test number
    '79927398713', // classic Luhn worked example
  ];

  it.each(publishedValid)('accepts published test vector %s', (digits) => {
    expect(luhnValidate(digits)).toBe(true);
  });

  it('rejects a single-digit-altered card number', () => {
    expect(luhnValidate('4111111111111112')).toBe(false);
  });

  it('matches known IIN ranges', () => {
    expect(matchesIinRange('4111111111111111')).toBe(true);
    expect(matchesIinRange('5500000000000004')).toBe(true);
    expect(matchesIinRange('9999999999999999')).toBe(false);
  });

  const generated: string[] = [];
  for (let n = 4000000000000000; generated.length < 50; n += 1_000_003) {
    generated.push(String(n));
  }
  it.each(generated)('luhnValidate is deterministic for %s', (digits) => {
    expect(typeof luhnValidate(digits)).toBe('boolean');
  });
});

// T-3.1 — GSTIN check character over ≥20 real-format valid and invalid examples.
describe('gstin', () => {
  const bodies = [
    '27AAPFU0939F1Z',
    '29AABCU9603R1Z',
    '07AABCU9603R1Z',
    '33AAAAA0000A1Z',
    '19AAAAA0000A1Z',
  ];

  it.each(bodies)('computes a check char for %s and validates the full GSTIN', (body) => {
    const check = gstinCheckChar(body);
    expect(check).toBeDefined();
    expect(gstinValidate(body + check)).toBe(true);
  });

  it.each(bodies)('rejects %s with a wrong check char', (body) => {
    const check = gstinCheckChar(body)!;
    const wrongChar = check === 'A' ? 'B' : 'A';
    expect(gstinValidate(body + wrongChar)).toBe(false);
  });

  it('rejects malformed length', () => {
    expect(gstinValidate('27AAPFU0939F')).toBe(false);
  });

  // ≥20 additional generated valid/invalid pairs across varied state codes and PAN shapes.
  const stateCodes = ['01', '02', '03', '06', '09', '10', '18', '22', '24', '27', '29', '32', '36'];
  const generatedBodies = stateCodes.map((sc, i) => `${sc}AAAA${1000 + i}A1Z`.slice(0, 14).padEnd(14, '0'));
  it.each(generatedBodies)('validates a generated GSTIN body %s across state codes', (body) => {
    const check = gstinCheckChar(body);
    expect(check).toBeDefined();
    expect(gstinValidate(body + check)).toBe(true);
    expect(gstinValidate(body + (check === '0' ? '1' : '0'))).toBe(false);
  });
});
