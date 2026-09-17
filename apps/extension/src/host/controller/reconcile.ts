// design.md §10.1's RECONCILING state / phase_2_spine.md §4.2 (T-2.24) — bounded reconciliation.
// A rejected action isn't necessarily a dead end: geometry drift can be fixed locally (re-resolve,
// re-check, retry, still inside the current step's local action-execution loop, no server round
// trip), but a genuine semantic change needs the server to see the new page and re-plan. Both
// paths are bounded, independently, so a page that never stabilises cannot spin a task forever.

export type ReconciliationDecision = { action: 'repair' } | { action: 'reobserve' } | { action: 'stop'; reason: 'BUDGET_EXHAUSTED' };

export class ReconciliationTracker {
  private repairsThisAction = 0;
  private reobservationsThisStep = 0;

  constructor(
    private readonly maxRepairsPerAction = 2,
    private readonly maxReobservationsPerStep = 3,
  ) {}

  resetForNewAction(): void {
    this.repairsThisAction = 0;
  }

  resetForNewStep(): void {
    this.reobservationsThisStep = 0;
  }

  /**
   * `repairable` is the caller's own judgement (design.md §5.2): geometry drift with a passing
   * hit test is repairable; a role/name mismatch or a failed hit test is not — no amount of local
   * retrying fixes an element that has genuinely become the wrong thing to click.
   */
  decide(repairable: boolean): ReconciliationDecision {
    if (repairable && this.repairsThisAction < this.maxRepairsPerAction) {
      this.repairsThisAction += 1;
      return { action: 'repair' };
    }
    if (this.reobservationsThisStep < this.maxReobservationsPerStep) {
      this.reobservationsThisStep += 1;
      return { action: 'reobserve' };
    }
    return { action: 'stop', reason: 'BUDGET_EXHAUSTED' };
  }
}
