// The run log files every session event under the step it belongs to, in arrival order, and keeps
// the text the server model wrote (report, done summary, stop explanation, question).

import { describe, expect, it } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { applyRunLogEvent, EMPTY_RUN_LOG, type RunLog, type RunLogEvent } from '../../src/ui/RunLog';
import type { PerceptionStepStatus } from '../../src/host/perception-client/run-step';

const status: PerceptionStepStatus = { capture: 'ok', worker: 'ok', level: 'L1', regionsRequested: 1 };
const payload = (stepId: string) => ({ step_id: stepId, redactions: [] }) as unknown as SanitizedContext;
const record = (stepId: string, outcome: 'acted' | 'done') => ({ stepIndex: 0, stepId, stageTimings: { observe: 1, perceive: 2, sanitize: 3, guard: 4, server: 5, validate: 6, act: 7 }, actionsPlanned: 1, outcome });

function fold(events: RunLogEvent[]): RunLog {
  return events.reduce(applyRunLogEvent, EMPTY_RUN_LOG);
}

describe('run log', () => {
  it('puts setup notes before the first step and later notes into the running step', () => {
    const log = fold([
      { type: 'note', text: 'Task "t" on https://example.com' },
      { type: 'note', text: 'Gateway session opened' },
      { type: 'perception', stepId: 's-1', status },
      { type: 'note', text: 'page navigated to https://example.com/next; reconnected' },
    ]);
    expect(log.setup).toEqual(['Task "t" on https://example.com', 'Gateway session opened']);
    expect(log.steps[0]!.pageNotes).toEqual(['page navigated to https://example.com/next; reconnected']);
  });

  it('records a two-step run in order: perception, payload, wait, plan, execution, model text, timings', () => {
    const log = fold([
      { type: 'perception', stepId: 's-1', status },
      { type: 'sanitized_preview', payload: payload('s-1'), protectedFields: [{ entity: 'EMAIL', label: 'Email', sent: 'empty' }] },
      { type: 'plan', stepId: 's-1', actions: ['report'] },
      { type: 'report', content: 'This is a registration form.' },
      { type: 'action_status', stepId: 's-1', index: 0, status: 'executed' },
      { type: 'step', step: record('s-1', 'acted') },
      { type: 'perception', stepId: 's-2', status },
      { type: 'sanitized_preview', payload: payload('s-2') },
      { type: 'waiting', seconds: 57, reason: 'MODEL_UNAVAILABLE upstream_429' },
      { type: 'plan', stepId: 's-2', actions: ['done: Explained the form.'] },
      { type: 'action_status', stepId: 's-2', index: 0, status: 'executed' },
      { type: 'done', summary: 'Explained the form.' },
      { type: 'step', step: record('s-2', 'done') },
    ]);
    const [one, two] = log.steps;
    expect(one!.protectedFields).toHaveLength(1);
    expect(one!.modelTexts).toEqual([{ label: 'Report', text: 'This is a registration form.' }]);
    expect(one!.activity[0]).toMatchObject({ kind: 'plan', actions: [{ text: 'report', status: 'executed' }] });
    expect(one!.record?.outcome).toBe('acted');
    expect(two!.serverNotes).toEqual(['server busy (MODEL_UNAVAILABLE upstream_429): re-sent this step after 57 s']);
    expect(two!.modelTexts).toEqual([{ label: 'Done summary', text: 'Explained the form.' }]);
    expect(log.result).toEqual({ kind: 'done', text: 'Explained the form.' });
  });

  it("keeps the model's stop explanation and a server error on the step, and as the result", () => {
    const stopped = fold([{ type: 'perception', stepId: 's-1', status }, { type: 'stopped', reason: 'MODEL_STOPPED', detail: 'cannot_proceed (No username was given.)' }]);
    expect(stopped.steps[0]!.modelTexts).toEqual([{ label: 'Stopped by the model', text: 'cannot_proceed (No username was given.)' }]);
    expect(stopped.result).toEqual({ kind: 'stopped', text: 'MODEL_STOPPED: cannot_proceed (No username was given.)' });

    const failed = fold([{ type: 'perception', stepId: 's-1', status }, { type: 'stopped', reason: 'SERVER_ERROR', detail: 'MODEL_UNAVAILABLE upstream_429 retry in 38 s' }]);
    expect(failed.steps[0]!.serverNotes).toEqual(['no plan: MODEL_UNAVAILABLE upstream_429 retry in 38 s']);
  });

  it('records a question once (ask_user also emits a report with the same text)', () => {
    const log = fold([
      { type: 'perception', stepId: 's-1', status },
      { type: 'ask_user', question: 'Which office?' },
      { type: 'report', title: 'AEGIS needs your input', content: 'Which office?' },
    ]);
    expect(log.steps[0]!.modelTexts).toEqual([{ label: 'Question for you', text: 'Which office?' }]);
  });

  it('a guard block and page-side notes stay on the step that produced them', () => {
    const log = fold([
      { type: 'perception', stepId: 's-3', status },
      { type: 'confirmation_required', risk: 'high', description: 'submit the form' },
      { type: 'rehydration_rejected', code: 'FIELD_CHANGED' },
      { type: 'guard_blocked', rule: 'VAULT_LEAK' },
    ]);
    expect(log.steps[0]!.guardBlock).toEqual({ rule: 'VAULT_LEAK', entity: undefined });
    expect(log.steps[0]!.pageNotes).toEqual(['asked you to confirm (high risk): submit the form', 'a sealed value was not filled in: FIELD_CHANGED']);
  });
});
