import { verhoeffGenerate } from '@aegis/recognizers';
import { describe, expect, it, vi } from 'vitest';
import { createAgentEngine } from '../../src/host/agent/engine';
import { ModelRequestTooLarge, StepFailedError } from '../../src/host/agent/errors';
import { PlanError } from '../../src/host/agent/plan';
import type { ChatMessage } from '../../src/host/agent/prompt';
import { fakeNode, fakeStep, withImage } from './agent-fixtures';

type Answer = unknown | Error;

function engineWith(answers: Answer[]) {
  const calls: ChatMessage[][] = [];
  const source = {
    complete: vi.fn(async (messages: readonly ChatMessage[]) => {
      calls.push([...messages]);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const engine = createAgentEngine(source, 'test-model');
  const { session_id } = engine.openSession();
  return { engine, source, calls, sid: session_id };
}

const rejected = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as StepFailedError;
  }
  throw new Error('expected a rejection');
};

describe('agent engine', () => {
  it('opens a session that reports the model and its limits', () => {
    const session = createAgentEngine({ complete: async () => ({}) }, 'm').openSession();
    expect(session).toMatchObject({ model: 'm', mode: 'live', limits: { max_steps: 30 } });
    expect(session.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns the model\'s alias-based answer into a valid plan for this step', async () => {
    const { engine, sid, calls } = engineWith([{ actions: [{ op: 'click', node: 'e2' }] }]);
    const plan = await engine.sendStep(sid, withImage(fakeStep()));
    expect(plan).toMatchObject({ step_id: 's-1', plan_id: 'p-1', actions: [{ op: 'click', node: 'n-go' }] });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain('data:image/webp;base64');
  });

  it('refuses a step that still carries a raw identifier, and sends nothing to the model', async () => {
    const body = '23456789012';
    const { engine, sid, source } = engineWith([]);
    const err = await rejected(engine.sendStep(sid, fakeStep({ task: `my id is ${body}${verhoeffGenerate(body)}` })));
    expect([err.status, err.detail, err.retryable]).toEqual([422, 'UNSANITIZED_CONTEXT AADHAAR', false]);
    expect(source.complete).not.toHaveBeenCalled();
    expect(err.detail).not.toContain(body);
  });

  it('enforces step order, and lets the same step be sent again after a failed model call', async () => {
    const { engine, sid } = engineWith([new StepFailedError(503, 'MODEL_UNAVAILABLE upstream_5xx', true), { actions: [{ op: 'wait', ms: 100 }] }]);
    expect((await rejected(engine.sendStep(sid, fakeStep()))).status).toBe(503);
    await expect(engine.sendStep(sid, fakeStep())).resolves.toBeTruthy(); // the lease was released
    expect((await rejected(engine.sendStep(sid, fakeStep()))).status).toBe(409);
  });

  it('answers 404 for a session it does not have', async () => {
    const { engine } = engineWith([]);
    expect((await rejected(engine.sendStep('nope', fakeStep()))).status).toBe(404);
    const { engine: e2, sid } = engineWith([]);
    e2.closeSession(sid);
    expect((await rejected(e2.sendStep(sid, fakeStep()))).status).toBe(404);
  });

  it('gives an invalid answer one corrective retry, quoting what the model wrote and no screenshot', async () => {
    const bad = { actions: [{ op: 'click', node: 'n-nope' }] };
    const { engine, sid, calls } = engineWith([bad, { actions: [{ op: 'click', node: 'e2' }] }]);
    const plan = await engine.sendStep(sid, withImage(fakeStep()));
    expect(plan.actions[0]).toMatchObject({ node: 'n-go' });
    const retry = calls[1]!;
    expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(retry[2]!.content).toBe(JSON.stringify(bad));
    expect(retry[3]!.content).toContain('previous output was invalid');
    expect(JSON.stringify(retry)).not.toContain('image_url');
    expect(retry[1]!.content).toContain('ELEMENTS:'); // a wrong element also gets the page as text
  });

  it('a malformed shape gets only the task on retry, and two bad answers end as PLAN_INVALID', async () => {
    const { engine, sid, calls } = engineWith([{ nothing: true }, { still: 'bad' }]);
    const err = await rejected(engine.sendStep(sid, fakeStep()));
    expect([err.status, err.retryable]).toEqual([422, false]);
    expect(err.detail).toMatch(/^PLAN_INVALID \(.*actions/);
    expect(calls[1]![1]!.content).toBe('TASK: sign in');
  });

  it('rebuilds a too-large prompt smaller (at most twice) instead of failing the step', async () => {
    const nodes = Array.from({ length: 60 }, (_, i) => fakeNode(`n-${i}`, { name: `Button ${i}`, box: [10, 10 + i * 5, 80, 20] }));
    const { engine, sid, calls } = engineWith([new ModelRequestTooLarge(7000, 9000), { actions: [{ op: 'wait', ms: 100 }] }]);
    await engine.sendStep(sid, fakeStep({ nodes }));
    const listed = (m: ChatMessage[]) => String(m[1]!.content).split('\n').filter((l) => /^e\d+ \|/.test(l)).length;
    expect(listed(calls[1]!)).toBeLessThan(listed(calls[0]!));
  });

  it('gives up on a prompt that stays too large', async () => {
    const big = () => new ModelRequestTooLarge(7000, 9000);
    const { engine, sid, source } = engineWith([big(), big(), big()]);
    expect((await rejected(engine.sendStep(sid, fakeStep()))).detail).toContain('upstream_too_large');
    expect(source.complete).toHaveBeenCalledTimes(3);
  });

  it('does not let a plan re-type text a field already holds', async () => {
    const typed = { actions: [{ op: 'type', node: 'e1', text: 'asha' }] };
    const { engine, sid } = engineWith([typed, typed, typed]);
    await engine.sendStep(sid, fakeStep());
    const filled = fakeStep({ step_id: 's-2', delta_of: 's-1', nodes: [fakeNode('n-user', { role: 'textbox', affordances: ['type'], state: { has_value: true } })] });
    expect((await rejected(engine.sendStep(sid, filled))).detail).toMatch(/^PLAN_INVALID \(this exact text was already typed/);
  });

  it('propagates a plan error the model client raised (unparseable answer) into the same retry', async () => {
    const { engine, sid } = engineWith([new PlanError('model response was not valid JSON'), { actions: [{ op: 'wait', ms: 100 }] }]);
    await expect(engine.sendStep(sid, fakeStep())).resolves.toMatchObject({ actions: [{ op: 'wait' }] });
  });
});
