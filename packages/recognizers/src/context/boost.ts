import type { RecognizerContext } from '../types';
import { matchesLexicon } from './lexicons';

function contextText(ctx: RecognizerContext | undefined): string {
  if (!ctx) return '';
  return [ctx.label, ctx.name, ctx.autocomplete].filter(Boolean).join(' ');
}

/** True if the field/run's label, name or autocomplete matches any word in `lexicon`
 * (design.md §6.1/§6.2's "label/name/autocomplete context"). */
export function hasLexiconContext(ctx: RecognizerContext | undefined, lexicon: readonly string[]): boolean {
  return matchesLexicon(contextText(ctx), lexicon);
}

/** design.md §6.1's "field inside a form whose context matches a KYC/payment lexicon" → +0.15,
 * capped at 1. */
export function applyKycBoost(score: number, ctx: RecognizerContext | undefined, kycLexicon: readonly string[]): number {
  return hasLexiconContext(ctx, kycLexicon) ? Math.min(1, score + 0.15) : score;
}

/** For recognizers whose score depends on whether context is present at all (passport, PIN code,
 * DOB — design.md §6.2's "label context required" rows): returns `withContext` if the lexicon
 * matches, else `withoutContext`. */
export function scoreByContext(
  ctx: RecognizerContext | undefined,
  lexicon: readonly string[],
  withoutContext: number,
  withContext: number,
): number {
  return hasLexiconContext(ctx, lexicon) ? withContext : withoutContext;
}
