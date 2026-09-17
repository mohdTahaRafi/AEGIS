// design.md §6.2 — Verhoeff checksum, used to separate real Aadhaar numbers (T-3.1, AC-11) from
// digit strings that merely happen to be 12 digits long (order numbers, tracking ids).
// Reference tables: Verhoeff (1969), as reproduced in UIDAI's public Aadhaar-checksum literature.

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** `digits` must be exactly the digit string to validate, check digit included, most significant
 * digit first — the caller (the Aadhaar recognizer) is responsible for normalisation first. */
export function verhoeffValidate(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    c = D[c]![P[i % 8]![digit]!]!;
  }
  return c === 0;
}

/** Computes the Verhoeff check digit for a digit string that does NOT yet include one — used only
 * by tests to generate valid fixtures, never by the recognizer itself (which only validates). */
export function verhoeffGenerate(digitsWithoutCheck: string): string {
  let c = 0;
  const reversed = digitsWithoutCheck.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    c = D[c]![P[(i + 1) % 8]![digit]!]!;
  }
  return String(INV[c]);
}
