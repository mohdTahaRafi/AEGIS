// design.md §6.1/§6.2's "protected-value rule" (T-3.9, FR-23, AC-2). This module exists
// specifically so classification can happen BEFORE any `.value` access — see extractor.ts's
// `computeField`, which calls `classifyProtected` first and, if it returns non-null, has no
// further expression that reads `.value` as a string for that element at all.

import type { EntityType } from '@aegis/recognizers';

export type ProtectedClass = Extract<EntityType, 'PASSWORD' | 'OTP' | 'CARD_NUMBER' | 'CARD_CVV' | 'SECRET'>;

const OTP_WORDING_RE = /\b(otp|one[\s-]?time|verification code|passcode)\b/i;
const SECRET_WORDING_RE = /\b(api[\s-]?key|secret|access token|client secret)\b/i;

function maskedGlyphRun(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.value.length > 0 && /^[•●*]+$/.test(el.value);
}

function isMaskedCss(el: Element): boolean {
  const value = getComputedStyle(el).getPropertyValue('-webkit-text-security');
  return value !== '' && value !== 'none';
}

/**
 * Design.md §6.1's Channel D signal table, restricted to the five protected classes. Uses only
 * attributes/CSS — never `.value` as a string (masked-glyph detection reads `.value` but only to
 * test a shape, via a regex, immediately, with the result discarded; nothing binds the string to
 * a variable outside this function's stack frame — see T-3.9's source-level AC).
 */
export function classifyProtected(el: Element): ProtectedClass | undefined {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return undefined;

  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  const nameOrId = `${el.name} ${el.id}`.toLowerCase();

  if (el instanceof HTMLInputElement && el.type === 'password') return 'PASSWORD';
  if (isMaskedCss(el) || maskedGlyphRun(el)) return 'PASSWORD';
  if (autocomplete.includes('one-time-code')) return 'OTP';
  if (OTP_WORDING_RE.test(nameOrId)) return 'OTP';
  if (autocomplete.includes('cc-number')) return 'CARD_NUMBER';
  if (autocomplete.includes('cc-csc')) return 'CARD_CVV';
  if (SECRET_WORDING_RE.test(nameOrId)) return 'SECRET';

  return undefined;
}
