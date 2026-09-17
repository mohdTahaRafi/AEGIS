import { describe, expect, it } from 'vitest';
import { digitsOnly, normalizeForMatching } from '../src/normalize';
import { aadhaarRecognizer } from '../src/patterns/aadhaar';
import { verhoeffGenerate } from '../src/checksums/verhoeff';
import { cardRecognizer } from '../src/patterns/card';

// T-3.4 — NFKC, Indic digits, zero-width, full-width.
describe('normalizeForMatching', () => {
  it('maps Devanagari digits to ASCII', () => {
    // U+0966..U+096F = ०१२३४५६७८९
    expect(normalizeForMatching('०१२३४५६७८९')).toBe('0123456789');
  });

  it('maps Bengali and Tamil digit blocks to ASCII', () => {
    expect(normalizeForMatching('০১২৩')).toBe('0123'); // Bengali
    expect(normalizeForMatching('௦௧௨௩')).toBe('0123'); // Tamil
  });

  it('folds full-width digits via NFKC', () => {
    expect(normalizeForMatching('０１２３')).toBe('0123');
  });

  it('strips zero-width characters', () => {
    expect(normalizeForMatching('12​34‌56')).toBe('123456');
  });

  it('digitsOnly strips grouping and non-digits', () => {
    expect(digitsOnly('1234 5678-9012')).toBe('123456789012');
  });
});

describe('normalization feeds recognizers (AC-relevant)', () => {
  it('detects an Aadhaar number written in Devanagari digits with the same score as ASCII', () => {
    const asciiBody = '234567890123'.slice(0, 11);
    const check = verhoeffGenerate(asciiBody);
    const ascii = asciiBody + check;
    const devanagari = ascii.replace(/\d/g, (d) => '०१२३४५६७८९'[Number(d)]!);

    const asciiMatches = aadhaarRecognizer.find(ascii);
    const devanagariMatches = aadhaarRecognizer.find(devanagari);

    expect(asciiMatches).toHaveLength(1);
    expect(devanagariMatches).toHaveLength(1);
    expect(devanagariMatches[0]!.score).toBe(asciiMatches[0]!.score);
    expect(devanagariMatches[0]!.valid).toBe(true);
  });

  it('still detects a card number interrupted by zero-width-joiner characters', () => {
    const withZwj = '4111‍1111‍1111‍1111';
    const matches = cardRecognizer.find(withZwj);
    expect(matches.some((m) => m.valid)).toBe(true);
  });
});
