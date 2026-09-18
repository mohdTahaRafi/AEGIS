// design.md §4.1 (T-2.31/T-2.32 client side) — session open/close carry **no page data**
// (architecture §8.1), so they bypass the guard entirely; only the per-step payload goes through
// `EgressClient.sendStep`, which refuses anything not `GuardedPayload`-branded.
//
// `client`'s detector/backend/capability fields describe machinery Phase 4 builds (the perception
// worker, WebGPU/WASM backend selection) — Phase 2 has none of it running yet, so these are
// honest placeholders, not a real capability probe.

import type { SessionCreate, SessionCreated } from '@aegis/protocol';
import { createEgressClient } from './client';
import type { GuardedPayload } from './brand';

export interface GatewayClient {
  openSession(): Promise<SessionCreated>;
  sendStep(sessionId: string, payload: GuardedPayload, signal: AbortSignal): Promise<unknown>;
  closeSession(sessionId: string): Promise<void>;
}

function defaultSessionCreate(browserName: 'chrome' | 'firefox'): SessionCreate {
  return {
    schema: 'AEGIS/1',
    client: {
      browser: browserName,
      extension_version: '0.1.0',
      backend: 'wasm',
      detectors: {},
      policy: 'phase2-none',
      capabilities: { l1_image: false, l2_crop: false, click_point: true },
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
      if (!response.ok) throw new Error(`STEP_FAILED: ${response.status}`);
      return response.json();
    },

    async closeSession(sessionId) {
      await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    },
  };
}
