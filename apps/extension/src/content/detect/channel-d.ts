// design.md §6.1 — Channel D: DOM signals, near-certain and zero-cost, computed content-side
// (this module has DOM access; fusion, which combines this with Channel T/NER, is host-side per
// architecture §15.2 — this only emits the raw per-node signal, never decides accept/reject).

import type { EntityType } from '@aegis/recognizers';
import { KYC_PAYMENT_LEXICON } from '@aegis/recognizers';
import { classifyProtected } from './protected';

export interface ChannelDSignal {
  entity: EntityType;
  score: number;
  /** False for the five protected classes (design.md §6.1's "Value read?" column). */
  valueRead: boolean;
}

const AUTOCOMPLETE_095: Record<string, EntityType> = {
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'postal-code': 'PIN_CODE',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  name: 'PERSON_NAME',
  'given-name': 'PERSON_NAME',
  'family-name': 'PERSON_NAME',
  username: 'USERNAME',
};

const NAME_ID_HEURISTICS: ReadonlyArray<{ re: RegExp; entity: EntityType }> = [
  { re: /aadhaar|aadhar|\buid\b|uidai/i, entity: 'AADHAAR' },
  { re: /\bpan\b/i, entity: 'PAN' },
  { re: /\bacct\b|account/i, entity: 'BANK_ACCOUNT' },
  { re: /ifsc/i, entity: 'IFSC' },
  { re: /\bdob\b|birth/i, entity: 'DOB' },
  { re: /passport/i, entity: 'PASSPORT' },
  { re: /\bupi\b/i, entity: 'UPI_VPA' },
];

function isFormField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function kycFormContext(el: Element): boolean {
  const form = el.closest('form');
  const scope = form ?? el.closest('body') ?? el;
  const text = (scope.textContent ?? '').toLowerCase();
  return KYC_PAYMENT_LEXICON.some((w) => text.includes(w));
}

/** Returns the single highest-scoring Channel D signal for `el`, or `undefined` if none of
 * design.md §6.1's rows match. Field name/id/label heuristics only fire for value-readable
 * classes — the protected classes are handled first, exclusively, via `classifyProtected`. */
export function classifyChannelD(el: Element, accessibleName: string): ChannelDSignal | undefined {
  if (!isFormField(el)) return undefined;

  const protectedClass = classifyProtected(el);
  if (protectedClass) return { entity: protectedClass, score: 1.0, valueRead: false };

  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  if (autocomplete.includes('cc-exp')) return { entity: 'CARD_EXPIRY', score: 1.0, valueRead: true };
  if (autocomplete.includes('cc-name')) return { entity: 'PERSON_NAME', score: 0.95, valueRead: true };

  const acKey = autocomplete.split(' ').pop() ?? autocomplete;
  if (AUTOCOMPLETE_095[acKey]) {
    return applyKycBoost(el, { entity: AUTOCOMPLETE_095[acKey]!, score: 0.95, valueRead: true });
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === 'email' || el.inputMode === 'email') {
      return applyKycBoost(el, { entity: 'EMAIL', score: 0.85, valueRead: true });
    }
    if (el.type === 'tel' || el.inputMode === 'tel') {
      return applyKycBoost(el, { entity: 'PHONE', score: 0.85, valueRead: true });
    }
  }

  const nameOrId = `${el.name} ${el.id} ${accessibleName}`;
  for (const { re, entity } of NAME_ID_HEURISTICS) {
    if (re.test(nameOrId)) return applyKycBoost(el, { entity, score: 0.6, valueRead: true });
  }

  return undefined;
}

function applyKycBoost(el: Element, signal: ChannelDSignal): ChannelDSignal {
  if (!kycFormContext(el)) return signal;
  return { ...signal, score: Math.min(1, signal.score + 0.15) };
}
