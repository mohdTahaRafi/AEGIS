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

describe('validatePlan — hard denials (T-2.23 AC)', () => {
  it('refuses a type action carrying a ref (Phase 2 has no vault to resolve it against)', () => {
    const plan = validPlan({ actions: [{ op: 'type', node: 'n-1', ref: '⟪PASSWORD#1⟫' }] });
    const result = validatePlan(plan, 's-1', emptyContext());
    expect(result).toEqual({ ok: false, reason: 'PROTECTED_FIELD_READ', actionIndex: 0 });
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
        { op: 'type', node: 'n-2', ref: '⟪OTP#1⟫' },
      ],
    });
    const result = validatePlan(plan, 's-1', emptyContext());
    expect(result.ok).toBe(false);
  });
});
