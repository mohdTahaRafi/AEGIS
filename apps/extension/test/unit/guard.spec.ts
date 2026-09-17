import { defaultPolicy } from '@aegis/policy';
import { verhoeffGenerate } from '@aegis/recognizers';
import { describe, expect, it } from 'vitest';
import { isBranded } from '../../src/host/egress/brand';
import { GuardBlockedError, guard } from '../../src/host/privacy/guard/guard';
import { normalizedContains } from '../../src/host/privacy/guard/normalize-contains';
import { Vault } from '../../src/host/privacy/vault';
import type { SanitizedContext } from '@aegis/protocol';

function validAadhaar(): string {
  const body = '234567890123'.slice(0, 11);
  return body + verhoeffGenerate(body);
}

function fakePayload(overrides: Partial<SanitizedContext> = {}): SanitizedContext {
  return {
    schema: 'AEGIS/1',
    step_id: 's-1',
    task: 'log in',
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scroll_y: 0, doc_h: 600 },
    page: { category: 'unknown', title: 'Test' },
    nodes: [],
    text: [],
    redactions: [],
    unexplained: [],
    coverage: { cleared: 1, redacted: 0, unanalysed: 0 },
    image: null,
    history: [],
    client_timing: {},
    ...overrides,
  };
}

describe('normalizedContains (T-3.23)', () => {
  it('matches digit-grouped and ungrouped forms of the same number', () => {
    expect(normalizedContains('the number is 1234 5678 9012 here', '123456789012')).toBe(true);
  });

  it('matches a non-numeric normalized value regardless of surrounding whitespace', () => {
    expect(normalizedContains('contact a@b.com for help', 'a@b.com')).toBe(true);
  });

  it('does not match an unrelated string', () => {
    expect(normalizedContains('nothing sensitive here', '987654321098')).toBe(false);
  });
});

describe('guard() — schema and id-shape (T-3.22)', () => {
  it('blocks a schema-invalid payload', () => {
    const bad = { not: 'valid' } as unknown as SanitizedContext;
    expect(() => guard(bad, defaultPolicy, new Vault())).toThrow(GuardBlockedError);
  });

  it('passes a well-formed empty payload and brands it', () => {
    const result = guard(fakePayload(), defaultPolicy, new Vault());
    expect(isBranded(result)).toBe(true);
  });
});

describe('guard() — vault-leak sweep (T-3.23, AC-6)', () => {
  it('blocks a payload where a vault-known value leaked into the bytes unsubstituted', () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });

    // Simulates a sabotaged substitution pass: the value is minted (so the vault knows it) but a
    // second occurrence slipped into the payload's text unredacted.
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `leaked: ${aadhaar}` }] });

    let error: unknown;
    try {
      guard(payload, defaultPolicy, vault);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('VAULT_LEAK');
  });

  it('catches both grouped and ungrouped digit forms of the same leaked value', () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const grouped = `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`;
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `leaked: ${grouped}` }] });
    expect(() => guard(payload, defaultPolicy, vault)).toThrow(GuardBlockedError);
  });

  it('does not block a payload that only contains the vault-eligible value AS a placeholder ref', () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    const ref = vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `Aadhaar on record: ${ref}` }] });
    expect(() => guard(payload, defaultPolicy, vault)).not.toThrow();
  });
});

describe('guard() — independent pattern re-sweep (T-3.24)', () => {
  it('blocks a value that was never detected by any channel (planted post-substitution)', () => {
    const aadhaar = validAadhaar();
    // No vault entry at all — simulates a detection miss (the guard is the ONLY thing catching this).
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `never detected: ${aadhaar}` }] });
    let error: unknown;
    try {
      guard(payload, defaultPolicy, new Vault());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('PATTERN');
    expect((error as GuardBlockedError).entity).toBe('AADHAAR');
  });

  it('does not block a checksum-invalid look-alike (AC-11 — no over-blocking)', () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'tracking number 234567890128' }] });
    expect(() => guard(payload, defaultPolicy, new Vault())).not.toThrow();
  });
});

describe('brand (T-3.25)', () => {
  it('guard() returns a branded payload only on success', () => {
    const branded = guard(fakePayload(), defaultPolicy, new Vault());
    expect(isBranded(branded)).toBe(true);
  });
});
