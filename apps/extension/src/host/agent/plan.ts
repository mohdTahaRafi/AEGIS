// design.md §12.3 — what the device does with the model's answer before the extension's own
// validator (host/actions/validator.ts) sees it: read it as a plan, map the prompt's aliases back to
// node ids, convert the model's click coordinates to viewport pixels, and check it against what
// this task was actually shown. The model is untrusted: json_object mode enforces nothing, so
// nothing here trusts the answer to follow the schema.

import type { SanitizedContext } from '@aegis/protocol';
import { validators } from '@aegis/protocol';
import { resolveAliases } from './prompt';

/** The answer could not be read as a valid plan, or named something this task was never shown. The
 * caller gives the model one corrective retry, then gives up with PLAN_INVALID. */
export class PlanError extends Error {
  /** The plan named an element or ref this task was never shown, so the corrective retry also gets
   * the page as text; a shape error needs only the model's own output and the error. */
  constructor(
    message: string,
    readonly needsPage = false,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

const BARE_REF = /^[A-Z_]+#[0-9]+$/;
const PLACEHOLDER = /⟪[A-Z_]+#[0-9]+⟫/;
const STOP_REASONS = ['captcha', 'blocked', 'cannot_proceed', 'unsafe'];
const STOP_DETAIL_MAX = 200;
const MODEL_KEYS = ['actions', 'risk_hint', 'stop_if', 'note'] as const;

type Action = Record<string, unknown>;
export interface RawPlan {
  step_id: string;
  plan_id: string;
  actions: Action[];
  [key: string]: unknown;
}

/** Turns a well-meant model answer into the wire plan shape. It never invents a node id, a ref or
 * an op; post-validation still rejects anything the session didn't send. */
export function normalizePlan(raw: unknown, stepId: string): RawPlan {
  let body = raw;
  if (Array.isArray(body)) body = { actions: body };
  else if (isRecord(body) && 'op' in body && !('actions' in body)) body = { actions: [body] };
  if (!isRecord(body) || !Array.isArray(body.actions)) throw new PlanError("model output has no 'actions' list");
  const plan: Record<string, unknown> = {};
  for (const key of MODEL_KEYS) if (key in body) plan[key] = body[key];
  plan.step_id = stepId;
  plan.plan_id = `p-${stepId.replace(/^s-/, '')}`;
  for (const action of plan.actions as unknown[]) {
    if (!isRecord(action)) continue;
    if (typeof action.ref === 'string' && BARE_REF.test(action.ref)) action.ref = `⟪${action.ref}⟫`;
    if (action.op === 'stop') normalizeStop(action);
  }
  return plan as RawPlan;
}

/** `stop` ends the task and touches nothing, so a free-text reason ("no username given") or an
 * over-long detail is kept as the detail rather than failing the whole plan. */
function normalizeStop(action: Action): void {
  const { reason } = action;
  if (typeof reason !== 'string' || !STOP_REASONS.includes(reason)) {
    if (typeof reason === 'string' && reason && !action.detail) action.detail = reason;
    action.reason = 'cannot_proceed';
  }
  const { detail } = action;
  if (detail !== undefined) {
    if (typeof detail === 'string' && detail.trim()) action.detail = detail.trim().slice(0, STOP_DETAIL_MAX);
    else delete action.detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The model answers click_point in its own grounding convention: both axes in 0-1000 units of the
 * image's LONG side (measured for qwen/qwen3.8-27b on Groq, n=4, max residual 4 px). The extension
 * executes in viewport CSS pixels. Converted here, before validation checks the point lies in the
 * image. */
function groundClickPoints(plan: RawPlan, image: NonNullable<SanitizedContext['image']>): void {
  const [rx, ry, rw, rh] = image.region;
  const unit = Math.max(rw, rh) / 1000;
  for (const action of plan.actions) {
    if (action.op !== 'click_point' || typeof action.x !== 'number' || typeof action.y !== 'number') continue;
    action.x = Math.round((rx + action.x * unit) * 10) / 10;
    action.y = Math.round((ry + action.y * unit) * 10) / 10;
  }
}

/** What this task has been shown so far: the union of node ids sent (minus any since removed), the
 * affordances last seen for each, every redaction ref sent, and the image regions of the last two
 * steps. A plan is checked against it, not against the model's say-so. */
export class AgentSession {
  lastStepId: string | null = null;
  readonly sentNodeIds = new Set<string>();
  readonly nodeAffordances = new Map<string, readonly string[]>();
  readonly sentRefs = new Set<string>();
  readonly recentImageRegions: { region: readonly number[]; w: number; h: number }[] = [];
  // Whether each field held text as of the latest step, and the literal text last typed into it: a
  // plan that types the same text into a field still holding it is a loop.
  private readonly nodeHasValue = new Map<string, boolean>();
  private readonly typedText = new Map<string, string>();

  constructor(
    readonly id: string,
    readonly model: string,
  ) {}

  applyStep(step: SanitizedContext): void {
    this.lastStepId = step.step_id;
    if (step.delta_of == null) {
      // The client sent the whole current page: node ids from earlier steps are gone.
      this.sentNodeIds.clear();
      this.nodeAffordances.clear();
      this.nodeHasValue.clear();
    }
    for (const node of step.nodes) {
      this.sentNodeIds.add(node.id);
      this.nodeAffordances.set(node.id, node.affordances);
      this.nodeHasValue.set(node.id, node.state.has_value === true);
    }
    for (const id of step.removed ?? []) {
      this.sentNodeIds.delete(id);
      this.nodeAffordances.delete(id);
      this.nodeHasValue.delete(id);
    }
    for (const redaction of step.redactions) if (redaction.ref) this.sentRefs.add(redaction.ref);
    if (step.image) {
      this.recentImageRegions.push({ region: step.image.region, w: step.viewport.w, h: step.viewport.h });
      this.recentImageRegions.splice(0, this.recentImageRegions.length - 2);
    }
  }

  /** The prompt's own example is `ENTITY#n`, and a model sometimes copies the stand-in word with the
   * right number (`ENTITY#5` for `USERNAME#5`). Sealed refs are numbered uniquely across a task, so
   * the number alone names the ref: mapped when exactly one sent ref carries it. Any other ref that
   * was not sent is left for `check` to refuse. */
  repairStandInRefs(plan: RawPlan): void {
    for (const action of plan.actions) {
      const stand = typeof action.ref === 'string' ? /^⟪ENTITY#(\d+)⟫$/.exec(action.ref) : null;
      if (!stand || this.sentRefs.has(action.ref as string)) continue;
      const matches = [...this.sentRefs].filter((ref) => ref.endsWith(`#${stand[1]}⟫`));
      if (matches.length === 1) action.ref = matches[0];
    }
  }

  recordTyped(plan: RawPlan): void {
    for (const action of plan.actions) {
      if (action.op === 'type' && typeof action.text === 'string' && typeof action.node === 'string') {
        this.typedText.set(action.node, action.text.trim());
      }
    }
  }

  /** Raises a `PlanError` with a short, specific message on the first violation. */
  check(plan: RawPlan): void {
    for (const action of plan.actions) {
      const { op } = action;
      const node = typeof action.node === 'string' ? action.node : undefined;
      if (node !== undefined && !this.sentNodeIds.has(node)) {
        throw new PlanError(`node '${node}' was not sent this session (or has since been removed)`, true);
      }
      if (op === 'type') {
        const { ref, text } = action;
        if (typeof ref === 'string') {
          if (!this.sentRefs.has(ref)) throw new PlanError(`ref '${ref}' was not sent this session`, true);
          if (!(this.nodeAffordances.get(node ?? '') ?? []).includes('type')) throw new PlanError(`node '${node}' does not have the 'type' affordance`, true);
        }
        if (typeof text === 'string') {
          if (PLACEHOLDER.test(text)) throw new PlanError('type.text must not contain a placeholder string', true);
          if (node !== undefined && this.nodeHasValue.get(node) && this.typedText.get(node) === text.trim()) {
            throw new PlanError(
              'this exact text was already typed into that field in an earlier step and the field still holds it: do not type it again; do the next thing the TASK needs (e.g. click the send/submit button) or finish with done',
              true,
            );
          }
        }
      }
      if (op === 'select' && typeof action.option === 'string' && PLACEHOLDER.test(action.option)) {
        throw new PlanError('select.option must not contain a placeholder string', true);
      }
      if (op === 'click_point') {
        const { x, y } = action as { x: number; y: number };
        const inside = this.recentImageRegions.some(({ region: [rx = 0, ry = 0, rw = 0, rh = 0], w, h }) => x >= 0 && x <= w && y >= 0 && y <= h && rx <= x && x <= rx + rw && ry <= y && y <= ry + rh);
        if (!inside) throw new PlanError('click_point does not lie within an image region sent in the last two steps', true);
      }
    }
  }
}

/** The model's JSON -> a plan valid for this step: shape, aliases, coordinates, the wire schema,
 * then the session check. Mutates nothing the caller keeps: `raw` is the model's own object. */
export function validateCandidatePlan(raw: unknown, session: AgentSession, step: SanitizedContext): RawPlan {
  const plan = normalizePlan(raw, step.step_id);
  resolveAliases(plan, step);
  if (step.image) groundClickPoints(plan, step.image);
  const result = validators.actionPlan(plan);
  if (!result.valid) {
    throw new PlanError(`schema: ${result.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`);
  }
  session.repairStandInRefs(plan);
  session.check(plan);
  return plan;
}
