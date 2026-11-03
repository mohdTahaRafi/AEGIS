// design.md §4.1/§12.3 — one guarded observation in, one validated plan out, on the device. This is
// what the server gateway used to do: lease ordering, the prompt, the model call, post-validation
// with one corrective retry. It never touches the network itself — the model is a `ModelClient`
// (host/egress/model-client.ts is the only implementation that does).

import type { SanitizedContext, SessionCreated } from '@aegis/protocol';
import { ModelRequestTooLarge, planInvalid, sessionNotFound, stepOutOfOrder, unsanitizedContext } from './errors';
import type { Grounding, PromptProfile } from '../egress/providers';
import { AgentSession, PlanError, extractExtras, validateCandidatePlan, type ChecklistItem, type RawPlan } from './plan';
import { SYSTEM_PROMPTS, buildMessages, buildUserMessage, renderChecklist, type ChatMessage } from './prompt';
import { detectSituations, type SituationId } from './situations';
import { findUnsanitized } from './tripwire';

/** Which model a step needs: `smart` for planning and recovering (fewer free requests, better
 * judgement), `fast` for routine steps. A source without a smarter model treats both alike. */
export type ModelTier = 'fast' | 'smart';

/** The model-call surface the engine needs; `host/egress/model-client.ts` implements it. */
export interface PlanSource {
  complete(messages: readonly ChatMessage[], signal?: AbortSignal, tier?: ModelTier): Promise<unknown>;
  /** The model that produced the last answer, for the panel. */
  lastModel?(): string | undefined;
}

// The last step's outcome says the agent is off course: a failed or refused action, a page that did
// not change, a repeated plan or a rejected reply. The next step is planned by the smart model.
const OFF_COURSE = /FAILED_|failed|no visible change|rejected|same plan|NOT repeated|REHYDRATE_|refused|declined|blocked/i;

/** The first step plans the whole task (it writes the checklist); a step after trouble re-plans,
 * and so does one whose page shows its work failed (a wrong answer to fix). Everything else is
 * routine. */
function tierFor(step: SanitizedContext, session: AgentSession, situations: readonly SituationId[]): ModelTier {
  if (session.answered === 0 || situations.includes('failed_result')) return 'smart';
  const last = step.history?.at(-1)?.outcome ?? '';
  return OFF_COURSE.test(last) ? 'smart' : 'fast';
}

/** `done` while the checklist still has todo items is refused: the model planned those sub-goals,
 * and finishing without them (or without saying why they cannot be done) is how a "compare three
 * shops" task ended after two. */
function refuseUnfinishedDone(plan: RawPlan, open: readonly ChecklistItem[]): void {
  if (open.length === 0 || !plan.actions.some((a) => a.op === 'done')) return;
  const items = open.map((i) => `${i.id}. ${i.item}`).join('; ');
  throw new PlanError(`done refused: checklist items still todo: ${items}. Do them now, or mark each one skipped with the reason in "checklist"`, true);
}

// A 413 "too many input tokens" costs no quota (the API refuses it before running the model), so
// rebuilding the prompt smaller is cheap. Each rebuild keeps FIT_MARGIN * limit / requested of the
// element/text caps; the fixed part (system prompt, image) does not shrink, hence a second rebuild
// with the new numbers when the first still does not fit.
const MAX_FIT_REBUILDS = 2;
const FIT_MARGIN = 0.85;
const MIN_FIT = 0.1;
const MAX_STEPS = 50;
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
function retryMessages(step: SanitizedContext, previous: unknown, error: PlanError, fit: number, options: EngineOptions, notes: string, checklist: readonly ChecklistItem[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPTS[options.profile] },
    {
      role: 'user',
      content: error.needsPage
        ? buildUserMessage(step, { fit, profile: options.profile, notes, checklist, grounding: options.grounding, region: options.region })
        : `TASK: ${step.task}\n${renderChecklist(checklist)}NOTES: ${notes || '(none)'}`,
    },
    { role: 'assistant', content: JSON.stringify(previous ?? null).slice(0, 2000) },
    { role: 'user', content: `Your previous output was invalid: ${error.message}. Reply with only the corrected JSON object.` },
  ];
}

export interface EngineOptions {
  profile: PromptProfile;
  grounding: Grounding;
  /** ISO 3166 alpha-2 country from the browser's language (prompt.ts `PromptOptions.region`). */
  region?: string;
}

/** What the model wrote alongside a valid plan, for the panel (never sent anywhere). */
export interface PlanCommentary {
  thought?: string;
  notes?: string;
  /** The checklist after this answer, rendered. */
  checklist?: string;
  /** Which model answered, and whether the step was routed to the smart one. */
  model?: string;
  tier?: ModelTier;
  /** The situation rules this step's prompt carried (situations.ts). */
  situations?: SituationId[];
}

export interface AgentEngine {
  openSession(): SessionCreated;
  /** Resolves to the validated wire plan (`ActionPlan` shape); rejects with a `StepFailedError`. */
  sendStep(sessionId: string, step: SanitizedContext, signal?: AbortSignal): Promise<RawPlan>;
  closeSession(sessionId: string): void;
}

export function createAgentEngine(source: PlanSource, modelName: string, options: EngineOptions = { profile: 'compact', grounding: 'norm1000-long' }, onCommentary?: (commentary: PlanCommentary) => void): AgentEngine {
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
      const promptFor = (f: number) => buildMessages(step, { fit: f, profile: options.profile, notes: session.notes, checklist: session.checklist, grounding: options.grounding, region: options.region });
      let messages = promptFor(fit);
      let lastRaw: unknown;
      let extras: ReturnType<typeof extractExtras> = {};
      const situations = detectSituations(step, options.profile).map((s) => s.id);
      let tier = tierFor(step, session, situations);
      const attempt = async (attemptMessages: readonly ChatMessage[]): Promise<RawPlan> => {
        const raw = await source.complete(attemptMessages, signal, tier);
        // Kept as the model wrote it: validation normalizes in place, and the corrective retry
        // quotes the original back.
        lastRaw = structuredClone(raw);
        extras = extractExtras(raw);
        // Applied even when the plan is then refused: the statuses are the model's latest view.
        session.applyChecklist(extras.checklist);
        const plan = validateCandidatePlan(raw, session, step, options.grounding);
        refuseUnfinishedDone(plan, session.unfinished());
        return plan;
      };
      const firstAttempt = async (): Promise<RawPlan> => {
        for (let rebuild = 0; ; rebuild++) {
          try {
            return await attempt(messages);
          } catch (err) {
            const smaller = err instanceof ModelRequestTooLarge && rebuild < MAX_FIT_REBUILDS ? smallerFit(fit, err) : null;
            if (smaller === null) throw err;
            fit = smaller;
            messages = promptFor(fit);
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
          // A correction is judgement work: the smart model makes it.
          tier = 'smart';
          try {
            plan = await attempt(retryMessages(step, lastRaw, firstError, fit, options, session.notes, session.checklist));
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
      session.answered += 1;
      if (extras.notes) session.notes = extras.notes;
      onCommentary?.({
        thought: extras.thought,
        notes: extras.notes,
        checklist: session.checklist.length > 0 ? renderChecklist(session.checklist).replace(/^CHECKLIST[^\n]*\n/, '').trim() : undefined,
        model: source.lastModel?.(),
        tier,
        situations: situations.length > 0 ? situations : undefined,
      });
      return plan;
    },
  };
}
