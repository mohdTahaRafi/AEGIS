// design.md §9.1 / phase_2_spine.md §5.1, §5.7 (T-2.19, T-2.23) — the validator pipeline, in
// order, stopping at the first failure. This is architecture §2 P8 made code: "the server
// proposes, the client decides." The server is untrusted (architecture §10.2 models it as
// possibly malicious or compromised), so every one of these checks runs regardless of what the
// plan claims about itself.
//
// NFR-12 ("server output is data, never code") has no per-action field to check — it's an
// absence, not a rule: nothing in this codebase calls `eval`, `new Function`, or builds a `RegExp`
// or a selector from plan text. That is enforced by never writing such a code path, not by a
// runtime guard here.

import type { ActionPlan } from '@aegis/protocol';
import { validators } from '@aegis/protocol';
import type { HardDenialReasonCode } from '../../shared/errors';

export type ValidatorFailure =
  | { ok: false; reason: 'SCHEMA_INVALID'; detail: string }
  | { ok: false; reason: 'LEASE_EXPIRED' }
  | { ok: false; reason: HardDenialReasonCode; actionIndex: number };

export type ValidatorResult = { ok: true; plan: ActionPlan } | ValidatorFailure;

export interface HardDenialContext {
  /** Node id → entity, for nodes whose value carries one (design.md's `NodeValue` `presence`
   * kind) — from the last `SanitizedContext` sent, so the validator can recognise a CAPTCHA
   * target without re-deriving anything from the plan itself. */
  nodeEntities: ReadonlyMap<string, string>;
  /** Node ids belonging to the extension's own injected UI. Always empty in practice today —
   * `src/content/screen-graph/selection.ts` excludes `data-aegis-ignore` elements from the graph
   * before the model ever sees an id for one — but the hard-denial code path still needs to exist
   * and be tested (T-2.23's AC), not merely assumed unreachable. */
  extensionOwnedNodeIds: ReadonlySet<string>;
}

function checkHardDenials(plan: ActionPlan, context: HardDenialContext): ValidatorFailure | null {
  for (let i = 0; i < plan.actions.length; i += 1) {
    const action = plan.actions[i]!;

    // Phase 3: a `ref`-based `type` is no longer a hard denial — design.md §9.3's `resolveFor`
    // pipeline (host/actions/rehydrate.ts) decides it per-ref, per-target, per-origin, with a
    // specific failure code on refusal. A blanket denial here would make CRITICAL rehydration
    // (the feature the project exists for) impossible.

    if ('node' in action && typeof action.node === 'string') {
      if (context.nodeEntities.get(action.node) === 'CAPTCHA') {
        return { ok: false, reason: 'CAPTCHA_SOLVE', actionIndex: i };
      }
      if (context.extensionOwnedNodeIds.has(action.node)) {
        return { ok: false, reason: 'EXTENSION_UI_TARGET', actionIndex: i };
      }
    }
  }
  return null;
}

/**
 * Schema (already the closed set of ops `ActionPlan`'s JSON Schema allows — an unknown op is a
 * parse error here, never a dispatch) → step lease → hard denials. Op-specific policy and risk
 * gating (design.md §5.1 steps 3–4) happen downstream once a plan passes this pipeline; this
 * function only decides whether the plan is even eligible to proceed.
 */
export function validatePlan(rawPlan: unknown, currentStepId: string, context: HardDenialContext): ValidatorResult {
  const schemaResult = validators.actionPlan(rawPlan);
  if (!schemaResult.valid) {
    const detail = schemaResult.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    return { ok: false, reason: 'SCHEMA_INVALID', detail };
  }

  const plan = schemaResult.data;
  if (plan.step_id !== currentStepId) {
    return { ok: false, reason: 'LEASE_EXPIRED' };
  }

  const denial = checkHardDenials(plan, context);
  if (denial) return denial;

  return { ok: true, plan };
}
