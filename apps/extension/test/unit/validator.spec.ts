import { describe, expect, it } from 'vitest';
import { validatePlan, type HardDenialContext } from '../../src/host/actions/validator';

function emptyContext(): HardDenialContext {
  return { nodeEntities: new Map(), extensionOwnedNodeIds: new Set() };
}

function validPlan(overrides: Record<string, unknown> = {}) {
  return {
    step_id: 's-1',
    actions: [{ op: 'click', node: 'n-1', expect: { role: 'button', name: 'Sign in' } }],
    ...overrides,
  };
}

describe('validatePlan — schema + step lease (T-2.19 AC)', () => {
  it('accepts a well-formed plan for the current step', () => {
    const result = validatePlan(validPlan(), 's-1', emptyContext());
    expect(result.ok).toBe(true);
  });

  it('rejects a plan with an unknown op before any dispatch (AC-5)', () => {
    const plan = validPlan({ actions: [{ op: 'fly_to_the_moon', node: 'n-1' }] });
    const result = validatePlan(plan, 's-1', emptyContext());
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('SCHEMA_INVALID');
  });

  it('rejects a plan computed for an older step with LEASE_EXPIRED, executing nothing (AC-5)', () => {
    const result = validatePlan(validPlan({ step_id: 's-0' }), 's-1', emptyContext());
    expect(result).toEqual({ ok: false, reason: 'LEASE_EXPIRED' });
  });

  it('rejects a plan missing required fields as SCHEMA_INVALID', () => {
    const result = validatePlan({ actions: [] }, 's-1', emptyContext());
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('SCHEMA_INVALID');
  });
});

describe('validatePlan — the standard browser actions', () => {
  it('accepts press_key, hover, double_click and the navigation ops', () => {
    const actions = [
      { op: 'press_key', key: 'Enter', node: 'n-1' },
      { op: 'press_key', key: 'PageDown' },
      { op: 'hover', node: 'n-1' },
      { op: 'double_click', node: 'n-1' },
      { op: 'open_tab', url: 'https://www.amazon.in/' },
    ];
    expect(validatePlan(validPlan({ actions }), 's-1', emptyContext()).ok).toBe(true);
    for (const op of ['go_back', 'go_forward', 'reload']) expect(validatePlan(validPlan({ actions: [{ op }] }), 's-1', emptyContext()).ok).toBe(true);
  });

  it.each(['javascript:alert(1)', 'https://x.example/\u27eaEMAIL#1\u27eb', 'https://a b.example/'])('refuses navigate to %s as SCHEMA_INVALID', (url) => {
    expect(validatePlan(validPlan({ actions: [{ op: 'navigate', url }] }), 's-1', emptyContext())).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });

  it('refuses an unknown key', () => {
    expect(validatePlan(validPlan({ actions: [{ op: 'press_key', key: 'F12' }] }), 's-1', emptyContext())).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });
});

describe('validatePlan — hard denials (T-2.23 AC)', () => {
  it('accepts a well-formed type action carrying a ref (Phase 3: resolveFor decides it downstream, per-ref — see rehydrate.spec.ts)', () => {
    const plan = validPlan({ actions: [{ op: 'type', node: 'n-1', ref: '⟪AADHAAR#1⟫' }] });
    const result = validatePlan(plan, 's-1', emptyContext());
    expect(result.ok).toBe(true);
  });

  it('refuses an action targeting a node recognised as a CAPTCHA', () => {
    const context: HardDenialContext = { nodeEntities: new Map([['n-1', 'CAPTCHA']]), extensionOwnedNodeIds: new Set() };
    const result = validatePlan(validPlan(), 's-1', context);
    expect(result).toEqual({ ok: false, reason: 'CAPTCHA_SOLVE', actionIndex: 0 });
  });

  it('refuses an action targeting the extension\'s own UI', () => {
    const context: HardDenialContext = { nodeEntities: new Map(), extensionOwnedNodeIds: new Set(['n-1']) };
    const result = validatePlan(validPlan(), 's-1', context);
    expect(result).toEqual({ ok: false, reason: 'EXTENSION_UI_TARGET', actionIndex: 0 });
  });

  it('never dispatches anything for a denied plan — the failure carries no partial success', () => {
    const plan = validPlan({
      actions: [
        { op: 'click', node: 'n-safe' },
        { op: 'click', node: 'n-captcha' },
      ],
    });
    const context: HardDenialContext = { nodeEntities: new Map([['n-captcha', 'CAPTCHA']]), extensionOwnedNodeIds: new Set() };
    const result = validatePlan(plan, 's-1', context);
    expect(result.ok).toBe(false);
  });
});
