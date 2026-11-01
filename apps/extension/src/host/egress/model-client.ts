// The one place a step's prompt leaves the device for the model API, called with the user's own key
// (bring your own key: the key is theirs, kept in this browser, and goes only to this endpoint).
// An OpenAI-compatible chat-completions call to one of the providers in providers.ts. The prompt it is given was built
// from the guarded step by `agent/`, so everything here is already redacted.
//
// Failures become `StepFailedError`s in a closed vocabulary (agent/errors.ts): neither the body of
// an API error (it can echo the prompt) nor the key is ever put in one.

import { estimateTokens, TokenBucket } from '../agent/budget';
import { ModelRequestTooLarge, modelTimeout, modelUnavailable } from '../agent/errors';
import { PlanError } from '../agent/plan';
import type { ChatMessage } from '../agent/prompt';
import type { ModelTier } from '../agent/engine';
import { PROVIDERS, PROVIDER_IDS, type ProviderId, type ProviderPreset } from './providers';

const REQUEST_TIMEOUT_MS = 45_000;
// Low, not 0: at 0 a model that once produced an invalid plan for a page produces the same one
// again on the retry; a little variety lets the corrective retry differ. Still low enough that an
// "explain this page" answer stays inside the JSON object.
const TEMPERATURE = 0.2;
// How long a step may wait for the per-minute budget to refill instead of being sent into a 429.
// Above it the caller is told to retry after the wait.
const BUDGET_MAX_WAIT_S = 60;
const MAX_ATTEMPTS = 4;
const TRANSPORT_RETRY_WAIT_MS = 1000;
const DEFAULT_RETRY_AFTER_S = 10;
// A model whose daily quota ran out is skipped for this long, then tried again (quotas reset once a
// day; one wasted request an hour is the cost of not tracking each provider's reset time).
const DAILY_QUOTA_SKIP_S = 3600;
// A model the API reported overloaded (5xx, e.g. Gemini's 503 "high demand") is passed over for this
// long when another one can take the step.
const OVERLOAD_SKIP_S = 60;
// A reply slower than this is raced against the same request to the next model (the free tiers
// sometimes take 10-30 s for an ordinary reply); the first good answer wins, the other is aborted.
const HEDGE_AFTER_MS = 7000;

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Absent: inferred from `baseUrl` (a dev endpoint override falls back to Mistral's settings). */
  provider?: ProviderId;
}

/** The preset whose request shape this config uses. */
export function presetFor(config: ModelConfig): ProviderPreset {
  if (config.provider) return PROVIDERS[config.provider];
  const byUrl = PROVIDER_IDS.find((id) => config.baseUrl.startsWith(PROVIDERS[id].origin));
  return PROVIDERS[byUrl ?? 'mistral'];
}

export interface ModelClient {
  /** The JSON the model produced, parsed but not yet validated. `smart` tries the provider's
   * smarter models first (providers.ts `smartModels`). */
  complete(messages: readonly ChatMessage[], signal?: AbortSignal, tier?: ModelTier): Promise<unknown>;
  /** The model that produced the last answer. */
  lastModel(): string | undefined;
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
  /** A provider with per-model daily quotas moved on to `to` because `from`'s quota is used up. */
  onModelSwitch?: (from: string, to: string) => void;
  /** Tests: how long before a slow reply is raced against the next model (default 7 s). */
  hedgeAfterMs?: number;
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

// A quota that resets daily: Gemini's `quotaId` ("GenerateRequestsPerDayPerProjectPerModel-FreeTier")
// or Groq's "tokens per day (TPD)" / "requests per day (RPD)".
const DAILY_QUOTA = /PerDay|per day|\((?:TPD|RPD)\)/;
const RETRY_DELAY = /^(\d{1,6})(?:\.\d+)?s$/;

interface UpstreamError {
  code?: string;
  limit?: number;
  requested?: number;
  /** A 429 for a quota that only resets the next day. */
  daily?: boolean;
  /** Gemini sends its wait in the body (`RetryInfo.retryDelay`), not in a Retry-After header. */
  retryDelayS?: number;
}

/** The closed-vocabulary parts of an API error body: `code`/`type` only when a plain `[a-z_.]`
 * identifier, a token limit/request only as integers, and booleans. Google's APIs wrap the body in
 * an array and describe the error in `details` (`reason: "API_KEY_INVALID"`, `QuotaFailure`,
 * `RetryInfo`). */
async function upstreamError(response: Response): Promise<UpstreamError> {
  let error: unknown;
  try {
    const body = (await response.json()) as unknown;
    error = ((Array.isArray(body) ? body[0] : body) as { error?: unknown } | undefined)?.error;
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
  const message = typeof fields.message === 'string' ? fields.message : '';
  const match = TOKEN_LIMIT.exec(message);
  if (match) {
    out.limit = Number(match[1]);
    out.requested = Number(match[2]);
  }
  if (DAILY_QUOTA.test(message)) out.daily = true;
  for (const detail of Array.isArray(fields.details) ? (fields.details as Record<string, unknown>[]) : []) {
    if (typeof detail !== 'object' || detail === null) continue;
    if (detail.reason === 'API_KEY_INVALID') out.code = 'api_key_invalid';
    const violations = Array.isArray(detail.violations) ? (detail.violations as { quotaId?: unknown }[]) : [];
    if (violations.some((v) => typeof v?.quotaId === 'string' && DAILY_QUOTA.test(v.quotaId))) out.daily = true;
    const delay = typeof detail.retryDelay === 'string' ? RETRY_DELAY.exec(detail.retryDelay) : null;
    if (delay) out.retryDelayS = Number(delay[1]);
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
/** key|model → monotonic second until which the model's daily quota is taken as used up. Shared by
 * every task in this panel, like the buckets. */
const exhaustedUntil = new Map<string, number>();
/** key|model → a smart model this key cannot use (the API answered 404 for it). */
const missingModels = new Set<string>();
/** key|model → monotonic second until which the model is passed over as overloaded. */
const overloadedUntil = new Map<string, number>();

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
  const preset = presetFor(config);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // The configured model, then (where each model has its own daily quota) the ones after it in the
  // provider's list: the order is best first, so a fallback is never better than what was chosen.
  const listed = preset.models.findIndex((m) => m.id === config.model);
  const chain = preset.perModelDailyQuota && listed !== -1 ? preset.models.slice(listed).map((m) => m.id) : [config.model];
  const quotaKey = (model: string) => `${config.baseUrl}|${model}|${config.apiKey}`;
  // `available`: the model can be asked at all today. `usable`: and it is not overloaded right now.
  const available = (model: string) => (exhaustedUntil.get(quotaKey(model)) ?? 0) <= now() && !missingModels.has(quotaKey(model));
  const usable = (model: string) => available(model) && (overloadedUntil.get(quotaKey(model)) ?? 0) <= now();
  /** The first model of `list` to ask: one that is not overloaded if there is one. */
  const pick = (list: readonly string[], except?: string) => list.find((m) => m !== except && usable(m)) ?? list.find((m) => m !== except && available(m));
  // The smart models first, then the user's own chain: a smart model that is used up or missing
  // never stops a step, it only makes that step routine.
  const smartChain = [...new Set([...(preset.smartModels ?? []), ...chain])];
  let answeredBy: string | undefined;

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

  /** `post`, raced: if `model` has not answered after the hedge delay, the same request goes to
   * `backup` too, and the first 2xx answer wins (the other request is aborted). A failure before
   * the delay is returned at once, for the caller's usual handling. */
  async function postHedged(model: string, backup: string | undefined, bodyFor: (m: string) => string, signal?: AbortSignal): Promise<{ response: Response; model: string }> {
    type Settled = { model: string } & ({ ok: true; response: Response } | { ok: false; error: unknown });
    type Flight = { ctl: AbortController; settled: Promise<Settled> };
    const launch = (m: string): Flight => {
      const ctl = new AbortController();
      const settled = post(bodyFor(m), signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal).then(
        (response): Settled => ({ model: m, ok: true, response }),
        (error: unknown): Settled => ({ model: m, ok: false, error }),
      );
      return { ctl, settled };
    };
    const unwrap = (r: Settled): { response: Response; model: string } => {
      if (!r.ok) throw r.error;
      return { response: r.response, model: r.model };
    };
    const primary = launch(model);
    if (!backup) return unwrap(await primary.settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hedge = new Promise<'hedge'>((resolve) => (timer = setTimeout(() => resolve('hedge'), deps.hedgeAfterMs ?? HEDGE_AFTER_MS)));
    const first = await Promise.race([primary.settled, hedge]);
    clearTimeout(timer);
    if (first !== 'hedge') return unwrap(first);
    const running: Flight[] = [primary, launch(backup)];
    let fallback: Settled | undefined;
    while (running.length > 0) {
      const { flight, r } = await Promise.race(running.map((f) => f.settled.then((settled) => ({ flight: f, r: settled }))));
      running.splice(running.indexOf(flight), 1);
      if (r.ok && r.response.ok) {
        for (const other of running) other.ctl.abort();
        return unwrap(r);
      }
      if (r.model === model || !fallback) fallback = r;
    }
    return unwrap(fallback!);
  }

  return {
    lastModel: () => answeredBy,
    async complete(messages, signal, tier = 'fast') {
      const tierChain = tier === 'smart' ? smartChain : chain;
      let model = pick(tierChain);
      if (model === undefined) throw dailyQuotaUsedUp();
      const bodyFor = (m: string) =>
        JSON.stringify({
          model: m,
          messages,
          max_tokens: preset.maxTokens,
          response_format: { type: 'json_object' },
          temperature: preset.temperature ?? TEMPERATURE,
          ...preset.extraParams,
          ...preset.models.find((entry) => entry.id === m)?.params,
        });
      const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      const cost = estimateTokens(messages, preset.maxTokens, hasImage ? preset.imageTokens : 0);

      let rateLimited: ReturnType<typeof modelUnavailable> | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const wait = bucket.waitFor(cost, now());
        if (wait > BUDGET_MAX_WAIT_S) throw modelUnavailable('upstream_429', { retryAfterS: wait });
        if (wait > 0) await sleep(wait * 1000, signal);
        bucket.spend(cost, now());

        // Races only where the provider has other models with their own quotas to race against.
        const backup = preset.perModelDailyQuota ? tierChain.find((m) => m !== model && usable(m)) : undefined;
        const sent = await postHedged(model, backup, bodyFor, signal);
        const response = sent.response;
        model = sent.model;
        // A 429's own budget headers are not a usable reading (they sent a 5 s Retry-After into a
        // 42 s wait): its Retry-After is what is trusted.
        if (response.status !== 429) bucket.update(response.headers, now());
        if (response.status === 429) {
          const upstream = await upstreamError(response);
          if (upstream.daily) {
            exhaustedUntil.set(quotaKey(model), now() + DAILY_QUOTA_SKIP_S);
            const next = pick(tierChain);
            if (next === undefined) throw dailyQuotaUsedUp();
            deps.onModelSwitch?.(model, next);
            model = next;
            attempt--; // a different model is a first attempt, not a retry
            continue;
          }
          const wait429 = retryAfterS(response) ?? upstream.retryDelayS;
          bucket.block(wait429 ?? DEFAULT_RETRY_AFTER_S, now());
          rateLimited = modelUnavailable('upstream_429', { retryAfterS: wait429 });
          continue;
        }
        // Overloaded ("high demand"): the step goes to the next model at once instead of being sent
        // to the same overloaded one again after a back-off.
        if (response.status >= 500) {
          overloadedUntil.set(quotaKey(model), now() + OVERLOAD_SKIP_S);
          const next = tierChain.find((m) => m !== model && usable(m));
          if (next !== undefined) {
            model = next;
            attempt--;
            continue;
          }
        }
        // A smart model this key cannot use: the step goes to the next model, not to an error.
        if (response.status === 404 && model !== config.model) {
          missingModels.add(quotaKey(model));
          const next = pick(tierChain);
          if (next === undefined) throw await failure(response);
          model = next;
          attempt--;
          continue;
        }
        if (response.status >= 400) throw await failure(response);
        const parsed = await parseCompletion(response, bucket, preset.maxTokens);
        answeredBy = model;
        return parsed;
      }
      throw rateLimited ?? modelUnavailable('upstream_429');
    },
  };
}

/** Every model this key may use has run out of free requests for today: retrying cannot help. */
const dailyQuotaUsedUp = () => modelUnavailable('upstream_quota_day', { retryable: false });

async function failure(response: Response): Promise<Error> {
  const upstream = await upstreamError(response);
  // Groq ran the model and its output was not JSON: an invalid plan, caught upstream instead of by
  // JSON.parse below. Same path, same one corrective retry. Not "model unavailable".
  if (upstream.code === 'json_validate_failed') return new PlanError('model response was not valid JSON (json_validate_failed)');
  // Transient server trouble: the caller may send this step again.
  if (response.status >= 500) return modelUnavailable('upstream_5xx');
  if (response.status === 413) return new ModelRequestTooLarge(upstream.limit, upstream.requested);
  // Every other 4xx is permanent for this request: re-sending it only fails again. 401/403: the key.
  // Google answers a bad key with 400 and `API_KEY_INVALID`.
  const reason = response.status === 401 || response.status === 403 || upstream.code === 'api_key_invalid' ? 'upstream_auth' : 'upstream_4xx';
  return modelUnavailable(reason, { retryable: false, detail: `${response.status}${upstream.code ? ` ${upstream.code}` : ''}` });
}

async function parseCompletion(response: Response, bucket: TokenBucket, maxTokens: number): Promise<unknown> {
  let content: unknown;
  try {
    const body = (await response.json()) as { usage?: { completion_tokens?: unknown }; choices: { message: { content: unknown } }[] };
    const completion = body.usage?.completion_tokens;
    if (typeof completion === 'number') bucket.refund(maxTokens - completion);
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

export type KeyCheck = { ok: true; visionModelListed: boolean; model?: string } | { ok: false; reason: 'invalid_key' | 'unreachable' | 'http_error'; status?: number };

interface ListedModel {
  id?: unknown;
  /** Mistral lists what each model takes: `capabilities.vision`. */
  capabilities?: { vision?: unknown };
  /** OpenRouter: `architecture.input_modalities`. */
  architecture?: { input_modalities?: unknown };
}

function takesImages(model: ListedModel): boolean | undefined {
  if (model.capabilities && typeof model.capabilities.vision === 'boolean') return model.capabilities.vision;
  const modalities = model.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes('image');
  return undefined;
}

/** "Test key": lists the models the key can use (no tokens are spent) and picks the best vision
 * model among them — the configured one if it is usable, else the first of the provider's list
 * that is. `model` is that choice; `visionModelListed` false means none of them was found. */
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
  if (!response.ok) {
    if ((await upstreamError(response)).code === 'api_key_invalid') return { ok: false, reason: 'invalid_key', status: response.status };
    return { ok: false, reason: 'http_error', status: response.status };
  }
  try {
    const { data } = (await response.json()) as { data?: ListedModel[] };
    const usable = new Map<string, ListedModel>();
    // Gemini lists ids as "models/gemini-…"; requests take the bare id.
    for (const m of data ?? []) if (typeof m.id === 'string' && takesImages(m) !== false) usable.set(m.id.replace(/^models\//, ''), m);
    const candidates = [config.model, ...presetFor(config).models.map((m) => m.id)];
    const model = candidates.find((id) => usable.has(id));
    return model ? { ok: true, visionModelListed: true, model } : { ok: true, visionModelListed: false };
  } catch {
    return { ok: true, visionModelListed: false };
  }
}
