import { describe, expect, it, vi } from 'vitest';
import { brand, isBranded } from '../../src/host/egress/brand';
import { createEgressClient } from '../../src/host/egress/client';
import type { SanitizedContext } from '@aegis/protocol';

function fakePayload(): SanitizedContext {
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
    history: [],
    client_timing: {},
  };
}

describe('brand (T-2.25 AC — TypeScript brand + runtime WeakSet)', () => {
  it('an unbranded payload is not branded', () => {
    expect(isBranded(fakePayload())).toBe(false);
  });

  it('brand() marks the exact object instance as branded', () => {
    const payload = fakePayload();
    const branded = brand(payload);
    expect(isBranded(branded)).toBe(true);
    expect(isBranded(payload)).toBe(true); // same object reference
  });

  it('a different, unbranded object of the same shape is not branded (no accidental structural match)', () => {
    const a = fakePayload();
    brand(a);
    const b = fakePayload();
    expect(isBranded(b)).toBe(false);
  });
});

describe('EgressClient (T-2.25 AC — send() accepts only branded objects)', () => {
  it('sends a branded payload as a POST with a JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const client = createEgressClient(fetchImpl);
    const payload = brand(fakePayload());

    await client.sendStep(payload, 'http://localhost:5600/v1/sessions/abc/steps');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:5600/v1/sessions/abc/steps');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ schema: 'AEGIS/1' });
  });

  it('refuses an unbranded payload even if it is cast to the branded type', async () => {
    const fetchImpl = vi.fn();
    const client = createEgressClient(fetchImpl);
    const unguarded = fakePayload() as unknown as Parameters<typeof client.sendStep>[0]; // unsafe cast, as an attacker's code might do

    await expect(client.sendStep(unguarded, 'http://localhost:5600/v1/sessions/abc/steps')).rejects.toThrow(
      'EGRESS_REFUSES_UNGUARDED_PAYLOAD',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal through so cancelling AWAITING_SERVER can abort the request (T-2.18)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const client = createEgressClient(fetchImpl);
    const payload = brand(fakePayload());
    const controller = new AbortController();

    await client.sendStep(payload, 'http://localhost:5600/v1/sessions/abc/steps', controller.signal);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.signal).toBe(controller.signal);
  });
});
