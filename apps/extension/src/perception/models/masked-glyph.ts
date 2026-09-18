// design.md §6.4 / phase_4_vision.md §4.4, T-4.8 — masked-glyph detection. Catches custom
// password-style widgets that render masking characters as ordinary visible text (a `<div>` or
// `<span>` showing "••••••••", not a native `<input type=password>` — those are already caught,
// value-blind, by Phase 3's Channel D protected-value rule in `content/detect/protected.ts`).
//
// Deliberately operates on already-extracted, already-visible text (a text run's string, a node's
// accessible name) — never on a field's `.value` — so it can never become a second path that reads
// a protected value. This is the DOM half; T-4.8's OCR half (masked glyphs rendered as pixels, no
// backing DOM text at all — e.g. a canvas-drawn password field) needs the Phase 6 OCR model and is
// a disclosed gap here, same as `perception/models/vit-encoder.ts`'s.

const MASK_GLYPHS = ['•', '●', '∙', '·', '*'];
const MIN_RUN_LENGTH = 4;

const RUN_RE = new RegExp(`(?:${MASK_GLYPHS.map((g) => `\\${g}`).join('|')}){${MIN_RUN_LENGTH},}`);

export interface MaskedGlyphMatch {
  start: number;
  end: number;
}

/** True if `text` contains a run of `MIN_RUN_LENGTH`+ masking glyphs — evidence of a password-like
 * value rendered as visible text rather than read from a protected field. */
export function detectMaskedGlyphs(text: string): MaskedGlyphMatch | null {
  const match = RUN_RE.exec(text);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}
