// The one place a step's prompt leaves the device for the model API, called with the user's own key
// (bring your own key: the key is theirs, kept in this browser, and goes only to this endpoint).
// An OpenAI-compatible chat-completions call: Groq by default. The prompt it is given was built
// from the guarded step by `agent/`, so everything here is already redacted.
//
// Failures become `StepFailedError`s in a closed vocabulary (agent/errors.ts): neither the body of
// an API error (it can echo the prompt) nor the key is ever put in one.

import { IMAGE_BUDGET_TOKENS, estimateTokens, TokenBucket } from '../agent/budget';
import { ModelRequestTooLarge, modelTimeout, modelUnavailable } from '../agent/errors';
import { PlanError } from '../agent/plan';
import type { ChatMessage } from '../agent/prompt';

export const DEFAULT_MODEL_URL = 'https://api.groq.com/openai/v1';
/** Groq's only image-input model (checked against GET /openai/v1/models, 2026-09-30). */
export const DEFAULT_MODEL_NAME = 'qwen/qwen3.8-27b';

const MAX_TOKENS = 900; // a plan is ~60-150 tokens; a typed reply or a report up to ~600
const REQUEST_TIMEOUT_MS = 45_000;
// Qwen on Groq: thinking off (hidden reasoning tokens count against the quota). Temperature 0:
// Groq's default sampling often opened an "explain this page" answer in prose, which JSON mode
// rejects.
const REASONING_EFFORT = 'none';
const TEMPERATURE = 0;
// How long a step may wait for the per-minute budget to refill instead of being sent into a 429.
// Above it the caller is told to retry after the wait.
const BUDGET_MAX_WAIT_S = 60;
const MAX_ATTEMPTS = 4;
const TRANSPORT_RETRY_WAIT_MS = 1000;
const DEFAULT_RETRY_AFTER_S = 10;

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ModelClient {
  /** The JSON the model produced, parsed but not yet validated. */
  complete(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<unknown>;
}

export interface ModelClientDeps {
  fetchImpl?: typeof fetch;
  /** The per-minute budget to pace against. By default one per key and model, shared by every task
   * in this panel: the budget belongs to the account, not to a task, so a second task started right
   * after the first waits for it instead of running into a 429. */
  bucket?: TokenBucket;
  /** Monotonic seconds. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const SAFE_CODE = /^[a-z_.]{1,40}$/;
// Groq's 413: "... on input tokens per minute (ITPM): Limit 7000, Requested 9046, ...". Only the two
// numbers are kept; the rest of an upstream message is never returned.
const TOKEN_LIMIT = /Limit (\d{1,9}), Requested (\d{1,9})/;

interface UpstreamError {
  code?: string;
  limit?: number;
  requested?: number;
}

/** The closed-vocabulary parts of an API error body: `code`/`type` only when a plain `[a-z_.]`
 * identifier, and a token limit/request only as integers. */
async function upstreamError(response: Response): Promise<UpstreamError> {
  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    return {};
  }
  if (typeof error !== 'object' || error === null) return {};
  const fields = error as Record<string, unknown>;
  const out: UpstreamError = {};
  for (const key of ['code', 'type']) {
    const value = fields[key];
    if (out.code === undefined && typeof value === 'string' && SAFE_CODE.test(value)) out.code = value;
  }
  const match = typeof fields.message === 'string' ? TOKEN_LIMIT.exec(fields.message) : null;
  if (match) {
    out.limit = Number(match[1]);
    out.requested = Number(match[2]);
  }
  return out;
}

function stripCodeFence(text: string): string {
  let out = text.trim();
  if (out.startsWith('```')) {
    const newline = out.indexOf('\n');
    out = newline === -1 ? '' : out.slice(newline + 1);
    if (out.trimEnd().endsWith('```')) out = out.trimEnd().slice(0, -3);
  }
  return out.trim();
}

const retryAfterS = (response: Response): number | undefined => {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const sharedBuckets = new Map<string, TokenBucket>();

function sharedBucket(config: ModelConfig): TokenBucket {
  const id = `${config.baseUrl}|${config.model}|${config.apiKey}`;
  let bucket = sharedBuckets.get(id);
  if (!bucket) sharedBuckets.set(id, (bucket = new TokenBucket()));
  return bucket;
}

export function createModelClient(config: ModelConfig, deps: ModelClientDeps = {}): ModelClient {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => performance.now() / 1000);
  const sleep = deps.sleep ?? abortableSleep;
  const bucket = deps.bucket ?? sharedBucket(config);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  /** One POST. A dropped connection is retried once; a timeout never is (the model may still be
   * generating, and a retry doubles the wait and the tokens spent). */
  async function post(body: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      try {
        return await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof DOMException && err.name === 'TimeoutError') throw modelTimeout();
        if (attempt === 0) {
          await sleep(TRANSPORT_RETRY_WAIT_MS, signal);
          continue;
        }
        throw modelUnavailable('unreachable');
      }
    }
  }

  return {
    async complete(messages, signal) {
      const payload = {
        model: config.model,
        messages,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        reasoning_effort: REASONING_EFFORT,
        temperature: TEMPERATURE,
      };
      const body = JSON.stringify(payload);
      const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      const cost = estimateTokens(messages, MAX_TOKENS, hasImage ? IMAGE_BUDGET_TOKENS : 0);

      let rateLimited: ReturnType<typeof modelUnavailable> | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const wait = bucket.waitFor(cost, now());
        if (wait > BUDGET_MAX_WAIT_S) throw modelUnavailable('upstream_429', { retryAfterS: wait });
        if (wait > 0) await sleep(wait * 1000, signal);
        bucket.spend(cost, now());

        const response = await post(body, signal);
        // A 429's own budget headers are not a usable reading (they sent a 5 s Retry-After into a
        // 42 s wait): its Retry-After is what is trusted.
        if (response.status !== 429) bucket.update(response.headers, now());
        if (response.status === 429) {
          const wait429 = retryAfterS(response);
          bucket.block(wait429 ?? DEFAULT_RETRY_AFTER_S, now());
          rateLimited = modelUnavailable('upstream_429', { retryAfterS: wait429 });
          continue;
        }
        if (response.status >= 400) throw await failure(response);
        return parseCompletion(response, bucket);
      }
      throw rateLimited ?? modelUnavailable('upstream_429');
    },
  };
}

async function failure(response: Response): Promise<Error> {
  const upstream = await upstreamError(response);
  // Groq ran the model and its output was not JSON: an invalid plan, caught upstream instead of by
  // JSON.parse below. Same path, same one corrective retry. Not "model unavailable".
  if (upstream.code === 'json_validate_failed') return new PlanError('model response was not valid JSON (json_validate_failed)');
  // Transient server trouble: the caller may send this step again.
  if (response.status >= 500) return modelUnavailable('upstream_5xx');
  if (response.status === 413) return new ModelRequestTooLarge(upstream.limit, upstream.requested);
  // Every other 4xx is permanent for this request: re-sending it only fails again. 401/403: the key.
  const reason = response.status === 401 || response.status === 403 ? 'upstream_auth' : 'upstream_4xx';
  return modelUnavailable(reason, { retryable: false, detail: `${response.status}${upstream.code ? ` ${upstream.code}` : ''}` });
}

async function parseCompletion(response: Response, bucket: TokenBucket): Promise<unknown> {
  let content: unknown;
  try {
    const body = (await response.json()) as { usage?: { completion_tokens?: unknown }; choices: { message: { content: unknown } }[] };
    const completion = body.usage?.completion_tokens;
    if (typeof completion === 'number') bucket.refund(MAX_TOKENS - completion);
    content = body.choices[0]!.message.content;
  } catch {
    throw modelUnavailable('bad_body');
  }
  if (typeof content !== 'string') throw modelUnavailable('bad_body');
  try {
    return JSON.parse(stripCodeFence(content));
  } catch (err) {
    // A malformed plan is a malformed plan, whether it fails to parse or to validate: both get the
    // same one corrective retry, then PLAN_INVALID.
    throw new PlanError(`model response was not valid JSON: ${err instanceof SyntaxError ? 'parse error' : 'unreadable'}`);
  }
}

export type KeyCheck = { ok: true; visionModelListed: boolean } | { ok: false; reason: 'invalid_key' | 'unreachable' | 'http_error'; status?: number };

/** "Test key": lists the models the key can use (no tokens are spent) and checks that the vision
 * model AEGIS needs is among them. */
export async function verifyApiKey(config: ModelConfig, fetchImpl: typeof fetch = (i, o) => fetch(i, o), signal?: AbortSignal): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'invalid_key', status: response.status };
  if (!response.ok) return { ok: false, reason: 'http_error', status: response.status };
  try {
    const { data } = (await response.json()) as { data?: { id?: unknown }[] };
    return { ok: true, visionModelListed: (data ?? []).some((m) => m.id === config.model) };
  } catch {
    return { ok: true, visionModelListed: false };
  }
}
