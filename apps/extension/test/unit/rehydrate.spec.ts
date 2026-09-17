import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it } from 'vitest';
import { rehydrationRequiresConfirmation, resolveRehydration } from '../../src/host/actions/rehydrate';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode } from '../../src/shared/messages';

function aadhaarField(overrides: Partial<WireScreenNode> = {}): WireScreenNode {
  return {
    id: 'n-1',
    frame: 'f-0',
    role: 'textbox',
    name: 'Aadhaar number',
    box: [0, 0, 100, 20],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: true, hasValue: false, valueLen: 0, occluded: false, volatile: false },
    affordances: ['click', 'type'],
    field: { inputType: 'text', maskedCss: false, valueRead: true },
    container: 'c-1',
    textRuns: [],
    ...overrides,
  };
}

describe('rehydrationRequiresConfirmation (T-3.30)', () => {
  it('CRITICAL entities require confirmation per the default policy', () => {
    expect(rehydrationRequiresConfirmation(defaultPolicy, 'AADHAAR')).toBe(true);
  });
  it('HIGH entities do not require confirmation per the default policy (auto_same_origin)', () => {
    expect(rehydrationRequiresConfirmation(defaultPolicy, 'EMAIL')).toBe(false);
  });
});

describe('resolveRehydration (T-3.28 — all six conditions via a real WireScreenNode)', () => {
  it('resolves a CRITICAL ref into a type-matched, same-origin, confirmed field', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const result = resolveRehydration(vault, defaultPolicy, ref, { originKey: 'o-1', confirmed: true, targetNode: aadhaarField() });
    expect(result).toEqual({ ok: true, value: '234567890123' });
  });

  it('TYPE_MISMATCH — an Aadhaar ref cannot be typed into an unrelated field', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const result = resolveRehydration(vault, defaultPolicy, ref, {
      originKey: 'o-1',
      confirmed: true,
      targetNode: aadhaarField({ name: 'Comment box', field: { inputType: 'text', maskedCss: false, valueRead: true } }),
    });
    expect(result).toEqual({ ok: false, code: 'TYPE_MISMATCH' });
  });

  it('ORIGIN_MISMATCH — a ref minted on one origin refuses on another (anti-exfiltration core)', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const result = resolveRehydration(vault, defaultPolicy, ref, { originKey: 'o-attacker', confirmed: true, targetNode: aadhaarField() });
    expect(result).toEqual({ ok: false, code: 'ORIGIN_MISMATCH' });
  });

  it('CONFIRM_DECLINED — a CRITICAL ref without confirmation is refused', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const result = resolveRehydration(vault, defaultPolicy, ref, { originKey: 'o-1', confirmed: false, targetNode: aadhaarField() });
    expect(result).toEqual({ ok: false, code: 'CONFIRM_DECLINED' });
  });

  it('PRESENCE_ONLY — a password ref (should never exist, but defence in depth) is refused', () => {
    const vault = new Vault();
    const ref = vault.mint('PASSWORD', 'hunter2', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const result = resolveRehydration(vault, defaultPolicy, ref, {
      originKey: 'o-1',
      confirmed: true,
      targetNode: aadhaarField({ name: 'Password', field: { inputType: 'password', maskedCss: false, valueRead: false } }),
    });
    expect(result).toEqual({ ok: false, code: 'PRESENCE_ONLY' });
  });

  it('REF_UNKNOWN — a ref never minted this session is refused', () => {
    const vault = new Vault();
    const result = resolveRehydration(vault, defaultPolicy, '⟪AADHAAR#99⟫', { originKey: 'o-1', confirmed: true, targetNode: aadhaarField() });
    expect(result).toEqual({ ok: false, code: 'REF_UNKNOWN' });
  });

  it('EMAIL resolves same-origin without confirmation being required by policy (HIGH class)', () => {
    const vault = new Vault();
    const ref = vault.mint('EMAIL', 'a@b.com', { originKey: 'o-1', stepId: 's-1', class: 'HIGH' });
    const target = aadhaarField({ name: 'Email address', field: { inputType: 'email', maskedCss: false, valueRead: true } });
    const result = resolveRehydration(vault, defaultPolicy, ref, { originKey: 'o-1', confirmed: true, targetNode: target });
    expect(result).toEqual({ ok: true, value: 'a@b.com' });
  });
});
