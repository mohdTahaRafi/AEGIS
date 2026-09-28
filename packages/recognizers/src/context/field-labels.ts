// design.md §6.1's "name/id/label heuristics" row, generalised to every entity a form field can
// hold. This is the field-SEMANTICS lexicon: it maps the text a page associates with a field (its
// label, aria-label, placeholder, name/id attribute, nearby caption) to entity types, so a field
// is classified by what it IS rather than by whether its current value happens to parse. A value
// recognizer (patterns/*) only ever confirms or disambiguates; it never has to carry the
// classification alone. Pure — the DOM half (which text counts as "associated") lives in
// apps/extension/src/content/detect/field-semantics.ts.

import { normalizeForMatching } from '../normalize';
import type { EntityType } from '../types';

interface FieldLabelRule {
  entity: EntityType;
  re: RegExp;
}

// Order is priority: when two rules match overlapping text, the earlier rule keeps the span
// ("credit card expiry" is CARD_EXPIRY, not CARD_NUMBER; "one time password" is OTP, not
// PASSWORD; "UPI PIN" is PASSWORD, not UPI_VPA). Non-overlapping matches all survive, in text order,
// which is what gives a combined label like "Email / Mobile" both of its entities.
//
// Latin rules run on lowercased, NFKC-normalised text. Devanagari has no `\b` in JS regex (its
// letters are not `\w`), so those terms are plain substrings.
const FIELD_LABEL_RULES: readonly FieldLabelRule[] = [
  { entity: 'OTP', re: /\botp\b|one[\s-]*time[\s-]*(?:pass\s*word|pass\s*code|code|pin)|verification\s*code|\bpass\s*code\b|ओटीपी/g },
  { entity: 'CARD_CVV', re: /\bcvv2?\b|\bcvc2?\b|\bcsc\b|card\s*(?:verification|security)\s*(?:code|value|number)/g },
  { entity: 'CARD_EXPIRY', re: /card\s*expir\w*|expir\w*\s*(?:date\s*)?\(?\s*mm\s*\/\s*yy|valid\s*(?:thru|through)|\bmm\s*\/\s*yy\b/g },
  { entity: 'PASSWORD', re: /\bpass\s*word\b|\bpasswd\b|\bpwd\b|\bm-?pin\b|\bt-?pin\b|(?:security|login|atm|upi|transaction)\s*pin\b|पासवर्ड/g },
  { entity: 'SECRET', re: /api[\s-]*key|\bsecret\b|access\s*token|client\s*secret/g },
  { entity: 'AADHAAR', re: /\baa?dh?aa?r\b(?:\s*card)?(?:\s*(?:no\.?|number|num))?|\buidai\b|\buid\b|virtual\s*id\b|आधार/g },
  { entity: 'PAN', re: /\bpan\b(?:\s*card)?(?:\s*(?:no\.?|number|num))?|permanent\s*account\s*number/g },
  {
    entity: 'CARD_NUMBER',
    re: /(?<!(?:aa?dh?aa?r|pan|ration|voter|election|id|identity|health|abha|member(?:ship)?|loyalty|gift|library)\s*)\bcard\s*(?:no\.?|number|num|#)|(?:credit|debit|atm)\s*card|\bcc\s*(?:no|number|num)\b/g,
  },
  { entity: 'GSTIN', re: /\bgstin\b|\bgst\s*(?:no\.?|number|in)\b/g },
  { entity: 'IFSC', re: /\bifsc\b/g },
  { entity: 'BANK_ACCOUNT', re: /(?<!permanent\s*)\baccount\s*(?:no\.?|number|num|#)|\bacct\b|\ba\/c\b|bank\s*account/g },
  { entity: 'UPI_VPA', re: /\bupi\b(?:\s*(?:id|address|handle))?|\bvpa\b/g },
  { entity: 'PASSPORT', re: /\bpassport\s*(?:no\.?|number|num|#)|^passport$/g },
  { entity: 'VEHICLE_REG', re: /vehicle\s*(?:registration\s*)?(?:no\.?|number|num)/g },
  { entity: 'DOB', re: /\bdob\b|\bd\.o\.b\b|date\s*of\s*birth|birth\s*date|\bbirthday\b|\bbday\b|जन्म\s*तिथि/g },
  { entity: 'EMAIL', re: /\be-?mail(?:\s*(?:id|address))?|\bmail\s*id\b|ईमेल/g },
  {
    entity: 'PHONE',
    re: /\bmobile(?:\s*(?:no\.?|number|num|#))?|\bphone(?:\s*(?:no\.?|number|num|#))?\b|\btelephone\b|\btel\b|\bcell(?:ular)?\s*(?:no\.?|number)|\bcontact\s*(?:no\.?|number|num)|\bwhats\s*app\b|मोबाइल|फ़ोन|फोन/g,
  },
  { entity: 'USERNAME', re: /\buser\s*(?:name|id)\b|\buserid\b|\buname\b|\blog\s*in\s*(?:id|name)\b|\bsign[\s-]*in\s*id\b/g },
  { entity: 'PIN_CODE', re: /\bpin\s*code\b|\bpincode\b|postal\s*code|\bpost\s*code\b|\bzip(?:\s*code)?\b/g },
  { entity: 'ADDRESS', re: /(?<!(?:e-?mail|ip|mac|web|url|wallet|website)\s*)\baddress\b|\bstreet\b|house\s*(?:no\.?|number)|\blocality\b|\blandmark\b|पता/g },
  {
    entity: 'PERSON_NAME',
    re: /\b(?:full|first|last|middle|given|family|legal|applicant'?s?|patient'?s?|candidate'?s?|father'?s?|mother'?s?|spouse'?s?|husband'?s?|guardian'?s?|holder'?s?|your)\s*name\b|\bsurname\b|\b[fl]name\b|^name\b(?!\s*of\b)|नाम/g,
  },
];

/** Splits identifier-style attribute values into words so the label lexicon applies to them:
 * `txtEmailId` → `txt email id`, `ctl00$Main$mobile_no` → `ctl00 main mobile no`. */
export function identifierToWords(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$.:[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every entity the given field-associated text names, in the order they appear in the text,
 * deduplicated. Overlapping matches keep only the higher-priority rule's entity (see
 * FIELD_LABEL_RULES' order). An empty result means the text names no known sensitive type —
 * it is never a guess.
 */
export function fieldEntitiesFromText(text: string): EntityType[] {
  const normalized = normalizeForMatching(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const accepted: { entity: EntityType; start: number; end: number }[] = [];
  for (const { entity, re } of FIELD_LABEL_RULES) {
    for (const m of normalized.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (accepted.some((a) => a.start < end && start < a.end)) continue;
      accepted.push({ entity, start, end });
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  const out: EntityType[] = [];
  for (const a of accepted) if (!out.includes(a.entity)) out.push(a.entity);
  return out;
}
