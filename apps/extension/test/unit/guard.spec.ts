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
  it('blocks a schema-invalid payload', async () => {
    const bad = { not: 'valid' } as unknown as SanitizedContext;
    await expect(guard(bad, defaultPolicy, new Vault())).rejects.toThrow(GuardBlockedError);
  });

  it('passes a well-formed empty payload and brands it', async () => {
    const result = await guard(fakePayload(), defaultPolicy, new Vault());
    expect(isBranded(result)).toBe(true);
  });
});

describe('guard() — vault-leak sweep (T-3.23, AC-6)', () => {
  it('blocks a payload where a vault-known value leaked into the bytes unsubstituted', async () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });

    // Simulates a sabotaged substitution pass: the value is minted (so the vault knows it) but a
    // second occurrence slipped into the payload's text unredacted.
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `leaked: ${aadhaar}` }] });

    let error: unknown;
    try {
      await guard(payload, defaultPolicy, vault);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('VAULT_LEAK');
  });

  it('catches both grouped and ungrouped digit forms of the same leaked value', async () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const grouped = `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`;
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `leaked: ${grouped}` }] });
    await expect(guard(payload, defaultPolicy, vault)).rejects.toThrow(GuardBlockedError);
  });

  it('does not block a payload that only contains the vault-eligible value AS a placeholder ref', async () => {
    const vault = new Vault();
    const aadhaar = validAadhaar();
    const ref = vault.mint('AADHAAR', aadhaar, { originKey: 'o-1', stepId: 's-1', class: 'CRITICAL' });
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `Aadhaar on record: ${ref}` }] });
    await expect(guard(payload, defaultPolicy, vault)).resolves.not.toThrow();
  });
});

describe('guard() — independent pattern re-sweep (T-3.24)', () => {
  it('blocks a value that was never detected by any channel (planted post-substitution)', async () => {
    const aadhaar = validAadhaar();
    // No vault entry at all — simulates a detection miss (the guard is the ONLY thing catching this).
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `never detected: ${aadhaar}` }] });
    let error: unknown;
    try {
      await guard(payload, defaultPolicy, new Vault());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('PATTERN');
    expect((error as GuardBlockedError).entity).toBe('AADHAAR');
  });

  it('does not block a checksum-invalid look-alike (AC-11 — no over-blocking)', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'tracking number 234567890128' }] });
    await expect(guard(payload, defaultPolicy, new Vault())).resolves.not.toThrow();
  });
});

describe('brand (T-3.25)', () => {
  it('guard() returns a branded payload only on success', async () => {
    const branded = await guard(fakePayload(), defaultPolicy, new Vault());
    expect(isBranded(branded)).toBe(true);
  });
});

describe('vault-leak sweep — short sealed values (semantic-first redaction seals "123", "abc")', () => {
  const nodeWith = (name: string, box: [number, number, number, number]) => ({
    id: 'n-1',
    role: 'textbox',
    name,
    box,
    frame: 'f-0',
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, has_value: true, value_len: 3, occluded: false, volatile: false },
    affordances: ['type' as const],
  });

  it('does not block because a short sealed value appears inside a number, an id or a placeholder', async () => {
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '123', { originKey: 'o', stepId: 's-1', class: 'CRITICAL' });
    const payload = fakePayload({
      nodes: [{ ...nodeWith('Aadhaar', [123, 1234, 312, 40]), value: { kind: 'placeholder', ref: ref as never, entity: 'AADHAAR', len: 3 } }],
      viewport: { w: 1123, h: 600, dpr: 1, scroll_y: 0, doc_h: 1230 },
    });
    await expect(guard(payload, defaultPolicy, vault)).resolves.toBeDefined();
  });

  it('does not block on a short value that is only a substring of a longer word', async () => {
    const vault = new Vault();
    vault.mint('EMAIL', 'abc', { originKey: 'o', stepId: 's-1', class: 'HIGH' });
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'The alphabet starts abcdef' }] });
    await expect(guard(payload, defaultPolicy, vault)).resolves.toBeDefined();
  });

  it('still blocks when the short value itself leaks as a token in page text', async () => {
    const vault = new Vault();
    vault.mint('EMAIL', 'abc', { originKey: 'o', stepId: 's-1', class: 'HIGH' });
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'Welcome back, abc!' }] });
    await expect(guard(payload, defaultPolicy, vault)).rejects.toThrow(GuardBlockedError);
  });

  it('still blocks when the short value leaks through the task or a node name', async () => {
    const vault = new Vault();
    vault.mint('AADHAAR', '123', { originKey: 'o', stepId: 's-1', class: 'CRITICAL' });
    await expect(guard(fakePayload({ task: 'type 123 in the box' }), defaultPolicy, vault)).rejects.toThrow(GuardBlockedError);
    await expect(guard(fakePayload({ nodes: [nodeWith('Aadhaar 123', [0, 0, 1, 1])] }), defaultPolicy, vault)).rejects.toThrow(GuardBlockedError);
  });
});

describe('pattern re-sweep — geometry is not page text', () => {
  it('does not block on a float box coordinate whose fraction is a Verhoeff-valid 12-digit run', async () => {
    // Real, from passportindia.gov.in's scrolling ticker (2026-09-28).
    const payload = fakePayload({ text: [{ id: 't-1', box: [-319.9978942871094, 109, 2399.562255859375, 19.5], text: 'Check the revised fee' }] });
    await expect(guard(payload, defaultPolicy, new Vault())).resolves.toBeDefined();
  });

  it('still blocks a valid Aadhaar that reached page text unsubstituted', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `Aadhaar ${validAadhaar()}` }] });
    await expect(guard(payload, defaultPolicy, new Vault())).rejects.toThrow(GuardBlockedError);
  });
});

describe('guard() — pattern re-sweep uses the policy thresholds, like the builder', () => {
  it('a bare date (below the DOB threshold: pass-through by policy) does not block the step', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'Launched on 15/08/1969 from Sriharikota' }] });
    await expect(guard(payload, defaultPolicy, new Vault())).resolves.toBeDefined();
  });

  it('an unredacted Aadhaar still blocks', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `Aadhaar ${validAadhaar()}` }] });
    await expect(guard(payload, defaultPolicy, new Vault())).rejects.toMatchObject({ rule: 'PATTERN', entity: 'AADHAAR' });
  });
});
