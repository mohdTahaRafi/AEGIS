// The client the side panel uses in a release build: no server between the extension and the model.
// Sessions and plan validation run on the device (`agent/`); a step's prompt goes straight to the
// model API with the user's own key (`model-client.ts`).
//
// Only a `GuardedPayload` is accepted — the brand plus a runtime WeakSet check that no cast can
// fake (brand.ts). Session open/close carry no page data.

import type { SessionCreated } from '@aegis/protocol';
import { createAgentEngine, type PlanCommentary } from '../agent/engine';
import { isBranded } from './brand';
import type { GatewayClient } from './gateway-client';
import { createModelClient, presetFor, type ModelClientDeps, type ModelConfig } from './model-client';

/** `onCommentary`: the model's reasoning line and notes after each valid plan (panel only).
 * `region`: the user's country code (engine.ts `EngineOptions.region`). */
export function createAgentClient(config: ModelConfig, deps: ModelClientDeps = {}, onCommentary?: (commentary: PlanCommentary) => void, region?: string): GatewayClient {
  const preset = presetFor(config);
  const engine = createAgentEngine(createModelClient(config, deps), config.model, { profile: preset.profile, grounding: preset.grounding, region }, onCommentary);
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
