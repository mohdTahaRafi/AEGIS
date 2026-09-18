// architecture.md §5.4 / CLAUDE.md rule 3 — `fetch`/`XMLHttpRequest`/`WebSocket` exist **only**
// under src/host/egress/. This file is that one place. `scripts/check-no-network.ts` enforces the
// negative half (no network call anywhere else) today; T-2.46 adds the positive half (this folder
// must exist and be the sole caller).
//
// Accepts only a `GuardedPayload` (brand.ts): the type brand plus a runtime `WeakSet` check, so a
// value that merely *claims* (via an unsafe cast) to be guarded still gets refused for real.

import { isBranded, type GuardedPayload } from './brand';

export interface EgressClient {
  sendStep(payload: GuardedPayload, sessionUrl: string, signal?: AbortSignal, token?: string): Promise<Response>;
}

export function createEgressClient(fetchImpl: typeof fetch = fetch): EgressClient {
  return {
    async sendStep(payload, sessionUrl, signal, token) {
      if (!isBranded(payload)) {
        throw new Error('EGRESS_REFUSES_UNGUARDED_PAYLOAD');
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // design.md §4.1 / T-2.31: "bearer token on every /v1 call." `token` is optional here
      // rather than required — a real, previously-undiscovered gap this project's Phase 5
      // genuine end-to-end integration test caught: this client sent no Authorization header at
      // all against a real gateway (which requires one), so every real call would 401. Optional
      // keeps this file's own unit tests (which never asserted a header) passing while
      // `gateway-client.ts` now always supplies one for real callers.
      if (token) headers.authorization = `Bearer ${token}`;
      return fetchImpl(sessionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    },
  };
}
