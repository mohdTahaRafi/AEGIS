import { describe, expect, it } from 'vitest';
import { applyActivityEvent, type ActivityEntry } from '../../src/ui/ActivityLog';

describe('activity log', () => {
  it('moves each operation from validated to its execution result', () => {
    let log: ActivityEntry[] = [];
    log = applyActivityEvent(log, { type: 'plan', stepId: 's-1', actions: ['type ⟪USERNAME#2⟫ → "Username"', 'click → "Sign in"', 'done'] });
    log = applyActivityEvent(log, { type: 'action_status', stepId: 's-1', index: 0, status: 'executed' });
    log = applyActivityEvent(log, { type: 'action_status', stepId: 's-1', index: 1, status: 'failed', reason: 'FAILED_HIT_TEST_FAILED' });
    const plan = log[0] as Extract<ActivityEntry, { kind: 'plan' }>;
    expect(plan.actions.map((a) => a.status)).toEqual(['executed', 'failed', 'validated']);
    expect(plan.actions[1]!.reason).toBe('FAILED_HIT_TEST_FAILED');
    log = applyActivityEvent(log, { type: 'plan_rejected', stepId: 's-2', reason: 'SCHEMA_INVALID' });
    expect(log[1]).toEqual({ kind: 'rejected', stepId: 's-2', reason: 'SCHEMA_INVALID' });
  });
});
