// The client the side panel uses in a release build: no server between the extension and the model.
// Sessions and plan validation run on the device (`agent/`); a step's prompt goes straight to the
// model API with the user's own key (`model-client.ts`).
//
// Only a `GuardedPayload` is accepted — the brand plus a runtime WeakSet check that no cast can
// fake (brand.ts). Session open/close carry no page data.

import type { SessionCreated } from '@aegis/protocol';
import { createAgentEngine } from '../agent/engine';
import { isBranded } from './brand';
import type { GatewayClient } from './gateway-client';
import { createModelClient, type ModelClientDeps, type ModelConfig } from './model-client';

export function createAgentClient(config: ModelConfig, deps: ModelClientDeps = {}): GatewayClient {
  const engine = createAgentEngine(createModelClient(config, deps), config.model);
  return {
    async openSession(): Promise<SessionCreated> {
      return engine.openSession();
    },
    async sendStep(sessionId, payload, signal) {
      if (!isBranded(payload)) throw new Error('EGRESS_REFUSES_UNGUARDED_PAYLOAD');
      return engine.sendStep(sessionId, payload, signal);
    },
    async closeSession(sessionId) {
      engine.closeSession(sessionId);
    },
  };
}
