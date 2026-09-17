import { describe, expect, it } from 'vitest';
import { classifyAction, type Action } from '../../src/host/actions/dispatch';

describe('classifyAction (design.md §5.1 step 3)', () => {
  it('routes report/ask_user/done/stop/wait/request_observation to the host', () => {
    expect(classifyAction({ op: 'report', content: 'Done' } as Action)).toEqual({ kind: 'host', op: 'report', title: undefined, content: 'Done' });
    expect(classifyAction({ op: 'ask_user', question: 'Which account?' } as Action)).toEqual({ kind: 'host', op: 'ask_user', question: 'Which account?' });
    expect(classifyAction({ op: 'done', summary: 'Logged in' } as Action)).toEqual({ kind: 'host', op: 'done', summary: 'Logged in' });
    expect(classifyAction({ op: 'stop', reason: 'captcha' } as Action)).toEqual({ kind: 'host', op: 'stop', reason: 'captcha' });
    expect(classifyAction({ op: 'wait', ms: 500 } as Action)).toEqual({ kind: 'host', op: 'wait', ms: 500 });
    expect(classifyAction({ op: 'request_observation', level: 'L1' } as Action)).toEqual({ kind: 'host', op: 'request_observation', level: 'L1' });
  });

  it('routes click/type(text)/select/scroll/click_point to the content script, mapping expect fields', () => {
    expect(classifyAction({ op: 'click', node: 'n-1', expect: { role: 'button', name: 'Sign in', box_tolerance_px: 8 } } as Action)).toEqual({
      kind: 'content',
      action: { op: 'click', node: 'n-1', expect: { role: 'button', name: 'Sign in', boxTolerancePx: 8 } },
    });

    expect(classifyAction({ op: 'type', node: 'n-2', text: 'hello', clear_first: true } as Action)).toEqual({
      kind: 'content',
      action: { op: 'type', node: 'n-2', text: 'hello', clearFirst: true, expect: undefined },
    });

    expect(classifyAction({ op: 'select', node: 'n-3', option: 'India' } as Action)).toEqual({
      kind: 'content',
      action: { op: 'select', node: 'n-3', option: 'India', expect: undefined },
    });

    expect(classifyAction({ op: 'scroll', direction: 'down', amount: 'page' } as Action)).toEqual({
      kind: 'content',
      action: { op: 'scroll', direction: 'down', amount: 'page', node: undefined },
    });

    expect(classifyAction({ op: 'click_point', x: 10, y: 20, label: 'floating menu' } as Action)).toEqual({
      kind: 'content',
      action: { op: 'click_point', x: 10, y: 20, label: 'floating menu' },
    });
  });

  it('classifies a ref-based type action as a rehydration request (T-3.28) rather than dispatching it directly', () => {
    const action = { op: 'type', node: 'n-1', ref: '⟪AADHAAR#1⟫', clear_first: true } as Action;
    expect(classifyAction(action)).toEqual({ kind: 'rehydrate', node: 'n-1', ref: '⟪AADHAAR#1⟫', clearFirst: true, expect: undefined });
  });
});
