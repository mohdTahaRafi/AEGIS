# @aegis/recognizers

Pure functions: Aadhaar (Verhoeff), PAN, GSTIN (check character), IFSC, UPI VPA, card numbers
(Luhn + IIN), Indian/international phone, email, passport, vehicle registration, PIN code, DOB,
secrets (design.md §6.2). No DOM, no browser APIs — reused by the evaluation harness's auditor
as the reference to diff against (never a copy of it; that's what makes the leak count honest).

**Empty scaffold — built in Phase 3.** See [docs/TASKS.md](../../docs/TASKS.md) T-3.1…T-3.5.
