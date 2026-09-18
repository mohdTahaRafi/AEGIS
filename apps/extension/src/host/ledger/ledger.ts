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
  /** phase_4_vision.md T-4.19/T-4.23 — absent on a step that never captured a frame (the common
   * L0 case); present whenever the perception worker actually ran this step, so AC-3's "latency
   * reported for both paths" and the panel's resource bar have real per-step backend/model data
   * rather than a single session-wide guess. */
  perception?: { backend: 'webgpu' | 'wasm'; modelsLoadedMB: number; screenLabel?: { label: string; score: number } };
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
