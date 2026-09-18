import { describe, expect, it } from 'vitest';
import { checkForCanaries } from '../../src/host/privacy/guard/canary';
import { defaultPolicy } from '@aegis/policy';
import { GuardBlockedError, guard } from '../../src/host/privacy/guard/guard';
import { Vault } from '../../src/host/privacy/vault';
import type { SanitizedContext } from '@aegis/protocol';

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

describe('checkForCanaries (design.md §7.6 step 6, T-5.8)', () => {
  it('finds a literal canary substring', () => {
    expect(checkForCanaries('note: CANARYBYBSKQ5YWMBFYS5LJ2JDV9 was here', ['CANARYBYBSKQ5YWMBFYS5LJ2JDV9'])).toBe('CANARYBYBSKQ5YWMBFYS5LJ2JDV9');
  });

  it('returns null when no canary is present', () => {
    expect(checkForCanaries('nothing sensitive here', ['CANARYBYBSKQ5YWMBFYS5LJ2JDV9'])).toBeNull();
  });

  it('returns null against an empty canary list', () => {
    expect(checkForCanaries('anything', [])).toBeNull();
  });
});

// A canary this short (14 chars) stays below `packages/recognizers`' generic high-entropy SECRET
// fallback (24+ chars) — deliberately, so these tests isolate guard step 6 itself rather than
// exercising step 4's independent pattern re-sweep, which a full-length real canary (as the eval
// corpus actually generates them) usually also triggers on its own. Both layers catching a real
// canary is a good, real defense-in-depth property of this codebase, not a test bug to work
// around — it just means a short probe is needed to test step 6 in isolation.
const SHORT_CANARY = 'CANARYSHORT123';

describe('guard() — canary step is inert without an explicit canary list (production default)', () => {
  it('a payload containing a canary-shaped string passes when no canaries are supplied', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: SHORT_CANARY }] });
    await expect(guard(payload, defaultPolicy, new Vault())).resolves.not.toThrow();
  });
});

describe('guard() — canary step blocks when the harness supplies a matching canary', () => {
  it('blocks with GuardBlockedError(CANARY) when a supplied canary appears in the payload text', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: `note: ${SHORT_CANARY} leaked` }] });
    let error: unknown;
    try {
      await guard(payload, defaultPolicy, new Vault(), { canaries: [SHORT_CANARY] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('CANARY');
  });

  it('does not block when the supplied canary is absent from the payload', async () => {
    const payload = fakePayload({ text: [{ id: 't-1', box: [0, 0, 10, 10], text: 'nothing here' }] });
    await expect(guard(payload, defaultPolicy, new Vault(), { canaries: [SHORT_CANARY] })).resolves.not.toThrow();
  });
});
