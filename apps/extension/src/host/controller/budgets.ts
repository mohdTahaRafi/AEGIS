// design.md §10.2 / phase_2_spine.md §4.2 (T-2.18) — every budget is a *stop* condition, never a
// *degrade* condition (FR-9): the agent must stop with an explanation rather than carry on
// guessing. Each check below returns a distinct `BudgetReasonCode` on breach, `null` otherwise, so
// the controller can log and surface exactly which budget tripped.

import type { BudgetReasonCode } from '../../shared/errors';

export interface BudgetLimits {
  stepsPerTask: number;
  serverCallsPerStep: number;
  localRepairsPerAction: number;
  capturesPerStep: number;
  settleTimeoutMs: number;
  serverResponseTimeoutMs: number;
  taskWallClockMs: number;
}

export const DEFAULT_BUDGETS: BudgetLimits = {
  stepsPerTask: 30,
  serverCallsPerStep: 4,
  localRepairsPerAction: 2,
  capturesPerStep: 3, // Phase 4 — no capture path exists yet, tracked for when it does
  settleTimeoutMs: 1500,
  serverResponseTimeoutMs: 20_000,
  taskWallClockMs: 10 * 60_000,
};

export class BudgetTracker {
  private steps = 0;
  private serverCallsThisStep = 0;
  private capturesThisStep = 0;
  private repairsThisAction = 0;
  private taskStartedAt: number | null = null;

  constructor(
    private readonly limits: BudgetLimits = DEFAULT_BUDGETS,
    private readonly now: () => number = Date.now,
  ) {}

  startTask(): void {
    this.taskStartedAt = this.now();
  }

  checkWallClock(): BudgetReasonCode | null {
    if (this.taskStartedAt === null) return null;
    return this.now() - this.taskStartedAt > this.limits.taskWallClockMs ? 'WALL_CLOCK_EXCEEDED' : null;
  }

  /** Call once per new step. Also resets the per-step counters (server calls, captures). */
  beginStep(): BudgetReasonCode | null {
    this.steps += 1;
    this.serverCallsThisStep = 0;
    this.capturesThisStep = 0;
    return this.steps > this.limits.stepsPerTask ? 'STEPS_EXCEEDED' : null;
  }

  recordServerCall(): BudgetReasonCode | null {
    this.serverCallsThisStep += 1;
    return this.serverCallsThisStep > this.limits.serverCallsPerStep ? 'SERVER_CALLS_EXCEEDED' : null;
  }

  recordCapture(): BudgetReasonCode | null {
    this.capturesThisStep += 1;
    return this.capturesThisStep > this.limits.capturesPerStep ? 'CAPTURES_EXCEEDED' : null;
  }

  /** Call once per new action, before its first pre-flight attempt. */
  beginAction(): void {
    this.repairsThisAction = 0;
  }

  recordRepair(): BudgetReasonCode | null {
    this.repairsThisAction += 1;
    return this.repairsThisAction > this.limits.localRepairsPerAction ? 'REPAIRS_EXCEEDED' : null;
  }
}
