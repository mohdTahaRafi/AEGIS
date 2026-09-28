// design.md §6.1 — Channel D: DOM signals, near-certain and zero-cost, computed content-side
// (this module has DOM access; fusion, which combines this with Channel T/NER, is host-side per
// architecture §15.2 — this only emits the raw per-node signal, never decides accept/reject).
//
// The signal is the field's SEMANTIC type (field-semantics.ts), derived only from evidence bound
// to the field — never from its value — so it survives a malformed, partial or empty value.

import type { EntityType } from '@aegis/recognizers';
import { KYC_PAYMENT_LEXICON } from '@aegis/recognizers';
import { classifyFieldSemantics, isTextEntryField, type EvidenceSource, type FieldSemantics } from './field-semantics';
import { classifyProtected } from './protected';

export interface ChannelDSignal {
  entity: EntityType;
  score: number;
  /** False for the five protected classes (design.md §6.1's "Value read?" column). */
  valueRead: boolean;
  /** Other entities the same field-bound text names ("Email / Mobile"); the host's value
   * recognizers may pick one of these instead of `entity`, never anything outside the set. */
  alternatives?: EntityType[];
  /** Which evidence decided `entity` — a closed enum, safe for the ledger/logs. */
  source?: EvidenceSource | 'protected';
}

function kycFormContext(el: Element): boolean {
  const form = el.closest('form');
  const scope = form ?? el.closest('body') ?? el;
  const text = (scope.textContent ?? '').toLowerCase();
  return KYC_PAYMENT_LEXICON.some((w) => text.includes(w));
}

/** Returns the field's Channel D signal, or `undefined` when nothing bound to it names a sensitive
 * type. Protected classes are decided first, exclusively, via `classifyProtected`. Pass
 * `semantics` when the caller already computed it (the extractor does, once per field). */
export function classifyChannelD(el: Element, semantics: FieldSemantics | undefined = classifyFieldSemantics(el)): ChannelDSignal | undefined {
  if (!isTextEntryField(el)) return undefined;

  const protectedClass = classifyProtected(el, semantics);
  if (protectedClass) {
    // Masking (`type=password`, `-webkit-text-security`) says "never read this", not "this is a
    // password": DigiLocker masks its "Aadhaar or VID Number" input. The value stays unread
    // either way; the type comes from the field's semantics when they name a non-secret one, so
    // a sealed Aadhaar can still be filled into it.
    // A nearby caption is too weak to re-type a masked box ("Enter your registered email" above a
    // password field).
    const retype = protectedClass === 'PASSWORD' && semantics && !semantics.protectedClass && semantics.source !== 'nearby';
    const entity = retype ? semantics.entity : protectedClass;
    return { entity, score: 1.0, valueRead: false, source: 'protected' };
  }

  if (!semantics) return undefined;
  const signal: ChannelDSignal = { entity: semantics.entity, score: semantics.score, valueRead: true, source: semantics.source };
  if (semantics.alternatives.length > 0) signal.alternatives = semantics.alternatives;
  return applyKycBoost(el, signal);
}

function applyKycBoost(el: Element, signal: ChannelDSignal): ChannelDSignal {
  if (!kycFormContext(el)) return signal;
  return { ...signal, score: Math.min(1, signal.score + 0.15) };
}
