// design.md §10.2 / phase_2_spine.md §4.2 (T-2.18) — every budget is a *stop* condition, never a
// *degrade* condition (FR-9): the agent must stop with an explanation rather than carry on
// guessing. Each check below returns a distinct `BudgetReasonCode` on breach, `null` otherwise, so
// the controller can log and surface exactly which budget tripped.

import type { BudgetReasonCode } from '../../shared/errors';

export interface BudgetLimits {
  stepsPerTask: number;
  serverCallsPerStep: number;
  taskWallClockMs: number;
}

export const DEFAULT_BUDGETS: BudgetLimits = {
  stepsPerTask: 50,
  serverCallsPerStep: 4,
  taskWallClockMs: 20 * 60_000,
};

export class BudgetTracker {
  private steps = 0;
  private serverCallsThisStep = 0;
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

  /** Call once per new step. Also resets the per-step server-call counter. */
  beginStep(): BudgetReasonCode | null {
    this.steps += 1;
    this.serverCallsThisStep = 0;
    return this.steps > this.limits.stepsPerTask ? 'STEPS_EXCEEDED' : null;
  }

  recordServerCall(): BudgetReasonCode | null {
    this.serverCallsThisStep += 1;
    return this.serverCallsThisStep > this.limits.serverCallsPerStep ? 'SERVER_CALLS_EXCEEDED' : null;
  }
}
