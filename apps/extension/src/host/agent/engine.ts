// design.md §4.1/§12.3 — one guarded observation in, one validated plan out, on the device. This is
// what the server gateway used to do: lease ordering, the prompt, the model call, post-validation
// with one corrective retry. It never touches the network itself — the model is a `ModelClient`
// (host/egress/model-client.ts is the only implementation that does).

import type { SanitizedContext, SessionCreated } from '@aegis/protocol';
import { ModelRequestTooLarge, planInvalid, sessionNotFound, stepOutOfOrder, unsanitizedContext } from './errors';
import { AgentSession, PlanError, validateCandidatePlan, type RawPlan } from './plan';
import { SYSTEM_PROMPT, buildMessages, buildUserMessage, type ChatMessage } from './prompt';
import { findUnsanitized } from './tripwire';

/** The model-call surface the engine needs; `host/egress/model-client.ts` implements it. */
export interface PlanSource {
  complete(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<unknown>;
}

// A 413 "too many input tokens" costs no quota (the API refuses it before running the model), so
// rebuilding the prompt smaller is cheap. Each rebuild keeps FIT_MARGIN * limit / requested of the
// element/text caps; the fixed part (system prompt, image) does not shrink, hence a second rebuild
// with the new numbers when the first still does not fit.
const MAX_FIT_REBUILDS = 2;
const FIT_MARGIN = 0.85;
const MIN_FIT = 0.1;
const MAX_STEPS = 30;
const MAX_IMAGE_PX = 1_600_000;

function smallerFit(fit: number, error: ModelRequestTooLarge): number | null {
  if (!error.limit || !error.requested || fit <= MIN_FIT) return null;
  return Math.max(MIN_FIT, (fit * FIT_MARGIN * error.limit) / error.requested);
}

const stepNumber = (stepId: string): number => Number(stepId.split('-', 2)[1]);

/** The one corrective retry, sized for a per-minute token budget the first call has mostly used
 * (resending the image got HTTP 413 on the free tier). A shape error needs only the model's own
 * output and the error; a plan that named a wrong element or ref also gets the page as text (never
 * the image again). */
function retryMessages(step: SanitizedContext, previous: unknown, error: PlanError, fit: number): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: error.needsPage ? buildUserMessage(step, { fit }) : `TASK: ${step.task}` },
    { role: 'assistant', content: JSON.stringify(previous ?? null).slice(0, 2000) },
    { role: 'user', content: `Your previous output was invalid: ${error.message}. Reply with only the corrected JSON object.` },
  ];
}

export interface AgentEngine {
  openSession(): SessionCreated;
  /** Resolves to the validated wire plan (`ActionPlan` shape); rejects with a `StepFailedError`. */
  sendStep(sessionId: string, step: SanitizedContext, signal?: AbortSignal): Promise<RawPlan>;
  closeSession(sessionId: string): void;
}

export function createAgentEngine(source: PlanSource, modelName: string): AgentEngine {
  const sessions = new Map<string, AgentSession>();

  return {
    openSession() {
      const session = new AgentSession(crypto.randomUUID(), modelName);
      sessions.set(session.id, session);
      return { session_id: session.id, model: modelName, mode: 'live', limits: { max_steps: MAX_STEPS, max_image_px: MAX_IMAGE_PX } };
    },

    closeSession(sessionId) {
      sessions.delete(sessionId);
    },

    async sendStep(sessionId, step, signal) {
      const session = sessions.get(sessionId);
      if (!session) throw sessionNotFound();
      if (session.lastStepId !== null && stepNumber(step.step_id) <= stepNumber(session.lastStepId)) throw stepOutOfOrder();
      const leaked = findUnsanitized(step);
      if (leaked.length > 0) throw unsanitizedContext(leaked);

      const previousStepId = session.lastStepId;
      // Applied *before* the model is asked: the plan it returns reacts to exactly this context, so
      // it is checked against the nodes/refs/affordances as of *this* step, not just prior ones.
      session.applyStep(step);

      let fit = 1;
      let messages = buildMessages(step);
      let lastRaw: unknown;
      const attempt = async (attemptMessages: readonly ChatMessage[]): Promise<RawPlan> => {
        const raw = await source.complete(attemptMessages, signal);
        // Kept as the model wrote it: validation normalizes in place, and the corrective retry
        // quotes the original back.
        lastRaw = structuredClone(raw);
        return validateCandidatePlan(raw, session, step);
      };
      const firstAttempt = async (): Promise<RawPlan> => {
        for (let rebuild = 0; ; rebuild++) {
          try {
            return await attempt(messages);
          } catch (err) {
            const smaller = err instanceof ModelRequestTooLarge && rebuild < MAX_FIT_REBUILDS ? smallerFit(fit, err) : null;
            if (smaller === null) throw err;
            fit = smaller;
            messages = buildMessages(step, { fit });
          }
        }
      };

      let plan: RawPlan;
      try {
        try {
          plan = await firstAttempt();
        } catch (firstError) {
          if (!(firstError instanceof PlanError)) throw firstError;
          // A user turn, not a second system message: several hosted endpoints accept only one
          // system message, at the start. The model already saw this step's screenshot, so the
          // retry sends the page as text and the rejected output, never the image again.
          try {
            plan = await attempt(retryMessages(step, lastRaw, firstError, fit));
          } catch (secondError) {
            if (secondError instanceof PlanError) throw planInvalid(secondError.message);
            throw secondError;
          }
        }
      } catch (err) {
        // This step produced nothing: release its lease so the client may re-send the same step.
        session.lastStepId = previousStepId;
        throw err;
      }
      session.recordTyped(plan);
      return plan;
    },
  };
}
