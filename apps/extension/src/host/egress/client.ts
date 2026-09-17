// architecture.md §5.4 / CLAUDE.md rule 3 — `fetch`/`XMLHttpRequest`/`WebSocket` exist **only**
// under src/host/egress/. This file is that one place. `scripts/check-no-network.ts` enforces the
// negative half (no network call anywhere else) today; T-2.46 adds the positive half (this folder
// must exist and be the sole caller).
//
// Accepts only a `GuardedPayload` (brand.ts): the type brand plus a runtime `WeakSet` check, so a
// value that merely *claims* (via an unsafe cast) to be guarded still gets refused for real.

import { isBranded, type GuardedPayload } from './brand';

export interface EgressClient {
  sendStep(payload: GuardedPayload, sessionUrl: string, signal?: AbortSignal): Promise<Response>;
}

export function createEgressClient(fetchImpl: typeof fetch = fetch): EgressClient {
  return {
    async sendStep(payload, sessionUrl, signal) {
      if (!isBranded(payload)) {
        throw new Error('EGRESS_REFUSES_UNGUARDED_PAYLOAD');
      }
      return fetchImpl(sessionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    },
  };
}
