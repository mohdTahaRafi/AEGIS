// design.md §6.2 — Luhn checksum, separates real card numbers from order/tracking numbers of the
// same digit length (T-3.1, AC-11).

export function luhnValidate(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// design.md §6.2 — card-number recognizer's IIN prefix ranges (Visa/Mastercard/Amex/Discover/
// Diners/RuPay/Maestro), used alongside Luhn so a Luhn-valid-but-wrong-length string doesn't
// falsely pass as a card number.
const IIN_RANGES: ReadonlyArray<{ prefix: RegExp; lengths: number[] }> = [
  { prefix: /^4/, lengths: [13, 16, 19] }, // Visa
  { prefix: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] }, // Mastercard
  { prefix: /^3[47]/, lengths: [15] }, // American Express
  { prefix: /^6(011|5)/, lengths: [16] }, // Discover
  { prefix: /^3(0[0-5]|[68])/, lengths: [14] }, // Diners Club
  { prefix: /^60|^65|^81|^82|^508/, lengths: [16] }, // RuPay (approximate ranges)
  { prefix: /^(5018|5020|5038|5893|6304|6759|676[1-3])/, lengths: [16, 19] }, // Maestro
];

export function matchesIinRange(digits: string): boolean {
  return IIN_RANGES.some((r) => r.prefix.test(digits) && r.lengths.includes(digits.length));
}
