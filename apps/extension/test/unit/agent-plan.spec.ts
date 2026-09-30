import { describe, expect, it } from 'vitest';
import { AgentSession, PlanError, normalizePlan, validateCandidatePlan } from '../../src/host/agent/plan';
import { fakeNode, fakeStep, withImage } from './agent-fixtures';

function sessionFor(step = fakeStep()): AgentSession {
  const s = new AgentSession('sid', 'm');
  s.applyStep(step);
  return s;
}

describe('normalizePlan', () => {
  it('accepts a bare action list or a single action', () => {
    expect(normalizePlan([{ op: 'wait', ms: 100 }], 's-3').actions).toHaveLength(1);
    expect(normalizePlan({ op: 'go_back' }, 's-3').actions).toEqual([{ op: 'go_back' }]);
  });

  it('adds the ids the server used to add, and wraps a bare ref in the placeholder marks', () => {
    const plan = normalizePlan({ actions: [{ op: 'type', node: 'e1', ref: 'AADHAAR#2' }], junk: 1 }, 's-7');
    expect(plan.step_id).toBe('s-7');
    expect(plan.plan_id).toBe('p-7');
    expect(plan.actions[0]!.ref).toBe('⟪AADHAAR#2⟫');
    expect(plan).not.toHaveProperty('junk');
  });

  it('keeps a free-text stop reason as the detail instead of failing the plan', () => {
    const plan = normalizePlan({ actions: [{ op: 'stop', reason: 'no username given' }] }, 's-1');
    expect(plan.actions[0]).toEqual({ op: 'stop', reason: 'cannot_proceed', detail: 'no username given' });
  });

  it('rejects an answer that is not a plan', () => {
    expect(() => normalizePlan('click the button', 's-1')).toThrow(PlanError);
    expect(() => normalizePlan({ actions: 'x' }, 's-1')).toThrow(/actions/);
  });
});

describe('validateCandidatePlan', () => {
  it('resolves aliases and returns a plan the wire schema accepts', () => {
    const step = fakeStep();
    const plan = validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', text: 'asha' }, { op: 'click', node: 'e2' }, { op: 'done', summary: 'ok' }] }, sessionFor(step), step);
    expect(plan.actions.map((a) => a.node)).toEqual(['n-user', 'n-go', undefined]);
  });

  it('rejects an op outside the schema', () => {
    const step = fakeStep();
    expect(() => validateCandidatePlan({ actions: [{ op: 'format_disk' }] }, sessionFor(step), step)).toThrow(/schema/);
  });

  it('rejects an element that was never shown, and asks for the page on the retry', () => {
    const step = fakeStep();
    try {
      validateCandidatePlan({ actions: [{ op: 'click', node: 'n-zzz' }] }, sessionFor(step), step);
      expect.unreachable();
    } catch (err) {
      expect((err as PlanError).needsPage).toBe(true);
    }
  });

  it('rejects a ref that was never sent, and a ref typed into a node that cannot take text', () => {
    const step = fakeStep({ redactions: [{ ref: '⟪EMAIL#1⟫', entity: 'EMAIL', class: 'HIGH', boxes: [], method: 'placeholder', confidence: 1, sources: [], unverified: false }] });
    const session = sessionFor(step);
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', ref: 'EMAIL#9' }] }, session, step)).toThrow(/was not sent/);
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e2', ref: 'EMAIL#1' }] }, session, step)).toThrow(/'type' affordance/);
    expect(validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', ref: 'EMAIL#1' }] }, session, step).actions).toHaveLength(1);
  });

  it('reads the prompt\'s stand-in ENTITY#n as the one ref carrying that number, and never guesses otherwise', () => {
    const redaction = (ref: string, entity: string) => ({ ref, entity, class: 'HIGH', boxes: [], method: 'placeholder', confidence: 1, sources: [], unverified: false });
    const step = fakeStep({ redactions: [redaction('⟪PHONE#3⟫', 'PHONE'), redaction('⟪USERNAME#5⟫', 'USERNAME')] as never });
    const session = sessionFor(step);
    const plan = validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', ref: 'ENTITY#5' }] }, session, step);
    expect(plan.actions[0]!.ref).toBe('⟪USERNAME#5⟫');
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', ref: 'ENTITY#9' }] }, session, step)).toThrow(/was not sent/);
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', ref: 'PHONE#5' }] }, session, step)).toThrow(/was not sent/);
  });

  it('never lets literal text carry a placeholder', () => {
    const step = fakeStep();
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', text: 'my ⟪EMAIL#1⟫' }] }, sessionFor(step), step)).toThrow(/placeholder/);
  });

  it('refuses to type the same text again into a field that still holds it', () => {
    const first = fakeStep();
    const session = sessionFor(first);
    session.recordTyped(validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', text: 'hello' }] }, session, first));
    const next = fakeStep({ step_id: 's-2', delta_of: 's-1', nodes: [fakeNode('n-user', { role: 'textbox', affordances: ['type'], state: { has_value: true } })] });
    session.applyStep(next);
    expect(() => validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', text: ' hello ' }] }, session, next)).toThrow(/already typed/);
    expect(validateCandidatePlan({ actions: [{ op: 'type', node: 'e1', text: 'different' }] }, session, next).actions).toHaveLength(1);
  });

  it('converts click_point from 0-1000 of the image\'s long side into viewport pixels, and checks it is inside the image', () => {
    const step = withImage(fakeStep());
    const session = sessionFor(step);
    const plan = validateCandidatePlan({ actions: [{ op: 'click_point', x: 500, y: 250, label: 'logo' }] }, session, step);
    expect(plan.actions[0]).toMatchObject({ x: 640, y: 320 });
    expect(() => validateCandidatePlan({ actions: [{ op: 'click_point', x: 500, y: 900, label: 'off' }] }, session, step)).toThrow(/image region/);
  });

  it('forgets nodes a full snapshot no longer contains', () => {
    const session = sessionFor(fakeStep());
    session.applyStep(fakeStep({ step_id: 's-2', nodes: [fakeNode('n-new')] }));
    expect([...session.sentNodeIds]).toEqual(['n-new']);
  });
});
