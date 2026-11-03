import { describe, expect, it } from 'vitest';
import { createAgentEngine } from '../../src/host/agent/engine';
import { SYSTEM_PROMPTS, buildUserMessage } from '../../src/host/agent/prompt';
import { detectSituations } from '../../src/host/agent/situations';
import { brand } from '../../src/host/egress/brand';
import { fakeNode, fakeStep } from './agent-fixtures';

const ids = (step: Parameters<typeof detectSituations>[0], profile: 'compact' | 'rich' = 'rich') => detectSituations(step, profile).map((s) => s.id);
const run = (text: string) => ({ id: 't-1', text, box: [10, 10, 200, 20] as [number, number, number, number] });

const CODEFORCES_TASK = 'go to codeforces and solve one question there in c++, make sure the verdict is ACCEPTED';
const AFTER_SUBMIT = { step_id: 's-8', page: 'Problem - 2278A', actions: [{ op: 'click', name: 'Submit' }], outcome: 'acted; page navigated' };

describe('situation rules (the prompt follows what the step is about)', () => {
  it('a routine sign-in step carries no situation rules', () => {
    expect(ids(fakeStep())).toEqual([]);
    expect(buildUserMessage(fakeStep())).not.toContain('SITUATION');
  });

  it('a wrong answer after submitting code: fix it yourself, write it yourself, code rules', () => {
    const step = fakeStep({ task: CODEFORCES_TASK, text: [run('Wrong answer on test 1')], history: [AFTER_SUBMIT] });
    expect(ids(step)).toEqual(['failed_result', 'produce', 'code']);
    const text = buildUserMessage(step, { profile: 'rich' });
    expect(text).toContain('SITUATION (rules for this step):');
    expect(text).toContain('Never ask the user to fix it');
    expect(text).toContain('ask_user is never for content you can produce');
    expect(text).toContain('file-upload field cannot be filled');
  });

  it('a failure verdict before AEGIS has done anything is not its own work', () => {
    expect(ids(fakeStep({ task: 'open the status page', text: [run('Wrong answer on test 3')] }))).not.toContain('failed_result');
  });

  it('two steps in a row that went nowhere are flagged as stuck', () => {
    const history = [
      { step_id: 's-1', actions: [{ op: 'click' }], outcome: 'acted; no visible change on the page' },
      { step_id: 's-2', actions: [{ op: 'click' }], outcome: 'acted; no visible change on the page' },
    ];
    expect(ids(fakeStep({ history }))).toContain('stuck');
    expect(ids(fakeStep({ history: history.slice(1) }))).not.toContain('stuck');
  });

  it('shopping: lasting actions from the task or from a button on the page, and comparing across sites', () => {
    expect(ids(fakeStep({ task: 'find the cheapest 1 TB SSD and compare 3 shops' }))).toEqual(['compare', 'answer']);
    expect(ids(fakeStep({ task: 'open the product', nodes: [fakeNode('n-add', { name: 'Add to Cart' })] }))).toEqual(['lasting']);
  });

  it('a question gets the report rule', () => {
    expect(ids(fakeStep({ task: 'What is the population of India?' }))).toEqual(['answer']);
  });

  it('the compact profile carries at most two rules, most pressing first', () => {
    const step = fakeStep({ task: CODEFORCES_TASK, text: [run('Compilation error')], history: [AFTER_SUBMIT] });
    expect(ids(step, 'compact')).toEqual(['failed_result', 'produce']);
  });

  it('the system prompt no longer carries the rules that moved into situations', () => {
    for (const prompt of Object.values(SYSTEM_PROMPTS)) {
      expect(prompt).not.toContain('at least 3 different sites');
      expect(prompt).not.toContain('"DONE: <what, where, price>"');
      expect(prompt).toContain('Never ask for what you can work out, write');
      expect(prompt).toContain('SITUATION');
    }
  });

  it('a failed result is handled by the smart model, and the run log is told which rules applied', async () => {
    const tiers: (string | undefined)[] = [];
    const commentary: unknown[] = [];
    const engine = createAgentEngine(
      {
        complete: async (_messages, _signal, tier) => {
          tiers.push(tier);
          return { actions: [{ op: 'click', node: 'e1' }] };
        },
      },
      'm',
      { profile: 'rich', grounding: 'image-px' },
      (c) => commentary.push(c),
    );
    const session = engine.openSession().session_id;
    await engine.sendStep(session, brand(fakeStep({ task: 'open the page' })));
    await engine.sendStep(session, brand(fakeStep({ step_id: 's-2', task: 'open the page', history: [{ step_id: 's-1', actions: [{ op: 'click' }], outcome: 'acted' }] })));
    await engine.sendStep(session, brand(fakeStep({ step_id: 's-3', task: CODEFORCES_TASK, text: [run('Wrong answer on test 1')], history: [AFTER_SUBMIT] })));
    expect(tiers).toEqual(['smart', 'fast', 'smart']);
    expect(commentary.at(-1)).toMatchObject({ situations: ['failed_result', 'produce', 'code'] });
    expect(commentary[0]).not.toHaveProperty('situations', expect.anything());
  });
});
