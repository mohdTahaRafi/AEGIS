// design.md §3.3 — the closed entity enum, mirrored from packages/protocol/schema/common.schema.json's
// `entityType` $def (kept as a literal union here rather than generated, since the protocol
// generator does not currently emit a named export for this $def — see index.ts's roundtrip test,
// which asserts this list stays byte-for-byte in sync with the schema).
export type EntityType =
  | 'PASSWORD'
  | 'OTP'
  | 'CARD_NUMBER'
  | 'CARD_CVV'
  | 'CARD_EXPIRY'
  | 'AADHAAR'
  | 'FACE'
  | 'ID_DOCUMENT'
  | 'SIGNATURE'
  | 'QR_CODE'
  | 'SECRET'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'DOB'
  | 'BANK_ACCOUNT'
  | 'PAN'
  | 'GSTIN'
  | 'IFSC'
  | 'UPI_VPA'
  | 'PASSPORT'
  | 'VEHICLE_REG'
  | 'PERSON_NAME'
  | 'USERNAME'
  | 'PIN_CODE'
  | 'DATE'
  | 'AMOUNT'
  | 'CITY'
  | 'COUNTRY'
  | 'UNKNOWN_SENSITIVE'
  | 'CAPTCHA'
  | 'MEDIA'
  | 'LIVE';

/** design.md §3.2's `Channel` union. */
export type Channel = 'dom' | 'text-dom' | 'text-ocr' | 'ner' | 'vision';

export interface RecognizerContext {
  /** Accessible name / nearby label text for the field or text run this match came from. */
  label?: string;
  /** `name`/`id` attribute, when available. */
  name?: string;
  autocomplete?: string;
}

export interface RecognizerMatch {
  entity: EntityType;
  start: number;
  end: number;
  matchedText: string;
  /** design.md §3.2's `score`, 0..1, already including any context boost. */
  score: number;
  /** e.g. "pattern:aadhaar+verhoeff" (design.md §3.2's `Candidate.source`). */
  source: string;
  /** Whether a checksum/structural validator confirmed the match. Recognizers with no validator
   * (e.g. email) always report `true`. */
  valid: boolean;
}

export interface Recognizer {
  id: string;
  entity: EntityType;
  find(text: string, ctx?: RecognizerContext): RecognizerMatch[];
}
