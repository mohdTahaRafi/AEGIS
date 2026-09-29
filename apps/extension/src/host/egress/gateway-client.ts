// design.md §4.1 (T-2.31/T-2.32 client side) — session open/close carry **no page data**
// (architecture §8.1), so they bypass the guard entirely; only the per-step payload goes through
// `EgressClient.sendStep`, which refuses anything not `GuardedPayload`-branded.
//
// `client` carries capability metadata only (no page data): the policy id and that steps may
// carry a redacted L1 image.

import type { SessionCreate, SessionCreated } from '@aegis/protocol';
import { defaultPolicy } from '@aegis/policy';
import { createEgressClient } from './client';
import type { GuardedPayload } from './brand';

export interface GatewayClient {
  openSession(): Promise<SessionCreated>;
  sendStep(sessionId: string, payload: GuardedPayload, signal: AbortSignal): Promise<unknown>;
  closeSession(sessionId: string): Promise<void>;
}

/** A failed step call, described only by the gateway's closed-vocabulary error envelope (its code
 * and, for MODEL_UNAVAILABLE, the reason) plus `Retry-After`. Never free text from the response,
 * so `detail` is safe to show in the panel. */
export class StepFailedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    /** The gateway's own `retryable` flag (its error envelope), and its `Retry-After` in seconds. */
    readonly retryable = false,
    readonly retryAfterS?: number,
  ) {
    super(`STEP_FAILED: ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'StepFailedError';
  }
}

const ERROR_CODE = /^[A-Z_]{1,40}$/;
// The reason, plus the gateway's optional detail: built only from numbers, HTTP statuses and
// the upstream's `[a-z_]` error code (e.g. "upstream_too_large (input 9046 tokens > limit 7000 per
// minute)", "upstream_auth (401 invalid_api_key)"), and matched here against that same alphabet.
const UNAVAILABLE_REASON = /^Model unavailable: ([a-z0-9_]{1,30})(?: \(([a-z0-9_ >]{1,60})\))?$/;

async function stepFailure(response: Response): Promise<StepFailedError> {
  const parts: string[] = [];
  let retryable = false;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown; retryable?: unknown } };
    retryable = body.error?.retryable === true;
    const code = body.error?.code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) {
      parts.push(code);
      const message = body.error?.message;
      const match = typeof message === 'string' ? UNAVAILABLE_REASON.exec(message) : null;
      if (match?.[1]) parts.push(match[1]);
      if (match?.[2]) parts.push(`(${match[2]})`);
    }
  } catch {
    // Not the gateway's envelope (a proxy error page, an empty body): the status alone.
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
  if (hasRetryAfter) parts.push(`retry in ${Math.round(retryAfter)} s`);
  return new StepFailedError(response.status, parts.join(' '), retryable, hasRetryAfter ? retryAfter : undefined);
}

function defaultSessionCreate(browserName: 'chrome' | 'firefox'): SessionCreate {
  return {
    schema: 'AEGIS/1',
    client: {
      browser: browserName,
      extension_version: '0.1.0',
      backend: 'wasm',
      detectors: {},
      policy: `${defaultPolicy.id}@${defaultPolicy.version}`,
      capabilities: { l1_image: true, l2_crop: false, click_point: true },
    },
  };
}

/** design.md §4.1 (T-2.31) — "bearer token on every /v1 call." OQ-15 (docs/DECISIONS.md, still
 * open) leaves the finale's real provisioning model unresolved; `token` defaults to the same
 * `dev-token` the gateway's own `config.py` defaults `AEGIS_TOKEN` to, for local/demo use, and is
 * overridable at build time exactly like `GATEWAY_URL` above. */
export function createGatewayClient(baseUrl: string, browserName: 'chrome' | 'firefox', fetchImpl: typeof fetch = fetch, token = 'dev-token'): GatewayClient {
  const egress = createEgressClient(fetchImpl);

  return {
    async openSession() {
      const response = await fetchImpl(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(defaultSessionCreate(browserName)),
      });
      if (!response.ok) throw new Error(`SESSION_OPEN_FAILED: ${response.status}`);
      return (await response.json()) as SessionCreated;
    },

    async sendStep(sessionId, payload, signal) {
      const response = await egress.sendStep(payload, `${baseUrl}/v1/sessions/${sessionId}/steps`, signal, token);
      if (!response.ok) throw await stepFailure(response);
      return response.json();
    },

    async closeSession(sessionId) {
      await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    },
  };
}
