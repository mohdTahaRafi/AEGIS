import { describe, expect, it } from 'vitest';
import { BudgetTracker, DEFAULT_BUDGETS } from '../../src/host/controller/budgets';

describe('BudgetTracker (design.md §10.2 / phase_2_spine.md §4.2 AC)', () => {
  it('trips STEPS_EXCEEDED after stepsPerTask steps, with a distinct reason code', () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGETS, stepsPerTask: 2 });
    expect(tracker.beginStep()).toBeNull();
    expect(tracker.beginStep()).toBeNull();
    expect(tracker.beginStep()).toBe('STEPS_EXCEEDED');
  });

  it('trips SERVER_CALLS_EXCEEDED within a single step, and resets on the next step', () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGETS, serverCallsPerStep: 2 });
    tracker.beginStep();
    expect(tracker.recordServerCall()).toBeNull();
    expect(tracker.recordServerCall()).toBeNull();
    expect(tracker.recordServerCall()).toBe('SERVER_CALLS_EXCEEDED');

    tracker.beginStep(); // next step resets the counter
    expect(tracker.recordServerCall()).toBeNull();
  });

  it('trips REPAIRS_EXCEEDED per action, independent of the step counters', () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGETS, localRepairsPerAction: 2 });
    tracker.beginAction();
    expect(tracker.recordRepair()).toBeNull();
    expect(tracker.recordRepair()).toBeNull();
    expect(tracker.recordRepair()).toBe('REPAIRS_EXCEEDED');

    tracker.beginAction(); // next action resets the counter
    expect(tracker.recordRepair()).toBeNull();
  });

  it('trips CAPTURES_EXCEEDED per step (Phase 4 forward dependency, tracked now)', () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGETS, capturesPerStep: 1 });
    tracker.beginStep();
    expect(tracker.recordCapture()).toBeNull();
    expect(tracker.recordCapture()).toBe('CAPTURES_EXCEEDED');
  });

  it('trips WALL_CLOCK_EXCEEDED once the task has run past its budget', () => {
    let now = 0;
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGETS, taskWallClockMs: 1000 }, () => now);
    tracker.startTask();
    expect(tracker.checkWallClock()).toBeNull();
    now = 1500;
    expect(tracker.checkWallClock()).toBe('WALL_CLOCK_EXCEEDED');
  });

  it('reports no wall-clock breach before the task has started', () => {
    const tracker = new BudgetTracker();
    expect(tracker.checkWallClock()).toBeNull();
  });
});
