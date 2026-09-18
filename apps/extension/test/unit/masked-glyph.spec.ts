import { describe, expect, it } from 'vitest';
import { detectMaskedGlyphs } from '../../src/perception/models/masked-glyph';

describe('detectMaskedGlyphs (T-4.8 — DOM half)', () => {
  it('detects a run of bullet characters', () => {
    const match = detectMaskedGlyphs('Password: ••••••••');
    expect(match).not.toBeNull();
  });

  it('detects asterisk masking', () => {
    expect(detectMaskedGlyphs('pwd=********')).not.toBeNull();
  });

  it('does not flag short runs below the minimum length', () => {
    expect(detectMaskedGlyphs('rating: ***')).toBeNull();
  });

  it('does not flag ordinary text with no masking glyphs', () => {
    expect(detectMaskedGlyphs('hello world, nothing to see here')).toBeNull();
  });

  it('returns the correct span', () => {
    const text = 'field: •••••• end';
    const match = detectMaskedGlyphs(text)!;
    expect(text.slice(match.start, match.end)).toBe('••••••');
  });
});
