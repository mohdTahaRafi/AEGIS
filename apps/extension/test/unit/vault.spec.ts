import { describe, expect, it, vi } from 'vitest';
import { Vault } from '../../src/host/privacy/vault';

describe('Vault.mint (T-3.14, FR-27)', () => {
  it('the same value at the same origin always returns the same ref within a session', () => {
    const vault = new Vault();
    const ref1 = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const ref2 = vault.mint('AADHAAR', '2345 6789 0123', { originKey: 'o-1', stepId: 's-2', class: 'CRITICAL' });
    expect(ref1).toBe(ref2); // digit-grouping differences normalize to the same value
  });

  it('different values never collide', () => {
    const vault = new Vault();
    const ref1 = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const ref2 = vault.mint('AADHAAR', '234567890124', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(ref1).not.toBe(ref2);
  });

  it('a new Vault instance (new session) renumbers from 1', () => {
    const vaultA = new Vault();
    vaultA.mint('AADHAAR', 'x', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    vaultA.mint('EMAIL', 'y', { originKey: 'o-1', stepId: 's-1', class: 'HIGH' });
    const vaultB = new Vault();
    const ref = vaultB.mint('AADHAAR', 'x', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(ref).toBe('⟪AADHAAR#1⟫');
  });

  it('the same value at a DIFFERENT origin mints a distinct ref (origin is part of the mint key)', () => {
    const vault = new Vault();
    const ref1 = vault.mint('EMAIL', 'a@b.com', { originKey: 'o-1', stepId: 's-1', class: 'HIGH' });
    const ref2 = vault.mint('EMAIL', 'a@b.com', { originKey: 'o-2', stepId: 's-1', class: 'HIGH' });
    expect(ref1).not.toBe(ref2);
  });
});

describe('Vault surface (T-3.17 — no serialization API)', () => {
  it('exposes no toJSON, entries, values or Symbol.iterator', () => {
    const vault = new Vault();
    expect((vault as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
    expect((vault as unknown as { entries?: unknown }).entries).toBeUndefined();
    expect((vault as unknown as { values?: unknown }).values).toBeUndefined();
    expect((vault as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator]).toBeUndefined();
  });

  it('JSON.stringify on a vault instance never includes minted values', () => {
    const vault = new Vault();
    vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(JSON.stringify(vault)).toBe('{}');
  });

  it('normalizedValues is the only iteration surface, and only yields normalized forms, never raw values verbatim when grouped', () => {
    const vault = new Vault();
    vault.mint('AADHAAR', '2345 6789 0123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const values = [...vault.normalizedValues()];
    expect(values).toEqual(['234567890123']);
  });
});

describe('Vault lifetime (T-3.18)', () => {
  it('clear() makes has() false for every prior ref', () => {
    const vault = new Vault();
    const ref = vault.mint('EMAIL', 'a@b.com', { originKey: 'o-1', stepId: 's-1', class: 'HIGH' });
    expect(vault.has(ref)).toBe(true);
    vault.clear();
    expect(vault.has(ref)).toBe(false);
  });

  it('clears automatically after the idle timeout', () => {
    vi.useFakeTimers();
    const vault = new Vault(1000);
    const ref = vault.mint('EMAIL', 'a@b.com', { originKey: 'o-1', stepId: 's-1', class: 'HIGH' });
    vi.advanceTimersByTime(999);
    expect(vault.has(ref)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(vault.has(ref)).toBe(false);
    vi.useRealTimers();
  });
});

describe('Vault.resolveFor (T-3.28 — all six conditions)', () => {
  function baseTarget(overrides: Partial<Parameters<Vault['resolveFor']>[1]> = {}) {
    return {
      typeMatches: true,
      originKey: 'o-1',
      confirmed: true,
      isPresenceOnlyTarget: false,
      visible: true,
      enabled: true,
      occluded: false,
      ...overrides,
    };
  }

  it('condition 1 — an unknown ref is REF_UNKNOWN', () => {
    const vault = new Vault();
    expect(vault.resolveFor('⟪AADHAAR#99⟫', baseTarget())).toEqual({ ok: false, code: 'REF_UNKNOWN' });
  });

  it('condition 2 — a presence-only target is PRESENCE_ONLY', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget({ isPresenceOnlyTarget: true }))).toEqual({ ok: false, code: 'PRESENCE_ONLY' });
  });

  it('condition 3 — a type mismatch is TYPE_MISMATCH', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget({ typeMatches: false }))).toEqual({ ok: false, code: 'TYPE_MISMATCH' });
  });

  it('condition 4 — a different origin is ORIGIN_MISMATCH', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget({ originKey: 'o-2' }))).toEqual({ ok: false, code: 'ORIGIN_MISMATCH' });
  });

  it('condition 5 — not confirmed is CONFIRM_DECLINED', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget({ confirmed: false }))).toEqual({ ok: false, code: 'CONFIRM_DECLINED' });
  });

  it('condition 6 — occluded is NODE_UNRESOLVED', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget({ occluded: true }))).toEqual({ ok: false, code: 'NODE_UNRESOLVED' });
  });

  it('all conditions satisfied returns the real value', () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '234567890123', { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    expect(vault.resolveFor(ref, baseTarget())).toEqual({ ok: true, value: '234567890123' });
  });
});
