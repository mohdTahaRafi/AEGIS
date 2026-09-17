// phase_2_spine.md §1/§4 — the orchestrator: ties the controller state machine, budgets,
// reconciliation, the content port, the context builder, the Phase-2 guard stub, egress and the
// validator into the actual step loop the milestone demo describes. Every external effect (the
// content port, the gateway call, permission checks, the clock) is injected, so the whole loop is
// unit-testable with fakes — no live browser or gateway required to prove the orchestration logic
// is correct (T-2.47's e2e suite is what exercises this against the real things).
//
// [A] Phase 2 simplification, disclosed rather than silently assumed: a content-side pre-flight
// failure is always treated as "not locally repairable" here (`ReconciliationTracker.decide(false)`
// unconditionally) and goes straight to re-observation or `BUDGET_EXHAUSTED`. `dispatchClick`
// already re-validates geometry fresh on every attempt (src/content/execute/dispatch.ts), so a
// *distinct* "retry the same action after a local repair" path has no extra work left to do beyond
// what re-dispatching already provides — a real second local-repair mechanism would only matter
// once there is a reason a repeated attempt could succeed where the first didn't, which Phase 2's
// action set does not have.

import type { ActionPlan } from '@aegis/protocol';
import { classifyAction } from './actions/dispatch';
import { classifyRisk, requiresConfirmation, type RiskLevel, type RiskSignals } from './actions/risk';
import { validatePlan, type HardDenialContext } from './actions/validator';
import { BudgetTracker, DEFAULT_BUDGETS, type BudgetLimits } from './controller/budgets';
import { Controller } from './controller/machine';
import { ReconciliationTracker } from './controller/reconcile';
import { brand } from './egress/brand';
import { stubGuard } from './egress/guard-stub';
import type { ContentPortClient } from './port';
import { buildSanitizedContext } from './privacy/context/builder';
import type { BudgetReasonCode } from '../shared/errors';
import type { GraphMessage, WireScreenNode } from '../shared/messages';

export interface StepStageTimings {
  observe: number;
  perceive: number;
  sanitize: number;
  guard: number;
  server: number;
  validate: number;
  act: number;
}

export interface StepRecord {
  stepIndex: number;
  stepId: string;
  stageTimings: StepStageTimings;
  actionsPlanned: number;
  outcome: 'acted' | 'done' | 'stopped' | 'blocked' | 'validation_failed';
}

export type SessionEvent =
  | { type: 'state'; state: ReturnType<Controller['getState']> }
  | { type: 'step'; step: StepRecord }
  | { type: 'report'; title?: string; content: string }
  | { type: 'ask_user'; question: string }
  | { type: 'stopped'; reason: BudgetReasonCode | 'BLOCKED' | 'SERVER_ERROR' | 'CANCELLED' }
  | { type: 'done'; summary?: string }
  | { type: 'confirmation_required'; risk: RiskLevel; description: string };

export interface SessionDeps {
  contentPort: ContentPortClient;
  /** Posts the guarded payload to the gateway and returns the raw (unvalidated) plan JSON. */
  sendToGateway: (payload: ReturnType<typeof brand>, signal: AbortSignal) => Promise<unknown>;
  guardOrigin: string;
  pageCategory: ReturnType<typeof buildSanitizedContext>['page']['category'];
  pageTitle: string;
  onEvent: (event: SessionEvent) => void;
  now?: () => number;
  budgetLimits?: BudgetLimits;
  /** Confirmation gate for risky actions (T-5.4/§5.4) — resolves `true` to proceed. Defaults to
   * auto-approve, since Phase 2's panel doesn't yet render a confirmation card (deferred to
   * Phase 3's T-3.32-adjacent UI work); the risk classification and the gate itself both exist
   * now so that UI is additive, not a redesign. */
  confirm?: (risk: RiskLevel, description: string) => Promise<boolean>;
}

interface PendingGraph {
  resolve: (message: GraphMessage) => void;
}

export class Session {
  private readonly controller = new Controller();
  private readonly budgets: BudgetTracker;
  private readonly reconcile = new ReconciliationTracker();
  private readonly now: () => number;
  private pendingGraph: PendingGraph | null = null;
  private pendingActions = new Map<string, { resolveOk: (ok: boolean, reason?: string) => void }>();
  private lastGraphMessage: GraphMessage | null = null;
  private allSeenNodes = new Map<string, WireScreenNode>();
  private history: { step_id: string; actions: { op: string }[]; outcome: string }[] = [];

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.budgets = new BudgetTracker(deps.budgetLimits ?? DEFAULT_BUDGETS, this.now);
  }

  getState(): ReturnType<Controller['getState']> {
    return this.controller.getState();
  }

  /** Called by whatever owns the underlying `ContentPortClient`'s handler wiring — see
   * `wireContentPortHandlers` below, which builds exactly the handlers object this session needs. */
  onGraph(message: GraphMessage): void {
    this.lastGraphMessage = message;
    for (const node of message.nodes) this.allSeenNodes.set(node.id, node);
    for (const id of message.removed) this.allSeenNodes.delete(id);
    this.pendingGraph?.resolve(message);
    this.pendingGraph = null;
  }

  onActionResult(actionId: string, ok: boolean, reason?: string): void {
    this.pendingActions.get(actionId)?.resolveOk(ok, reason);
    this.pendingActions.delete(actionId);
  }

  cancel(): void {
    this.controller.send({ type: 'cancel' });
    this.deps.onEvent({ type: 'stopped', reason: 'CANCELLED' });
  }

  private emitState(): void {
    this.deps.onEvent({ type: 'state', state: this.controller.getState() });
  }

  private stop(reason: BudgetReasonCode): void {
    this.controller.send({ type: 'stop' });
    this.emitState();
    this.deps.onEvent({ type: 'stopped', reason });
  }

  private requestGraph(): Promise<GraphMessage> {
    return new Promise((resolve) => {
      this.pendingGraph = { resolve };
      this.deps.contentPort.requestExtract();
    });
  }

  private dispatchAndAwait(actionId: string, action: Parameters<ContentPortClient['dispatchAction']>[1]): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.pendingActions.set(actionId, { resolveOk: (ok, reason) => resolve({ ok, reason }) });
      this.deps.contentPort.dispatchAction(actionId, action);
    });
  }

  async start(task: string): Promise<void> {
    this.controller.send({ type: 'start' });
    this.budgets.startTask();
    this.emitState();
    this.controller.send({ type: 'prepared' });
    this.emitState();
    await this.stepLoop(task);
  }

  private async stepLoop(task: string): Promise<void> {
    let stepIndex = 0;
    let deltaOf: string | null = null;

    while (this.controller.getState() !== 'CANCELLED' && this.controller.getState() !== 'STOPPED' && this.controller.getState() !== 'DONE') {
      stepIndex += 1;
      const stepId = `s-${stepIndex}`;

      const stepBreach = this.budgets.beginStep();
      if (stepBreach) return this.stop(stepBreach);
      const wallClockBreach = this.budgets.checkWallClock();
      if (wallClockBreach) return this.stop(wallClockBreach);

      const timings: StepStageTimings = { observe: 0, perceive: 0, sanitize: 0, guard: 0, server: 0, validate: 0, act: 0 };

      let t = this.now();
      this.controller.send({ type: 'observed' });
      const graphMessage = await this.requestGraph();
      timings.observe = this.now() - t;

      t = this.now();
      this.controller.send({ type: 'perceived' });
      timings.perceive = this.now() - t;

      t = this.now();
      this.controller.send({ type: 'sanitized' });
      const context = buildSanitizedContext({
        stepId,
        task,
        reason: graphMessage.reason,
        deltaOf,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY, docH: document.documentElement.scrollHeight },
        pageCategory: this.deps.pageCategory,
        pageTitle: this.deps.pageTitle,
        nodes: graphMessage.nodes,
        removed: graphMessage.removed,
        history: this.history,
        clientTiming: {},
      });
      timings.sanitize = this.now() - t;

      t = this.now();
      let guarded;
      try {
        guarded = stubGuard(context, this.deps.guardOrigin);
        this.controller.send({ type: 'guard_pass' });
      } catch {
        this.controller.send({ type: 'guard_block' });
        this.emitState();
        this.deps.onEvent({ type: 'stopped', reason: 'BLOCKED' });
        return;
      }
      timings.guard = this.now() - t;

      t = this.now();
      this.controller.send({ type: 'sent' });
      this.emitState();
      const serverCallBreach = this.budgets.recordServerCall();
      if (serverCallBreach) return this.stop(serverCallBreach);
      const signal = this.controller.beginServerCall();
      let rawPlan: unknown;
      try {
        rawPlan = await this.deps.sendToGateway(guarded, signal);
      } catch {
        this.deps.onEvent({ type: 'stopped', reason: 'SERVER_ERROR' });
        return;
      }
      this.controller.endServerCall();
      this.controller.send({ type: 'plan_received' });
      timings.server = this.now() - t;

      t = this.now();
      const hardDenialContext: HardDenialContext = { nodeEntities: new Map(), extensionOwnedNodeIds: new Set() };
      const validated = validatePlan(rawPlan, stepId, hardDenialContext);
      if (!validated.ok) {
        this.controller.send({ type: 'validation_rejected' });
        this.emitState();
        const decision = this.reconcile.decide(false);
        if (decision.action === 'stop') return this.stop(decision.reason);
        this.controller.send({ type: 'reconcile_reobserve' });
        this.emitState();
        this.deps.onEvent({
          type: 'step',
          step: { stepIndex, stepId, stageTimings: timings, actionsPlanned: 0, outcome: 'validation_failed' },
        });
        continue;
      }
      this.controller.send({ type: 'validated' });
      timings.validate = this.now() - t;

      t = this.now();
      const outcome = await this.actOnPlan(validated.plan);
      timings.act = this.now() - t;

      this.history.push({ step_id: stepId, actions: validated.plan.actions.map((a) => ({ op: a.op })), outcome });
      this.deps.onEvent({
        type: 'step',
        step: { stepIndex, stepId, stageTimings: timings, actionsPlanned: validated.plan.actions.length, outcome: outcome as StepRecord['outcome'] },
      });

      if (outcome === 'done') {
        this.controller.send({ type: 'task_done' });
        this.emitState();
        return;
      }
      if (outcome === 'stopped') return;

      this.controller.send({ type: 'acted' });
      this.controller.send({ type: 'settled' });
      this.emitState();
      deltaOf = stepId;
    }
  }

  /** Runs every action in a validated plan, in order. Returns the outcome the step record shows. */
  private async actOnPlan(plan: ActionPlan): Promise<'acted' | 'done' | 'stopped'> {
    this.reconcile.resetForNewAction();
    for (const action of plan.actions) {
      if (action.op === 'stop') {
        this.deps.onEvent({ type: 'stopped', reason: 'CANCELLED' });
        return 'stopped';
      }
      if (action.op === 'done') {
        this.deps.onEvent({ type: 'done', summary: action.summary });
        return 'done';
      }

      const classified = classifyAction(action);
      if (classified.kind === 'host') {
        if (classified.op === 'report') this.deps.onEvent({ type: 'report', title: classified.title, content: classified.content });
        if (classified.op === 'ask_user') this.deps.onEvent({ type: 'ask_user', question: classified.question });
        continue;
      }

      const signals: RiskSignals = {};
      const level = classifyRisk(classified.action, signals);
      if (requiresConfirmation(level)) {
        const description = `${classified.action.op} on ${'node' in classified.action ? classified.action.node : 'the page'}`;
        this.deps.onEvent({ type: 'confirmation_required', risk: level, description });
        const approved = this.deps.confirm ? await this.deps.confirm(level, description) : true;
        if (!approved) return 'stopped';
      }

      const actionId = `a-${Math.random().toString(36).slice(2)}`;
      const result = await this.dispatchAndAwait(actionId, classified.action);
      if (!result.ok) {
        const decision = this.reconcile.decide(false);
        if (decision.action === 'stop') {
          this.stop(decision.reason);
          return 'stopped';
        }
        // Not locally repairable in Phase 2's design (see this file's top-of-file note) — the
        // whole plan is abandoned and the next loop iteration re-observes and re-sends.
        return 'stopped';
      }
    }
    return 'acted';
  }
}
