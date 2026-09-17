import { describe, expect, it } from 'vitest';
import { ReconciliationTracker } from '../../src/host/controller/reconcile';

describe('ReconciliationTracker (T-2.24 AC)', () => {
  it('allows up to 2 local repairs per action, then falls through to re-observation', () => {
    const tracker = new ReconciliationTracker(2, 3);
    expect(tracker.decide(true)).toEqual({ action: 'repair' });
    expect(tracker.decide(true)).toEqual({ action: 'repair' });
    expect(tracker.decide(true)).toEqual({ action: 'reobserve' }); // 3rd repair attempt: budget spent
  });

  it('a non-repairable failure goes straight to re-observation, never spending the repair budget', () => {
    const tracker = new ReconciliationTracker(2, 3);
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
    expect(tracker.decide(true)).toEqual({ action: 'repair' }); // repair budget still full
  });

  it('allows up to 3 server re-observations per step, then stops with BUDGET_EXHAUSTED', () => {
    const tracker = new ReconciliationTracker(2, 3);
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
    expect(tracker.decide(false)).toEqual({ action: 'stop', reason: 'BUDGET_EXHAUSTED' });
  });

  it('resetForNewAction() restores the repair budget without touching the re-observation budget', () => {
    const tracker = new ReconciliationTracker(1, 3);
    expect(tracker.decide(true)).toEqual({ action: 'repair' });
    expect(tracker.decide(true)).toEqual({ action: 'reobserve' }); // repair budget spent this action
    tracker.resetForNewAction();
    expect(tracker.decide(true)).toEqual({ action: 'repair' }); // fresh action, fresh repair budget
  });

  it('resetForNewStep() restores the re-observation budget', () => {
    const tracker = new ReconciliationTracker(0, 1);
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
    expect(tracker.decide(false)).toEqual({ action: 'stop', reason: 'BUDGET_EXHAUSTED' });
    tracker.resetForNewStep();
    expect(tracker.decide(false)).toEqual({ action: 'reobserve' });
  });
});
