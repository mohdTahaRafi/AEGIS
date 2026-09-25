// design.md's "regexes compiled once at module load, not per call" (§19) is satisfied by every
// pattern file above defining its RegExp at module scope; this registry just aggregates them.

import { normalizeForMatching } from './normalize';
import { aadhaarRecognizer } from './patterns/aadhaar';
import { cardRecognizer } from './patterns/card';
import { dobRecognizer } from './patterns/dob';
import { emailRecognizer } from './patterns/email';
import { gstinRecognizer } from './patterns/gstin';
import { ifscRecognizer } from './patterns/ifsc';
import { panRecognizer } from './patterns/pan';
import { passportRecognizer } from './patterns/passport';
import { phoneRecognizer } from './patterns/phone';
import { pinRecognizer } from './patterns/pin';
import { secretRecognizer } from './patterns/secret';
import { upiRecognizer } from './patterns/upi';
import { vehicleRecognizer } from './patterns/vehicle';
import type { EntityType, Recognizer, RecognizerContext, RecognizerMatch } from './types';

export const ALL_RECOGNIZERS: readonly Recognizer[] = [
  aadhaarRecognizer,
  panRecognizer,
  gstinRecognizer,
  ifscRecognizer,
  upiRecognizer,
  cardRecognizer,
  phoneRecognizer,
  emailRecognizer,
  passportRecognizer,
  vehicleRecognizer,
  pinRecognizer,
  dobRecognizer,
  secretRecognizer,
];

/** design.md §7.6 step 4's "recognizers where class ≥ HIGH" needs an entity→class map, which the
 * guard has (it depends on @aegis/policy); this registry stays policy-agnostic and just exposes
 * everything by entity so the caller can filter. */
export function recognizersFor(entities: readonly EntityType[]): Recognizer[] {
  const set = new Set(entities);
  return ALL_RECOGNIZERS.filter((r) => set.has(r.entity));
}

/** T-5.14: normalizes once here rather than in each recognizer — with 13 recognizers, per-recognizer
 * normalization meant the same string got NFKC-folded, Indic-digit-mapped and zero-width-stripped up
 * to 13 times per call. `Recognizer.find` now requires pre-normalized text (see its doc comment). */
export function findAll(text: string, ctx?: RecognizerContext, recognizers: readonly Recognizer[] = ALL_RECOGNIZERS): RecognizerMatch[] {
  const normalized = normalizeForMatching(text);
  const out: RecognizerMatch[] = [];
  for (const r of recognizers) out.push(...r.find(normalized, ctx));
  return out;
}
