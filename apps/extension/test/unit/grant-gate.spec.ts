import { describe, expect, it, vi } from 'vitest';
import { createGatedCapture, type GrantGateDeps } from '../../src/host/capture/grant-gate';
import type { CaptureResult } from '../../src/host/capture/classify';
import type { GrantExplanation, InvocationRecord } from '../../src/shared/invocation';

const OK: CaptureResult = { ok: true, bitmap: {} as ImageBitmap };
const DENIED: CaptureResult = { ok: false, reason: 'permission', detail: "Either the '<all_urls>' or 'activeTab' permission is required." };

/** A fake browser: the grant exists only after `click()`, exactly like Chrome's activeTab. */
function harness(opts: { origin?: string; record?: InvocationRecord | null; captures?: CaptureResult[] } = {}) {
  let now = 10_000;
  let granted = false;
  let record: InvocationRecord | null = opts.record ?? null;
  const origin = opts.origin ?? 'https://accounts.practo.com';
  const invokedListeners = new Set<() => void>();
  const prompts: Array<{ explanation: GrantExplanation; settle: (o: 'retry' | 'cancelled') => void; dismissed: boolean }> = [];
  const scripted = [...(opts.captures ?? [])];
  const deps: GrantGateDeps & { capture: ReturnType<typeof vi.fn> } = {
    capture: vi.fn(async () => scripted.shift() ?? (granted ? OK : DENIED)),
    readInvocation: async () => record,
    currentOrigin: async () => origin,
    onInvoked: (cb) => {
      invokedListeners.add(cb);
      return () => invokedListeners.delete(cb);
    },
    prompt: (explanation, settle) => {
      const entry = { explanation, settle, dismissed: false };
      prompts.push(entry);
      return () => {
        entry.dismissed = true;
      };
    },
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  };
  const click = (): void => {
    granted = true;
    now += 700;
    record = { origin, at: now };
    for (const cb of [...invokedListeners]) cb();
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { deps, prompts, click, flush, listeners: invokedListeners, setRecord: (r: InvocationRecord) => (record = r) };
}

describe('createGatedCapture — a refused capture waits for the user instead of silently going DOM-only', () => {
  it('a granted tab captures once, with no prompt', async () => {
    const h = harness({ captures: [OK] });
    expect(await createGatedCapture(h.deps)()).toBe(OK);
    expect(h.prompts).toHaveLength(0);
  });

  it('never-invoked: prompts, then the toolbar invocation on the task tab retries and succeeds', async () => {
    const h = harness();
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.explanation).toEqual({ kind: 'never-invoked' });
    h.click();
    expect(await pending).toBe(OK);
    expect(h.deps.capture).toHaveBeenCalledTimes(2);
    expect(h.prompts[0]!.dismissed).toBe(true);
    expect(h.listeners.size).toBe(0);
  });

  it('grant lost on a cross-origin navigation is reported as grant-lost-navigation, and explained', async () => {
    const h = harness({ record: { origin: 'https://www.practo.com', at: 1, lostTo: 'https://accounts.practo.com' } });
    const gated = createGatedCapture(h.deps);
    const pending = gated();
    await h.flush();
    expect(h.prompts[0]!.explanation).toEqual({ kind: 'lost-on-navigation', grantedOrigin: 'https://www.practo.com', currentOrigin: 'https://accounts.practo.com' });
    h.prompts[0]!.settle('cancelled');
    expect(await pending).toEqual({ ok: false, reason: 'grant-lost-navigation', detail: DENIED.ok ? undefined : DENIED.detail });
  });

  it('access allowed from the card retries the capture at once', async () => {
    const h = harness({ captures: [DENIED, OK] });
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    h.prompts[0]!.settle('retry');
    expect(await pending).toBe(OK);
    expect(h.deps.capture).toHaveBeenCalledTimes(2);
  });

  it('there is no waiver: every later capture that is refused asks again', async () => {
    const h = harness();
    const gated = createGatedCapture(h.deps);
    const first = gated();
    await h.flush();
    h.prompts[0]!.settle('cancelled');
    await first;
    const second = gated();
    await h.flush();
    expect(h.prompts).toHaveLength(2);
    h.click();
    expect(await second).toBe(OK);
  });

  it('Stop resolves the wait with the failure; no retry', async () => {
    const h = harness();
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    h.prompts[0]!.settle('cancelled');
    expect(await pending).toMatchObject({ ok: false, reason: 'permission' });
    expect(h.deps.capture).toHaveBeenCalledTimes(1);
  });

  it('an invocation on another tab does not resume the wait (listener is per task tab upstream)', async () => {
    const h = harness();
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    // Nothing fires the task-tab listener: still waiting.
    await h.flush();
    expect(h.deps.capture).toHaveBeenCalledTimes(1);
    h.prompts[0]!.settle('cancelled');
    await pending;
  });

  it('an invocation that landed between the refused capture and the subscription is not missed', async () => {
    const h = harness({ captures: [DENIED, OK] });
    // Record already shows a click made after the capture started.
    h.setRecord({ origin: 'https://accounts.practo.com', at: 10_050 });
    const deps = { ...h.deps, readInvocation: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ origin: 'https://accounts.practo.com', at: 10_050 }) };
    expect(await createGatedCapture(deps)()).toBe(OK);
  });

  it('an older invocation record (before the refused capture) does not count as a new click', async () => {
    const h = harness({ record: { origin: 'https://accounts.practo.com', at: 5 } });
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    expect(h.deps.capture).toHaveBeenCalledTimes(1);
    expect(h.prompts[0]!.explanation.kind).toBe('invoked');
    h.prompts[0]!.settle('cancelled');
    await pending;
  });

  it('keeps Chrome’s 2-per-second capture limit between the refused capture and the retry', async () => {
    const h = harness({ captures: [DENIED, OK] });
    const deps = { ...h.deps, readInvocation: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ origin: 'https://accounts.practo.com', at: 10_000 }) };
    await createGatedCapture(deps)();
    expect(deps.sleep).toHaveBeenCalledWith(550);
  });

  it('still refused after an invocation → asks again rather than pretending', async () => {
    const h = harness({ captures: [DENIED, DENIED, OK] });
    const pending = createGatedCapture(h.deps)();
    await h.flush();
    h.click();
    await h.flush();
    await h.flush();
    expect(h.prompts).toHaveLength(2);
    h.click();
    expect(await pending).toBe(OK);
  });

  it('host-access is also cured by an invocation; other failures never prompt', async () => {
    const hostAccess = harness({ captures: [{ ok: false, reason: 'host-access' }, OK] });
    const pending = createGatedCapture(hostAccess.deps)();
    await hostAccess.flush();
    hostAccess.click();
    expect(await pending).toBe(OK);

    for (const reason of ['restricted-page', 'not-visible', 'origin-changed', 'throttled', 'unknown'] as const) {
      const h = harness({ captures: [{ ok: false, reason }] });
      expect(await createGatedCapture(h.deps)()).toEqual({ ok: false, reason });
      expect(h.prompts).toHaveLength(0);
    }
  });
});
