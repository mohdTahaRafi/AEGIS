// design.md §12.1's ledger (T-3.27) — per-session, in-memory record of every payload as sent,
// plus timings, entity counts, coverage, guard verdict and versions. Never uploaded (FR-34).

import type { SanitizedContext } from '@aegis/protocol';
import type { StepStageTimings } from '../session';

export type GuardVerdict = { ok: true } | { ok: false; rule: string; entity?: string };

export interface LedgerEntry {
  stepId: string;
  payload: SanitizedContext;
  timings: StepStageTimings;
  guardVerdict: GuardVerdict;
  policyVersion: string;
  entityCountsByClass: Record<string, number>;
  entityCountsByChannel: Record<string, number>;
  coverage: SanitizedContext['coverage'];
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  latest(): LedgerEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** Exportable for the harness (Phase 1's runner has been collecting an empty one until now) —
   * never uploaded, only ever returned to a caller that already has this data in-process. */
  export(): LedgerEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
