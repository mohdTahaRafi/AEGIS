// design.md §12.1 — the harness-facing export shape. `LedgerEntry` is already JSON-safe (it's
// built entirely from `SanitizedContext` plus plain numbers/strings), so this is a thin,
// intentionally boring pass-through rather than a second serialization format to keep in sync.

import type { Ledger, LedgerEntry } from './ledger';

export interface LedgerExport {
  schema: 'AEGIS_LEDGER/1';
  entries: LedgerEntry[];
}

export function exportLedger(ledger: Ledger): LedgerExport {
  return { schema: 'AEGIS_LEDGER/1', entries: ledger.export() };
}
