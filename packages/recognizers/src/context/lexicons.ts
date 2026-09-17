// design.md §6.1/§6.2 — label/name/autocomplete lexicons that drive context boosts. Plain word
// lists, deliberately not clever (no stemming/fuzzy match) so a boost is always explainable.

export const AADHAAR_LEXICON = ['aadhaar', 'aadhar', 'uid', 'uidai'];
export const PAN_LEXICON = ['pan', 'permanent account number'];
export const PASSPORT_LEXICON = ['passport'];
export const DOB_LEXICON = ['dob', 'date of birth', 'birthdate', 'birth date'];
export const ADDRESS_LEXICON = ['address', 'street', 'pincode', 'pin code', 'postal code', 'zip'];
export const BANK_ACCOUNT_LEXICON = ['account number', 'acct', 'bank account', 'ifsc'];
export const KYC_PAYMENT_LEXICON = [
  ...AADHAAR_LEXICON,
  ...PAN_LEXICON,
  'kyc',
  'ifsc',
  'upi',
  'gstin',
  'card number',
  'cvv',
  'expiry',
  'payment',
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export function matchesLexicon(text: string, lexicon: readonly string[]): boolean {
  return containsAny(text, lexicon);
}
