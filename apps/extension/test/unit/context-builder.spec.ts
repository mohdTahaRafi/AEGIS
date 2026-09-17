import { validators } from '@aegis/protocol';
import { describe, expect, it } from 'vitest';
import { buildSanitizedContext } from '../../src/host/privacy/context/builder';
import type { WireScreenNode } from '../../src/shared/messages';

function node(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role: 'textbox',
    name: 'Username',
    box: [10, 20, 100, 30],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: true, hasValue: true, valueLen: 5, occluded: false, volatile: false },
    affordances: ['click', 'type'],
    field: { inputType: 'text', autocomplete: 'username', maskedCss: false, valueRead: true, value: 'ramesh' },
    container: 'c-1',
    textRuns: [],
    ...overrides,
  };
}

describe('buildSanitizedContext (T-2.25/2.31 forward dep — real schema round trip)', () => {
  it('produces a payload that validates against the real packages/protocol SanitizedContext schema', () => {
    const context = buildSanitizedContext({
      stepId: 's-1',
      task: 'log in',
      reason: 'initial',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [node('n-1'), node('n-2', { role: 'button', name: 'Sign in', field: undefined, affordances: ['click'] })],
      removed: [],
      history: [],
      clientTiming: { observe: 7, sanitize: 1 },
    });

    const result = validators.sanitizedContext(context);
    expect(result.valid).toBe(true);
  });

  it('reports coverage as fully "cleared" — no redaction layer exists yet (Phase 2 forward dependency)', () => {
    const context = buildSanitizedContext({
      stepId: 's-1',
      task: 'log in',
      reason: 'initial',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [node('n-1'), node('n-2')],
      removed: [],
      history: [],
      clientTiming: {},
    });
    expect(context.coverage).toEqual({ cleared: 1, redacted: 0, unanalysed: 0 });
    expect(context.redactions).toEqual([]);
  });

  it('a field node carries its raw value as plain text (no placeholders — nothing to substitute yet)', () => {
    const context = buildSanitizedContext({
      stepId: 's-1',
      task: 'log in',
      reason: 'initial',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [node('n-1', { field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'Ramesh Kumar' } })],
      removed: [],
      history: [],
      clientTiming: {},
    });
    expect(context.nodes[0]!.value).toEqual({ kind: 'text', text: 'Ramesh Kumar' });
  });

  it('a node with no field has no value at all', () => {
    const context = buildSanitizedContext({
      stepId: 's-1',
      task: 'log in',
      reason: 'initial',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [node('n-1', { role: 'button', name: 'Sign in', field: undefined })],
      removed: [],
      history: [],
      clientTiming: {},
    });
    expect(context.nodes[0]!.value).toBeUndefined();
  });

  it('windows history to the most recent 5 entries', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ step_id: `s-${i}`, actions: [{ op: 'click' }], outcome: 'ok' }));
    const context = buildSanitizedContext({
      stepId: 's-9',
      task: 'log in',
      reason: 'after_action',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [],
      removed: [],
      history,
      clientTiming: {},
    });
    expect(context.history).toHaveLength(5);
    expect(context.history[0]!.step_id).toBe('s-3'); // the oldest of the last 5
    const result = validators.sanitizedContext(context);
    expect(result.valid).toBe(true);
  });

  it('carries removed ids only when non-empty (delta graphs)', () => {
    const withRemoved = buildSanitizedContext({
      stepId: 's-2',
      task: 'log in',
      reason: 'after_action',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [],
      removed: ['n-1'],
      history: [],
      clientTiming: {},
    });
    expect(withRemoved.removed).toEqual(['n-1']);

    const withoutRemoved = buildSanitizedContext({
      stepId: 's-2',
      task: 'log in',
      reason: 'after_action',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'unknown',
      pageTitle: 'Login',
      nodes: [],
      removed: [],
      history: [],
      clientTiming: {},
    });
    expect(withoutRemoved.removed).toBeUndefined();
  });
});
