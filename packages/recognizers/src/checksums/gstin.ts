// design.md §6.2 — GSTIN check-character algorithm (a mod-36 checksum over the first 14 of the
// 15-character GSTIN, matching the algorithm GSTN's own portal uses to validate the 15th
// character). T-3.1.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MOD = 36;

/** `gstin` must be exactly 15 uppercase alphanumeric characters. Validates the 15th (check)
 * character against the first 14. */
export function gstinValidate(gstin: string): boolean {
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return false;
  const body = gstin.slice(0, 14);
  const expected = gstinCheckChar(body);
  return expected === gstin[14];
}

export function gstinCheckChar(body14: string): string | undefined {
  if (body14.length !== 14) return undefined;
  let factor = 2;
  let sum = 0;
  for (let i = body14.length - 1; i >= 0; i -= 1) {
    const codePoint = ALPHABET.indexOf(body14[i]!);
    if (codePoint === -1) return undefined;
    let digit = factor * codePoint;
    digit = Math.floor(digit / MOD) + (digit % MOD);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }
  const checksumDigit = (MOD - (sum % MOD)) % MOD;
  return ALPHABET[checksumDigit];
}
