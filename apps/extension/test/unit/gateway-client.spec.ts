import { describe, expect, it, vi } from 'vitest';
import { brand } from '../../src/host/egress/brand';
import { StepFailedError, createGatewayClient } from '../../src/host/egress/gateway-client';
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

  it('sendStep() failure keeps only the closed-vocabulary error code, reason and Retry-After (R-1)', async () => {
    const envelope = { error: { code: 'MODEL_UNAVAILABLE', message: 'Model unavailable: upstream_429', request_id: 'r-1', retryable: true } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 503, headers: { 'retry-after': '42' } }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    const error = await client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepFailedError);
    expect((error as StepFailedError).status).toBe(503);
    expect((error as StepFailedError).detail).toBe('MODEL_UNAVAILABLE upstream_429 retry in 42 s');
    expect((error as Error).message).toBe('STEP_FAILED: 503 MODEL_UNAVAILABLE upstream_429 retry in 42 s');
  });

  it('sendStep() failure keeps the gateway\'s safe detail for a permanent upstream error (not retryable)', async () => {
    const message = 'Model unavailable: upstream_too_large (input 9046 tokens > limit 7000 per minute)';
    const envelope = { error: { code: 'MODEL_UNAVAILABLE', message, request_id: 'r-1', retryable: false } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 502 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    const error = (await client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal).catch((e: unknown) => e)) as StepFailedError;
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe('MODEL_UNAVAILABLE upstream_too_large (input 9046 tokens > limit 7000 per minute)');
  });

  it('sendStep() failure drops a detail outside the gateway\'s closed alphabet', async () => {
    const message = 'Model unavailable: upstream_4xx (Name: Asha Verma)';
    const envelope = { error: { code: 'MODEL_UNAVAILABLE', message, request_id: 'r-1', retryable: false } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 502 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    const error = (await client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal).catch((e: unknown) => e)) as StepFailedError;
    expect(error.detail).toBe('MODEL_UNAVAILABLE');
  });

  it('sendStep() failure never copies free text from the response into the error', async () => {
    const envelope = { error: { code: 'PLAN_INVALID', message: 'node "Asha Verma" was not sent', request_id: 'r-1', retryable: false } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 422 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    const error = (await client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal).catch((e: unknown) => e)) as StepFailedError;
    expect(error.detail).toBe('PLAN_INVALID');
    expect(error.message).not.toContain('Asha');
  });

  it('sendStep() failure with a non-envelope body keeps just the status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const client = createGatewayClient('http://localhost:8787', 'chrome', fetchImpl);
    await expect(client.sendStep('sid-1', brand(fakePayload()), new AbortController().signal)).rejects.toThrow(/^STEP_FAILED: 502$/);
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
