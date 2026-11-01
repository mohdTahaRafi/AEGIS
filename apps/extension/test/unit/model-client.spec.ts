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
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', response_format: { type: 'json_object' }, reasoning_effort: 'none', temperature: 0.2, max_tokens: 900 });
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
    expect(await check(new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.8-27b' }] })))).toEqual({ ok: true, visionModelListed: true, model: 'qwen/qwen3.8-27b' });
    expect(await check(new Response(JSON.stringify({ data: [{ id: 'llama' }] })))).toEqual({ ok: true, visionModelListed: false });
  });
  it('rejects a refused key, and distinguishes an unreachable API', async () => {
    expect(await check(new Response('{}', { status: 401 }))).toEqual({ ok: false, reason: 'invalid_key', status: 401 });
    expect(await check(new TypeError('Failed to fetch'))).toEqual({ ok: false, reason: 'unreachable' });
    expect(await check(new Response('{}', { status: 500 }))).toEqual({ ok: false, reason: 'http_error', status: 500 });
  });
});

describe('model client: Gemini (per-model daily quotas)', () => {
  const GEMINI = { apiKey: 'AIza' + 'x'.repeat(35), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', provider: 'gemini' as const };
  // Google's shape: an array around the error, the quota named in `details`.
  const dailyQuota = (model: string) =>
    new Response(
      JSON.stringify([
        {
          error: {
            code: 429,
            message: `Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: ${model}`,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
            ],
          },
        },
      ]),
      { status: 429 },
    );

  function gemini(responses: Response[], apiKey = GEMINI.apiKey) {
    let clock = 0;
    const switches: string[] = [];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = createModelClient(
      { ...GEMINI, apiKey },
      { fetchImpl: fetchImpl as unknown as typeof fetch, bucket: new TokenBucket(), now: () => clock, sleep: async (ms) => void (clock += ms / 1000), onModelSwitch: (from, to) => switches.push(`${from}->${to}`) },
    );
    const models = () => fetchImpl.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).model as string);
    return { client, switches, models, fetchImpl };
  }

  it('uses temperature 1 and the least thinking each model accepts (Flash-Lite: minimal, Flash: low)', async () => {
    const { client, fetchImpl } = gemini([completion('{"actions":[]}')], 'AIza' + 'a'.repeat(35));
    await client.complete(MESSAGES);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'gemini-3.5-flash-lite', temperature: 1, reasoning_effort: 'minimal', max_tokens: 4000 });
    const spy = vi.fn(async () => completion('{"actions":[]}'));
    await createModelClient({ ...GEMINI, model: 'gemini-3.5-flash' }, { fetchImpl: spy as unknown as typeof fetch, bucket: new TokenBucket() }).complete(MESSAGES);
    expect(JSON.parse((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).reasoning_effort).toBe('low');
  });

  it("moves on to the next model when one's daily quota is used up, and stays there", async () => {
    const { client, switches, models } = gemini([dailyQuota('gemini-3.5-flash-lite'), completion('{"actions":[]}'), completion('{"actions":[]}')], 'AIza' + 'b'.repeat(35));
    await client.complete(MESSAGES);
    await client.complete(MESSAGES);
    expect(models()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']);
    expect(switches).toEqual(['gemini-3.5-flash-lite->gemini-3.1-flash-lite']);
  });

  it('ends the task with a daily-limit error once every model is used up', async () => {
    const { client } = gemini(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'].map(dailyQuota), 'AIza' + 'c'.repeat(35));
    const err = (await failure(client.complete(MESSAGES))) as StepFailedError;
    expect(err.detail).toBe('MODEL_UNAVAILABLE upstream_quota_day');
    expect(err.retryable).toBe(false);
  });

  it("a per-minute 429 waits the body's retryDelay instead of switching model", async () => {
    const perMinute = new Response(JSON.stringify([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '7s' }] } }]), { status: 429 });
    const { client, models } = gemini([perMinute, completion('{"actions":[]}')], 'AIza' + 'd'.repeat(35));
    await client.complete(MESSAGES);
    expect(models()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
  });

  it("a bad key (Google's 400 API_KEY_INVALID) is reported as a refused key", async () => {
    const bad = () => new Response(JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }]), { status: 400 });
    const { client } = gemini([bad()], 'AIza' + 'e'.repeat(35));
    expect(((await failure(client.complete(MESSAGES))) as StepFailedError).detail).toMatch(/^MODEL_UNAVAILABLE upstream_auth/);
    expect(await verifyApiKey(GEMINI, (async () => bad()) as unknown as typeof fetch)).toMatchObject({ ok: false, reason: 'invalid_key' });
  });

  it('a smart step goes to the smart models first and the client says which model answered', async () => {
    const { client, models } = gemini([completion('{"actions":[]}'), completion('{"actions":[]}')], 'AIza' + 'f'.repeat(35));
    await client.complete(MESSAGES, undefined, 'smart');
    expect(client.lastModel()).toBe('gemini-3.6-flash');
    await client.complete(MESSAGES);
    expect(client.lastModel()).toBe('gemini-3.5-flash-lite');
    expect(models()).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  });

  it('a smart model that is used up or missing makes the step routine, never an error', async () => {
    const missing = () => new Response(JSON.stringify([{ error: { code: 404, status: 'NOT_FOUND' } }]), { status: 404 });
    const { client, models } = gemini([dailyQuota('gemini-3.6-flash'), missing(), completion('{"actions":[]}')], 'AIza' + 'g'.repeat(35));
    await client.complete(MESSAGES, undefined, 'smart');
    expect(models()).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
    expect(client.lastModel()).toBe('gemini-3.5-flash-lite');
  });

  it('an overloaded model (503 "high demand") hands the step to the next model at once', async () => {
    const busy = () => new Response(JSON.stringify([{ error: { code: 503, status: 'UNAVAILABLE' } }]), { status: 503 });
    const { client, models } = gemini([busy(), completion('{"actions":[]}'), completion('{"actions":[]}')], 'AIza' + 'h'.repeat(35));
    await client.complete(MESSAGES, undefined, 'smart');
    expect(models()).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
    // Passed over for the next minute too, while another model can take the step.
    await client.complete(MESSAGES, undefined, 'smart');
    expect(models()).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash']);
  });

  it('a slow reply is raced against the next model, and the first good answer wins', async () => {
    const aborted: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      const delay = model === 'gemini-3.5-flash-lite' ? 5000 : 5;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(completion(`{"actions":[],"by":"${model}"}`)), delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted.push(model);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const client = createModelClient({ ...GEMINI, apiKey: 'AIza' + 'i'.repeat(35) }, { fetchImpl: fetchImpl as unknown as typeof fetch, bucket: new TokenBucket(), hedgeAfterMs: 20 });
    const answer = (await client.complete(MESSAGES)) as { by: string };
    expect(answer.by).toBe('gemini-3.1-flash-lite');
    expect(client.lastModel()).toBe('gemini-3.1-flash-lite');
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toEqual(['gemini-3.5-flash-lite']);
  });

  it('"Test key" reads Gemini\'s "models/…" ids', async () => {
    const list = { data: [{ id: 'models/gemini-3.6-flash' }, { id: 'models/gemini-3.5-flash-lite' }] };
    expect(await verifyApiKey(GEMINI, (async () => new Response(JSON.stringify(list))) as unknown as typeof fetch)).toEqual({ ok: true, visionModelListed: true, model: 'gemini-3.5-flash-lite' });
  });
});
