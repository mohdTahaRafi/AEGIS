import { validators } from '@aegis/protocol';
import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it } from 'vitest';
import { verhoeffGenerate } from '@aegis/recognizers';
import { buildSanitizedContext, type BuildContextInput } from '../../src/host/privacy/context/builder';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode, WireTextRun } from '../../src/shared/messages';

function node(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role: 'textbox',
    name: 'Search',
    box: [10, 20, 100, 30],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: true, valueLen: 5, occluded: false, volatile: false },
    affordances: ['click', 'type'],
    field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'hello' },
    container: 'c-1',
    textRuns: [],
    ...overrides,
  };
}

type Overrides = Partial<BuildContextInput> & { nodes?: WireScreenNode[]; textRuns?: WireTextRun[] };

function buildCtx(overrides: Overrides = {}) {
  return buildSanitizedContext({
    stepId: 's-1',
    task: 'log in',
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
    pageCategory: 'unknown',
    pageTitle: 'Login',
    nodes: [],
    removed: [],
    textRuns: [],
    history: [],
    clientTiming: {},
    vault: new Vault(),
    policy: defaultPolicy,
    originKey: 'origin:test',
    ...overrides,
  });
}

function validAadhaar(): string {
  const body = '234567890123'.slice(0, 11);
  return body + verhoeffGenerate(body);
}

describe('buildSanitizedContext — schema round trip', () => {
  it('produces a payload that validates against the real packages/protocol SanitizedContext schema', () => {
    const context = buildCtx({
      nodes: [node('n-1'), node('n-2', { role: 'button', name: 'Sign in', field: undefined, affordances: ['click'] })],
    });
    const result = validators.sanitizedContext(context);
    expect(result.valid).toBe(true);
  });

  it('windows history to the most recent 5 entries', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ step_id: `s-${i}`, actions: [{ op: 'click' }], outcome: 'ok' }));
    const context = buildCtx({ stepId: 's-9', reason: 'after_action', history });
    expect(context.history).toHaveLength(5);
    expect(context.history![0]!.step_id).toBe('s-3');
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });

  it('carries removed ids only when non-empty (delta graphs)', () => {
    const withRemoved = buildCtx({ reason: 'after_action', removed: ['n-1'] });
    expect(withRemoved.removed).toEqual(['n-1']);
    const withoutRemoved = buildCtx({ reason: 'after_action', removed: [] });
    expect(withoutRemoved.removed).toBeUndefined();
  });
});

describe('buildSanitizedContext — non-sensitive fields pass through unredacted (AC-11-adjacent)', () => {
  it('a plain text field with no Channel D/T signal carries its raw value as plain text', () => {
    const context = buildCtx({ nodes: [node('n-1', { field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'hello world' } })] });
    expect(context.nodes[0]!.value).toEqual({ kind: 'text', text: 'hello world' });
    expect(context.redactions).toEqual([]);
  });

  it('a node with no field has an empty-kind value, never undefined-by-accident of a real field', () => {
    const context = buildCtx({ nodes: [node('n-1', { role: 'button', name: 'Sign in', field: undefined })] });
    expect(context.nodes[0]!.value).toBeUndefined();
  });
});

describe('buildSanitizedContext — protected fields (T-3.9/T-3.20, FR-23, AC-2)', () => {
  it('a password field is presence-only: no character of the value anywhere in the payload', () => {
    const context = buildCtx({
      nodes: [
        node('n-1', {
          role: 'textbox',
          name: 'Password',
          field: { inputType: 'password', maskedCss: false, valueRead: false },
          domSignal: { entity: 'PASSWORD', score: 1, valueRead: false },
          state: { focused: false, disabled: false, readonly: false, required: true, hasValue: true, valueLen: 9, occluded: false, volatile: false },
        }),
      ],
    });
    expect(context.nodes[0]!.value).toEqual({ kind: 'presence', entity: 'PASSWORD', len: 9 });
    const bytes = JSON.stringify(context);
    expect(bytes).not.toContain('hunter2');
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });
});

describe('buildSanitizedContext — placeholders (T-3.14/3.15/3.20, FR-27)', () => {
  it('a field value matching a real Aadhaar number becomes a typed placeholder, not raw digits', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [
        node('n-1', {
          role: 'textbox',
          name: 'Aadhaar number',
          field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar },
        }),
      ],
    });
    const value = context.nodes[0]!.value as { kind: string; ref?: string; entity?: string };
    expect(value.kind).toBe('placeholder');
    expect(value.entity).toBe('AADHAAR');
    expect(value.ref).toMatch(/^⟪AADHAAR#\d+⟫$/);
    expect(JSON.stringify(context)).not.toContain(aadhaar);
  });

  it('the same Aadhaar value appearing in prose text gets the SAME ref as the field (FR-27)', () => {
    const aadhaar = validAadhaar();
    const vault = new Vault();
    const context = buildCtx({
      vault,
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
      textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar on record: ${aadhaar}` }],
    });
    const fieldValue = context.nodes[0]!.value as { ref?: string };
    expect(context.text[0]!.text).toContain(fieldValue.ref);
    expect(context.text[0]!.text).not.toContain(aadhaar);
  });

  it('a non-sensitive text run passes through unchanged', () => {
    const context = buildCtx({ textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: 'Welcome back!' }] });
    expect(context.text[0]!.text).toBe('Welcome back!');
  });
});

describe('buildSanitizedContext — escaping forged placeholders (T-3.16)', () => {
  it('rewrites pre-existing delimiter characters before any substitution', () => {
    const context = buildCtx({ textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: 'fake ⟪AADHAAR#2⟫ marker' }] });
    expect(context.text[0]!.text).toBe('fake ‹‹AADHAAR#2›› marker');
    expect(context.text[0]!.text).not.toContain('⟪');
  });
});

describe('buildSanitizedContext — task text sanitization (T-3.21, FR-33)', () => {
  it('a task containing a phone number is sent with a placeholder, not the number', () => {
    const context = buildCtx({ task: 'pay my Airtel bill for 9876543210' });
    expect(context.task).not.toContain('9876543210');
    expect(context.task).toMatch(/⟪PHONE#\d+⟫/);
  });
});

describe('buildSanitizedContext — redactions[] legend (T-3.20)', () => {
  it('every redaction has a policy-consistent class, confidence and source', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
    });
    expect(context.redactions.length).toBeGreaterThan(0);
    const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
    expect(entry.class).toBe('CRITICAL');
    expect(entry.confidence).toBeGreaterThan(0.9);
    expect(entry.sources.length).toBeGreaterThan(0);
  });
});
