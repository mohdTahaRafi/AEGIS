import { describe, expect, it } from 'vitest';
import { explainGrant, forgetTab, noteTabUrl, originOf, readInvocation, recordInvocation, type SessionStore } from '../../src/shared/invocation';
import { isActionInvokedMessage } from '../../src/shared/messages';

function memoryStore(): SessionStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

// The sequences below are the ones measured in real Chrome 144.0.7559.96 on the real sites
// (2026-09-28, scratchpad lifecycle probe): invoke on one host, then navigate.
describe('invocation record — mirrors when Chrome grants and withdraws activeTab', () => {
  it('Practo: invoked on www.practo.com, then the login link moves the tab to accounts.practo.com → lost', async () => {
    const store = memoryStore();
    await recordInvocation(store, 5, 'https://www.practo.com/', 1000);
    await noteTabUrl(store, 5, 'https://accounts.practo.com/login?next=%2Fcheckid_request&intent=fabric');
    const record = await readInvocation(store, 5);
    expect(record).toEqual({ origin: 'https://www.practo.com', at: 1000, lostTo: 'https://accounts.practo.com' });
    expect(explainGrant(record, 'https://accounts.practo.com')).toEqual({ kind: 'lost-on-navigation', grantedOrigin: 'https://www.practo.com', currentOrigin: 'https://accounts.practo.com' });
  });

  it('Passport Seva: www.passportindia.gov.in → services2.passportindia.gov.in is a different origin → lost', async () => {
    const store = memoryStore();
    await recordInvocation(store, 6, 'https://www.passportindia.gov.in/', 1);
    await noteTabUrl(store, 6, 'https://services2.passportindia.gov.in/forms/registration');
    expect(explainGrant(await readInvocation(store, 6), 'https://services2.passportindia.gov.in').kind).toBe('lost-on-navigation');
  });

  it('same-origin navigation, SPA route changes and reloads keep the grant', async () => {
    const store = memoryStore();
    await recordInvocation(store, 7, 'https://accounts.practo.com/login', 1);
    await noteTabUrl(store, 7, 'https://accounts.practo.com/new_patient_signup');
    await noteTabUrl(store, 7, 'https://accounts.practo.com/spa-route#step-2');
    await noteTabUrl(store, 7, 'https://accounts.practo.com/spa-route#step-2');
    expect(explainGrant(await readInvocation(store, 7), 'https://accounts.practo.com')).toEqual({ kind: 'invoked', grantedOrigin: 'https://accounts.practo.com' });
  });

  it('once lost, coming back to the original site does not restore it (Chrome does not either)', async () => {
    const store = memoryStore();
    await recordInvocation(store, 8, 'https://a.example.test/', 1);
    await noteTabUrl(store, 8, 'https://b.example.test/');
    await noteTabUrl(store, 8, 'https://a.example.test/');
    expect(explainGrant(await readInvocation(store, 8), 'https://a.example.test').kind).toBe('lost-on-navigation');
  });

  it('a cross-origin redirect that completes BEFORE the click (DigiLocker) grants the final origin', async () => {
    const store = memoryStore();
    await recordInvocation(store, 9, 'https://accounts.digilocker.gov.in/v3/abc--en', 1);
    expect(explainGrant(await readInvocation(store, 9), 'https://accounts.digilocker.gov.in').kind).toBe('invoked');
  });

  it('grants are per tab: invoking one tab says nothing about another', async () => {
    const store = memoryStore();
    await recordInvocation(store, 10, 'https://en.wikipedia.org/wiki/India', 1);
    expect(explainGrant(await readInvocation(store, 11), 'https://github.com')).toEqual({ kind: 'never-invoked' });
  });

  it('re-invoking on the new site replaces a lost record', async () => {
    const store = memoryStore();
    await recordInvocation(store, 12, 'https://www.practo.com/', 1);
    await noteTabUrl(store, 12, 'https://accounts.practo.com/login');
    await recordInvocation(store, 12, 'https://accounts.practo.com/login', 2);
    expect(await readInvocation(store, 12)).toEqual({ origin: 'https://accounts.practo.com', at: 2 });
  });

  it('a closed tab is forgotten; an opaque-origin page records nothing', async () => {
    const store = memoryStore();
    await recordInvocation(store, 13, 'https://example.com/', 1);
    await forgetTab(store, 13);
    expect(await readInvocation(store, 13)).toBeNull();
    await recordInvocation(store, 14, 'data:text/html,hi', 1);
    expect(store.data.size).toBe(0);
  });

  it('stores only an origin and a time — never a path or query', async () => {
    const store = memoryStore();
    await recordInvocation(store, 15, 'https://accounts.example.test/reset?token=secret-123', 1);
    await noteTabUrl(store, 15, 'https://evil.example.test/?q=secret-456');
    expect(JSON.stringify([...store.data.values()])).not.toMatch(/secret|token|reset/);
  });

  it('a malformed stored value reads as no record', async () => {
    const store = memoryStore();
    store.data.set('aegis.invocation.16', { origin: 'https://x.test' });
    expect(await readInvocation(store, 16)).toBeNull();
  });

  it('originOf rejects opaque and unparsable URLs', () => {
    expect(originOf('https://a.test:8443/x?y')).toBe('https://a.test:8443');
    expect(originOf('data:text/html,x')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('isActionInvokedMessage', () => {
  it('accepts only an integer tab id', () => {
    expect(isActionInvokedMessage({ type: 'action-invoked', tabId: 3 })).toBe(true);
    expect(isActionInvokedMessage({ type: 'action-invoked', tabId: '3' })).toBe(false);
    expect(isActionInvokedMessage({ type: 'action-invoked', tabId: 1.5 })).toBe(false);
    expect(isActionInvokedMessage({ type: 'permission-revoked', origin: 'x' })).toBe(false);
  });
});
