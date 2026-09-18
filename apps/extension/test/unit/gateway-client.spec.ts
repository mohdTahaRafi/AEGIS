import { describe, expect, it, vi } from 'vitest';
import { brand } from '../../src/host/egress/brand';
import { createGatewayClient } from '../../src/host/egress/gateway-client';
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

describe('GatewayClient (design.md §4.1 — sessions carry no page data)', () => {
  it('openSession() posts client capabilities only, with no page data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session_id: 'sid-1', model: 'test', limits: { max_steps: 30, max_image_px: 1000 } })));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);

    const created = await client.openSession();

    expect(created.session_id).toBe('sid-1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/v1/sessions');
    const body = JSON.parse(init.body);
    expect(body.schema).toBe('AEGIS/1');
    expect(body.client.browser).toBe('chrome');
    expect(JSON.stringify(body)).not.toContain('log in'); // no task text, no page data
  });

  it('throws SESSION_OPEN_FAILED on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    await expect(client.openSession()).rejects.toThrow('SESSION_OPEN_FAILED');
  });

  it('sendStep() posts the guarded payload to the session-scoped URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ step_id: 's-1', actions: [{ op: 'wait', ms: 1 }] })));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    const payload = brand(fakePayload());

    await client.sendStep('sid-1', payload, new AbortController().signal);

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/v1/sessions/sid-1/steps');
  });

  it('closeSession() never throws even if the DELETE fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    await expect(client.closeSession('sid-1')).resolves.toBeUndefined();
  });
});

describe('GatewayClient — bearer token (design.md §4.1, T-2.31)', () => {
  // A real, previously-undiscovered gap this project's genuine end-to-end integration testing
  // caught (Phase 5): the gateway requires `Authorization: Bearer <token>` on every /v1 call
  // (server/gateway/src/aegis_gateway/auth.py), but this client sent none at all — every real
  // call against a real gateway would 401. These three tests lock the header in for good.
  it('openSession() sends the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session_id: 'sid-1', model: 'test', limits: { max_steps: 30, max_image_px: 1000 } })));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl, 'my-token');
    await client.openSession();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer my-token');
  });

  it('sendStep() sends the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ step_id: 's-1', actions: [] })));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl, 'my-token');
    await client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer my-token');
  });

  it('closeSession() sends the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl, 'my-token');
    await client.closeSession('sid-1');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer my-token');
  });

  it('defaults to "dev-token", matching the gateway config default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session_id: 'sid-1', model: 'test', limits: { max_steps: 30, max_image_px: 1000 } })));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    await client.openSession();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer dev-token');
  });
});
