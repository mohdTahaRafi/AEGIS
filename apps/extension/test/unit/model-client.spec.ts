import { describe, expect, it, vi } from 'vitest';
import { ModelRequestTooLarge, StepFailedError } from '../../src/host/agent/errors';
import { PlanError } from '../../src/host/agent/plan';
import type { ChatMessage } from '../../src/host/agent/prompt';
import { TokenBucket } from '../../src/host/agent/budget';
import { createModelClient, verifyApiKey } from '../../src/host/egress/model-client';

const KEY = 'gsk_test_key_1234567890abcdef';
const CONFIG = { apiKey: KEY, baseUrl: 'https://api.groq.com/openai/v1/', model: 'qwen/qwen3.8-27b' };
const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'page' }, { type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' } }] },
];

const completion = (content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 50 }, ...extra }), { status: 200, headers });
const errorResponse = (status: number, error: object, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error }), { status, headers });

function harness(responses: (Response | Error)[]) {
  let clock = 0;
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next!;
  });
  const client = createModelClient(CONFIG, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    bucket: new TokenBucket(),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms / 1000;
    },
  });
  return { client, fetchImpl, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

describe('model client: the request', () => {
  it('sends the prompt with the user\'s own key to chat/completions, asking for JSON with thinking off', async () => {
    const { client, fetchImpl } = harness([completion('{"actions":[]}')]);
    await client.complete(MESSAGES);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', response_format: { type: 'json_object' }, reasoning_effort: 'none', temperature: 0, max_tokens: 900 });
    expect(body.messages[1].content[1].image_url.url).toContain('data:image/webp');
  });

  it('reads the JSON answer, including one wrapped in a code fence', async () => {
    const { client } = harness([completion('```json\n{"actions":[{"op":"done","summary":"x"}]}\n```')]);
    expect(await client.complete(MESSAGES)).toEqual({ actions: [{ op: 'done', summary: 'x' }] });
  });

  it('treats an answer that is not JSON as an invalid plan (one corrective retry), not an outage', async () => {
    const { client } = harness([completion('Sure! Here is what I would do')]);
    expect(await failure(client.complete(MESSAGES))).toBeInstanceOf(PlanError);
  });

  it('treats Groq\'s json_validate_failed the same way', async () => {
    const { client } = harness([errorResponse(400, { code: 'json_validate_failed', failed_generation: 'the secret page text' })]);
    const err = await failure(client.complete(MESSAGES));
    expect(err).toBeInstanceOf(PlanError);
    expect((err as Error).message).not.toContain('secret');
  });
});

describe('model client: failures stay in a closed vocabulary', () => {
  it('a refused key is permanent, named, and never echoes the key or the body', async () => {
    const { client } = harness([errorResponse(401, { code: 'invalid_api_key', message: `Invalid API Key ${KEY} org_abc123` })]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect(err).toBeInstanceOf(StepFailedError);
    expect(err.retryable).toBe(false);
    expect(err.detail).toBe('MODEL_UNAVAILABLE upstream_auth (401 invalid_api_key)');
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.message).not.toContain('org_abc123');
  });

  it('a 413 carries only the two token numbers, for the engine to rebuild the prompt smaller', async () => {
    const { client } = harness([errorResponse(413, { code: 'rate_limit_exceeded', type: 'tokens', message: 'Limit 7000, Requested 9046, org_secret' })]);
    const err = (await failure(client.complete(MESSAGES))) as ModelRequestTooLarge;
    expect(err).toBeInstanceOf(ModelRequestTooLarge);
    expect([err.limit, err.requested]).toEqual([7000, 9046]);
    expect(err.detail).not.toContain('org_secret');
  });

  it('a 5xx is transient', async () => {
    const { client } = harness([errorResponse(503, { message: 'overloaded' })]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect([err.retryable, err.detail]).toEqual([true, 'MODEL_UNAVAILABLE upstream_5xx']);
  });

  it('another 4xx is permanent', async () => {
    const { client } = harness([errorResponse(404, { code: 'model_not_found' })]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect([err.retryable, err.detail]).toEqual([false, 'MODEL_UNAVAILABLE upstream_4xx (404 model_not_found)']);
  });

  it('a body with no choices is a transient bad_body', async () => {
    const { client } = harness([new Response('{}', { status: 200 })]);
    expect(((await failure(client.complete(MESSAGES))) as StepFailedError).detail).toBe('MODEL_UNAVAILABLE bad_body');
  });

  it('a timeout is MODEL_TIMEOUT and is never retried by the client', async () => {
    const { client, fetchImpl } = harness([new DOMException('timed out', 'TimeoutError')]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect([err.status, err.detail, err.retryable]).toEqual([504, 'MODEL_TIMEOUT', true]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a dropped connection is retried once, then reported as unreachable', async () => {
    const dropped = () => new TypeError('Failed to fetch');
    const ok = harness([dropped(), completion('{"actions":[]}')]);
    expect(await ok.client.complete(MESSAGES)).toEqual({ actions: [] });
    expect(ok.sleeps).toEqual([1000]);
    const down = harness([dropped(), dropped()]);
    expect(((await failure(down.client.complete(MESSAGES))) as StepFailedError).detail).toBe('MODEL_UNAVAILABLE unreachable');
  });

  it('a cancelled task is not reported as a failure of the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = harness([new DOMException('aborted', 'AbortError')]);
    const err = await failure(client.complete(MESSAGES, controller.signal));
    expect(err).toBeInstanceOf(DOMException);
  });
});

describe('model client: rate limits', () => {
  it('waits out a 429 for exactly the time the API names, then sends again', async () => {
    const { client, fetchImpl, sleeps } = harness([errorResponse(429, { code: 'rate_limit_exceeded' }, { 'retry-after': '7' }), completion('{"actions":[]}')]);
    expect(await client.complete(MESSAGES)).toEqual({ actions: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([7000]);
  });

  it('gives up with a retryable upstream_429 carrying Retry-After after repeated 429s', async () => {
    const limited = () => errorResponse(429, {}, { 'retry-after': '3' });
    const { client, fetchImpl } = harness([limited(), limited(), limited(), limited()]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect([err.retryable, err.retryAfterS, err.detail]).toEqual([true, 3, 'MODEL_UNAVAILABLE upstream_429 retry in 3 s']);
  });

  it('paces itself by the budget the API reports instead of running into a 429', async () => {
    const budget = { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '8000' };
    const { client, fetchImpl, sleeps } = harness([completion('{"actions":[]}', {}, budget), completion('{"actions":[]}', {}, budget)]);
    await client.complete(MESSAGES);
    expect(sleeps).toEqual([]);
    await client.complete(MESSAGES); // the first step's screenshot still counts against the minute
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1000);
  });

  it('tells the caller to come back later, without waiting, when the API asks for more than a minute', async () => {
    const { client, fetchImpl, sleeps } = harness([errorResponse(429, {}, { 'retry-after': '120' })]);
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect([err.retryable, err.retryAfterS]).toEqual([true, 120]);
  });
});

describe('model client: one budget per account', () => {
  it('a second task on the same key and model paces against what the first one spent', async () => {
    const budget = { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '8000' };
    const sleeps: number[] = [];
    const deps = (responses: Response[]) => ({ fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch, now: () => 0, sleep: async (ms: number) => void sleeps.push(ms) });
    const config = { ...CONFIG, apiKey: 'gsk_shared_budget_key_1234567890' };
    await createModelClient(config, deps([completion('{"actions":[]}', {}, budget)])).complete(MESSAGES);
    expect(sleeps).toEqual([]);
    await createModelClient(config, deps([completion('{"actions":[]}', {}, budget)])).complete(MESSAGES);
    expect(sleeps).toHaveLength(1);
  });
});

describe('verifyApiKey ("Test key")', () => {
  const check = (response: Response | Error) => verifyApiKey(CONFIG, (async () => { if (response instanceof Error) throw response; return response; }) as unknown as typeof fetch);
  it('accepts a working key and reports whether the vision model is available to it', async () => {
    expect(await check(new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.8-27b' }] })))).toEqual({ ok: true, visionModelListed: true });
    expect(await check(new Response(JSON.stringify({ data: [{ id: 'llama' }] })))).toEqual({ ok: true, visionModelListed: false });
  });
  it('rejects a refused key, and distinguishes an unreachable API', async () => {
    expect(await check(new Response('{}', { status: 401 }))).toEqual({ ok: false, reason: 'invalid_key', status: 401 });
    expect(await check(new TypeError('Failed to fetch'))).toEqual({ ok: false, reason: 'unreachable' });
    expect(await check(new Response('{}', { status: 500 }))).toEqual({ ok: false, reason: 'http_error', status: 500 });
  });
});
