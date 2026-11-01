// design.md §12.3 — what the device does with the model's answer before the extension's own
// validator (host/actions/validator.ts) sees it: read it as a plan, map the prompt's aliases back to
// node ids, convert the model's click coordinates to viewport pixels, and check it against what
// this task was actually shown. The model is untrusted: json_object mode enforces nothing, so
// nothing here trusts the answer to follow the schema.

import type { SanitizedContext } from '@aegis/protocol';
import { validators } from '@aegis/protocol';
import type { Grounding } from '../egress/providers';
import { NOTES_MAX_CHARS, resolveAliases } from './prompt';

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
const MODEL_KEYS = ['actions', 'risk_hint', 'stop_if'] as const;
const MAX_ACTIONS = 5;
const NOTE_MAX = 200;
// Ops models commonly write for the ones this protocol has.
const OP_ALIASES: Record<string, string> = {
  fill: 'type',
  input: 'type',
  type_text: 'type',
  enter_text: 'type',
  goto: 'navigate',
  go_to: 'navigate',
  open_url: 'navigate',
  open: 'navigate',
  new_tab: 'open_tab',
  back: 'go_back',
  forward: 'go_forward',
  refresh: 'reload',
  keypress: 'press_key',
  key: 'press_key',
  press: 'press_key',
  answer: 'report',
  respond: 'report',
  finish: 'done',
  complete: 'done',
  ask: 'ask_user',
  select_option: 'select',
  dblclick: 'double_click',
  sleep: 'wait',
  find_text: 'find',
  search_page: 'find',
  find_in_page: 'find',
  scroll_to: 'find',
  read: 'read_page',
  read_full_page: 'read_page',
  get_page_text: 'read_page',
  switch: 'switch_tab',
  focus_tab: 'switch_tab',
  select_tab: 'switch_tab',
};
// Longest strings the wire schema accepts; a longer one is cut, not a reason to refuse the plan.
const MAX_CHARS: Record<string, Record<string, number>> = {
  type: { text: 2000 },
  select: { option: 200 },
  click_point: { label: 80 },
  report: { title: 80, content: 4000 },
  ask_user: { question: 300 },
  done: { summary: 300 },
  find: { text: 200 },
};

/** One sub-goal of the task, in the checklist the model keeps (and the device enforces). */
export interface ChecklistItem {
  id: number;
  item: string;
  status: 'todo' | 'done' | 'skipped';
  /** What was found, or why the item was skipped. */
  result?: string;
}

/** A change the model sent for one checklist item: a new item, or a status/result for one. */
export interface ChecklistUpdate {
  id?: number;
  item?: string;
  status?: ChecklistItem['status'];
  result?: string;
}

const CHECKLIST_MAX_ITEMS = 12;
const CHECKLIST_ITEM_CHARS = 100;
const CHECKLIST_RESULT_CHARS = 120;

/** What the model wrote besides its actions: a short reasoning line, its own memory and changes to
 * its checklist. */
export interface PlanExtras {
  thought?: string;
  notes?: string;
  checklist?: ChecklistUpdate[];
}

function checklistStatus(value: unknown): ChecklistItem['status'] | undefined {
  if (value === true) return 'done';
  if (value === false) return 'todo';
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (/^(done|complete|completed|finished|ok|yes|x|✓|✔)$/.test(v)) return 'done';
  if (/^(skip|skipped|failed|blocked|n\/a|na|not possible|impossible|cannot|unavailable)$/.test(v)) return 'skipped';
  if (/^(todo|to do|open|pending|in progress|in_progress|next|not done|no)$/.test(v)) return 'todo';
  return undefined;
}

/** Reads the model's checklist changes: a list of strings (new items) or of objects with an id,
 * the item's text, a status and a result, under any of the names models commonly use. */
function readChecklist(value: unknown): ChecklistUpdate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ChecklistUpdate[] = [];
  for (const entry of value.slice(0, 30)) {
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ item: entry.trim().slice(0, CHECKLIST_ITEM_CHARS) });
      continue;
    }
    if (!isRecord(entry)) continue;
    const update: ChecklistUpdate = {};
    const id = typeof entry.id === 'number' ? entry.id : typeof entry.id === 'string' ? Number(entry.id) : NaN;
    if (Number.isInteger(id) && id > 0) update.id = id;
    const text = entry.item ?? entry.task ?? entry.text ?? entry.title ?? entry.step ?? entry.goal;
    if (typeof text === 'string' && text.trim()) update.item = text.trim().slice(0, CHECKLIST_ITEM_CHARS);
    const status = checklistStatus(entry.status ?? entry.state ?? entry.done);
    if (status) update.status = status;
    const result = entry.result ?? entry.note ?? entry.value ?? entry.reason ?? entry.found;
    if (typeof result === 'string' && result.trim()) update.result = result.trim().slice(0, CHECKLIST_RESULT_CHARS);
    if (update.id !== undefined || update.item !== undefined) out.push(update);
  }
  return out.length > 0 ? out : undefined;
}

/** Reads the model's `thought` and `notes` (both optional, free text the model wrote about a
 * sanitized page) and returns them; they are kept out of the wire plan, whose schema has no room
 * for them (only the thought goes on, as the plan's 200-character `note`). */
export function extractExtras(raw: unknown): PlanExtras {
  if (!isRecord(raw)) return {};
  const out: PlanExtras = {};
  const thought = raw.thought ?? raw.reasoning;
  if (typeof thought === 'string' && thought.trim()) out.thought = thought.trim().slice(0, 600);
  const notes = raw.notes ?? raw.memory ?? raw.progress;
  if (typeof notes === 'string' && notes.trim()) out.notes = notes.trim().slice(0, NOTES_MAX_CHARS);
  else if (Array.isArray(notes)) out.notes = notes.filter((n) => typeof n === 'string').join('\n').slice(0, NOTES_MAX_CHARS) || undefined;
  const checklist = readChecklist(raw.checklist ?? raw.plan ?? raw.todo ?? raw.todos);
  if (checklist) out.checklist = checklist;
  return out;
}

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
  else if (isRecord(body) && !('actions' in body) && Array.isArray(body.action)) body = { ...body, actions: body.action };
  if (!isRecord(body) || !Array.isArray(body.actions)) throw new PlanError("model output has no 'actions' list");
  const plan: Record<string, unknown> = {};
  for (const key of MODEL_KEYS) if (key in body) plan[key] = body[key];
  plan.step_id = stepId;
  plan.plan_id = `p-${stepId.replace(/^s-/, '')}`;
  const { thought } = extractExtras(body);
  const note = thought ?? (typeof body.note === 'string' ? body.note : undefined);
  if (note) plan.note = note.slice(0, NOTE_MAX);
  const actions: unknown[] = [];
  for (const action of body.actions as unknown[]) {
    if (!isRecord(action)) {
      actions.push(action);
      continue;
    }
    if (typeof action.op === 'string') {
      const op = action.op.trim().toLowerCase();
      action.op = OP_ALIASES[op] ?? op;
    }
    // An observation request needs nothing done: the next step observes anyway.
    if (action.op === 'request_observation') continue;
    if (typeof action.ref === 'string' && BARE_REF.test(action.ref)) action.ref = `⟪${action.ref}⟫`;
    if (action.op === 'stop') normalizeStop(action);
    if (action.op === 'scroll' && typeof action.direction === 'string') action.direction = action.direction.toLowerCase();
    if (action.op === 'find' && action.text === undefined && typeof action.query === 'string') {
      action.text = action.query;
      delete action.query;
    }
    if (action.op === 'switch_tab' || action.op === 'close_tab') {
      if (action.tab === undefined && action.index !== undefined) {
        action.tab = action.index;
        delete action.index;
      }
      if (typeof action.tab === 'string' && /^\d+$/.test(action.tab.trim())) action.tab = Number(action.tab.trim());
    }
    for (const [field, max] of Object.entries(MAX_CHARS[action.op as string] ?? {})) {
      const value = action[field];
      if (typeof value === 'string' && value.length > max) action[field] = value.slice(0, max);
    }
    actions.push(action);
  }
  if (actions.length === 0) throw new PlanError('the plan has no actions left to run');
  // More than the schema allows: the first ones are run, and the next step continues.
  plan.actions = actions.slice(0, MAX_ACTIONS);
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

/** The model answers click_point in its own grounding convention (providers.ts `Grounding`):
 * `norm1000-long` = both axes in 0-1000 units of the image's LONG side (measured for
 * qwen/qwen3.8-27b on Groq, n=4, max residual 4 px); `norm1000-axis` = x in 0-1000 of the width
 * and y in 0-1000 of the height; `image-px` = pixels of the image as sent,
 * which is the viewport scaled by `image.scale`. The extension executes in viewport CSS pixels.
 * Converted here, before validation checks the point lies in the image. */
function groundClickPoints(plan: RawPlan, image: NonNullable<SanitizedContext['image']>, grounding: Grounding): void {
  const [rx, ry, rw, rh] = image.region;
  const [ux, uy] =
    grounding === 'image-px' ? [1 / (image.scale || 1), 1 / (image.scale || 1)] : grounding === 'norm1000-axis' ? [rw / 1000, rh / 1000] : [Math.max(rw, rh) / 1000, Math.max(rw, rh) / 1000];
  for (const action of plan.actions) {
    if (action.op !== 'click_point' || typeof action.x !== 'number' || typeof action.y !== 'number') continue;
    action.x = Math.round((rx + action.x * ux) * 10) / 10;
    action.y = Math.round((ry + action.y * uy) * 10) / 10;
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
  /** The model's own memory, from its last valid answer: fed back on the next step. */
  notes = '';
  /** The task's sub-goals as the model wrote them. Items can be added and their status changed,
   * never removed: the model cannot quietly drop a sub-goal it planned (`unfinished`). */
  readonly checklist: ChecklistItem[] = [];
  /** Valid plans returned so far: the first one is the planning step. */
  answered = 0;

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

  /** Merges the model's checklist changes: an update names its item by id (or by the same text),
   * and an item the update does not mention keeps its state. */
  applyChecklist(updates: readonly ChecklistUpdate[] | undefined): void {
    if (!updates) return;
    const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const update of updates) {
      const byId = update.id !== undefined ? this.checklist.find((i) => i.id === update.id) : undefined;
      // An id whose item has different text is a renumbered list, not the same item.
      const sameItem = byId && (!update.item || norm(update.item) === norm(byId.item) || norm(byId.item).includes(norm(update.item)) || norm(update.item).includes(norm(byId.item)));
      const existing = sameItem ? byId : update.item ? this.checklist.find((i) => norm(i.item) === norm(update.item!)) : undefined;
      if (existing) {
        if (update.status) existing.status = update.status;
        if (update.result) existing.result = update.result;
        continue;
      }
      if (!update.item || this.checklist.length >= CHECKLIST_MAX_ITEMS) continue;
      const id = this.checklist.reduce((max, i) => Math.max(max, i.id), 0) + 1;
      this.checklist.push({ id, item: update.item, status: update.status ?? 'todo', ...(update.result ? { result: update.result } : {}) });
    }
  }

  /** The checklist items still to do. */
  unfinished(): ChecklistItem[] {
    return this.checklist.filter((i) => i.status === 'todo');
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
export function validateCandidatePlan(raw: unknown, session: AgentSession, step: SanitizedContext, grounding: Grounding = 'norm1000-long'): RawPlan {
  const plan = normalizePlan(raw, step.step_id);
  resolveAliases(plan, step);
  if (step.image) groundClickPoints(plan, step.image, grounding);
  const result = validators.actionPlan(plan);
  if (!result.valid) {
    throw new PlanError(`schema: ${result.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`);
  }
  session.repairStandInRefs(plan);
  session.check(plan);
  return plan;
}
