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
import type { Policy } from '@aegis/policy';
import { defaultPolicy } from '@aegis/policy';
import { classifyAction } from './actions/dispatch';
import { rehydrationRequiresConfirmation, resolveRehydration } from './actions/rehydrate';
import { classifyRisk, requiresConfirmation, type RiskLevel, type RiskSignals } from './actions/risk';
import { validatePlan, type HardDenialContext } from './actions/validator';
import { BudgetTracker, DEFAULT_BUDGETS, type BudgetLimits } from './controller/budgets';
import { Controller } from './controller/machine';
import { ReconciliationTracker } from './controller/reconcile';
import type { GuardedPayload } from './egress/brand';
import { Ledger } from './ledger/ledger';
import type { ContentPortClient } from './port';
import { attachImage } from './privacy/context/attach-image';
import { buildSanitizedContext } from './privacy/context/builder';
import { GuardBlockedError, guard } from './privacy/guard/guard';
import type { ImageRescanDeps } from './privacy/guard/image-rescan';
import { Vault } from './privacy/vault';
import type { PerceptionClient } from './perception-client/client';
import { GeometryDigestGuard } from './capture/digest';
import { runPerceptionStep, type CaptureFn } from './perception-client/run-step';
import type { BudgetReasonCode } from '../shared/errors';
import type { GraphMessage, WireScreenNode } from '../shared/messages';
import type { Box } from '../shared/worker-protocol';

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
  | { type: 'confirmation_required'; risk: RiskLevel; description: string }
  | { type: 'guard_blocked'; rule: string; entity?: string }
  | { type: 'rehydration_rejected'; code: string };

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface SessionDeps {
  contentPort: ContentPortClient;
  /** Posts the guarded payload to the gateway and returns the raw (unvalidated) plan JSON. */
  sendToGateway: (payload: GuardedPayload, signal: AbortSignal) => Promise<unknown>;
  /** Doubles as the vault/rehydration origin key (design.md §3.4 — an internal identifier, never
   * sent) and, historically, the Phase-2 stub's fixture-origin check (removed in Phase 3). */
  guardOrigin: string;
  policy?: Policy;
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
  /** Phase 4: absent (the default) means every step stays L0/text-only, exactly Phase 3's
   * behaviour — every existing caller/test that doesn't set this is unaffected. Present, it wires
   * the perception worker into the step loop: capture → `perceive` → (after fusion) `compose` →
   * the guard's image re-scan. */
  perception?: {
    client: PerceptionClient;
    capture: CaptureFn;
    digestGuard?: GeometryDigestGuard;
  };
  /** design.md §7.6 step 6 / T-5.8 — "debug/harness builds" only. Absent (the production default)
   * means guard step 6 never runs at all; only the eval harness ever supplies a real list (its
   * own planted high-entropy strings). [Fixed, Phase 5] This field didn't exist until a genuine
   * end-to-end harness run against the real corpus found a real canary that slipped past every
   * pattern-based detector (a real, disclosed residual-risk case, not a bug in the detector) —
   * `guard/canary.ts`'s step 6 existed to catch exactly this, but nothing had ever threaded a
   * harness-supplied list through to it. See docs/HISTORY.md's Phase 5 entry.
   */
  canaries?: readonly string[];
}

interface PendingGraph {
  resolve: (message: GraphMessage) => void;
}

export class Session {
  private readonly controller = new Controller();
  private readonly budgets: BudgetTracker;
  private readonly reconcile = new ReconciliationTracker();
  private readonly now: () => number;
  private readonly policy: Policy;
  private readonly vault = new Vault();
  private readonly ledger = new Ledger();
  private pendingGraph: PendingGraph | null = null;
  private pendingActions = new Map<string, { resolveOk: (ok: boolean, reason?: string) => void }>();
  private lastGraphMessage: GraphMessage | null = null;
  private allSeenNodes = new Map<string, WireScreenNode>();
  private history: { step_id: string; actions: { op: string }[]; outcome: string }[] = [];
  private readonly digestGuard: GeometryDigestGuard;
  // design.md §5.5, T-6.7: consecutive steps observed under hostile-dynamic mode. A single step
  // disables the image path (see the perception gate below) but does not itself stop the agent —
  // "eventually stops" (phase_6_tier2_parity.md §7's AC) means giving a brief mutation storm a
  // chance to settle before giving up, not stopping on the very first hostile-dynamic reading.
  private hostileDynamicStepStreak = 0;
  private static readonly HOSTILE_DYNAMIC_STEP_LIMIT = 3;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.budgets = new BudgetTracker(deps.budgetLimits ?? DEFAULT_BUDGETS, this.now);
    this.policy = deps.policy ?? defaultPolicy;
    this.digestGuard = deps.perception?.digestGuard ?? new GeometryDigestGuard();
  }

  getLedger(): Ledger {
    return this.ledger;
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
    this.vault.clear();
    this.deps.onEvent({ type: 'stopped', reason: 'CANCELLED' });
  }

  private emitState(): void {
    this.deps.onEvent({ type: 'state', state: this.controller.getState() });
  }

  private stop(reason: BudgetReasonCode): void {
    this.controller.send({ type: 'stop' });
    this.vault.clear();
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

      // design.md §5.5, T-6.7: "a mutation storm disables the image path and eventually stops
      // with an explanation." Checked before perception so a hostile-dynamic step never even
      // attempts a capture (this step's `perceptionResult` becomes `null`, exactly the shape a
      // step with no `deps.perception` already produces — the rest of the pipeline needs no
      // hostile-dynamic-specific branch beyond that).
      this.hostileDynamicStepStreak = graphMessage.hostileDynamic ? this.hostileDynamicStepStreak + 1 : 0;
      if (this.hostileDynamicStepStreak > Session.HOSTILE_DYNAMIC_STEP_LIMIT) {
        return this.stop('HOSTILE_DYNAMIC');
      }
      const imagePathDisabled = graphMessage.hostileDynamic;

      t = this.now();
      const viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY, docH: document.documentElement.scrollHeight };
      const perceptionResult = this.deps.perception && !imagePathDisabled
        ? await runPerceptionStep(graphMessage.nodes, {
            client: this.deps.perception.client,
            capture: this.deps.perception.capture,
            digestGuard: this.digestGuard,
            reobserveGeometry: async () => (await this.requestGraph()).nodes,
            viewport,
          })
        : null;
      this.controller.send({ type: 'perceived' });
      timings.perceive = this.now() - t;

      t = this.now();
      this.controller.send({ type: 'sanitized' });
      let context = buildSanitizedContext({
        stepId,
        task,
        reason: graphMessage.reason,
        deltaOf,
        viewport,
        pageCategory: this.deps.pageCategory,
        pageTitle: this.deps.pageTitle,
        nodes: graphMessage.nodes,
        removed: graphMessage.removed,
        textRuns: graphMessage.textRuns,
        history: this.history,
        clientTiming: {},
        vault: this.vault,
        policy: this.policy,
        originKey: this.deps.guardOrigin,
        visionCandidates: perceptionResult?.visionCandidates,
        visionAnalyzedNodeIds: perceptionResult?.visionAnalyzedNodeIds,
      });

      // T-4.16/T-4.17: attach the composed image only once the final fused `redactions` are known
      // — the compositor draws exactly those boxes, never a pre-fusion guess (attach-image.ts's
      // doc comment on why this is a separate step from buildSanitizedContext).
      let imageRescanDeps: ImageRescanDeps | undefined;
      if (perceptionResult?.captured && this.deps.perception) {
        const client = this.deps.perception.client;
        const scale = perceptionResult.scale;
        context = await attachImage({
          context,
          scale,
          visionAnalyzedNodeIds: perceptionResult.visionAnalyzedNodeIds,
          nodeRequiresVision: (node) => node.role === 'img',
          legend: 'Grey = unanalysed. Black boxes are redacted (labelled with their placeholder or type). Everything else is shown as captured.',
          compose: async (regions, cleared, s) => {
            const composed = await client.compose(regions, cleared, s);
            return composed;
          },
        });
        imageRescanDeps = {
          rescan: async (imageBytes, redactionBoxes) => {
            const result = await client.rescan(imageBytes, [...redactionBoxes], []);
            return { hits: result.hits.map((h) => ({ box: h.box as Box })) };
          },
          // `cleared: []` deliberately — a rescan hit means the clearance decision was wrong at
          // least once this step, so the recompose is maximally conservative: only the (now
          // dilated) redaction boxes are drawn at all, nothing already-cleared is re-copied in.
          recompose: async (dilatedRegions) => {
            const composed = await client.compose([...dilatedRegions], [], scale);
            return composed.webp;
          },
        };
      }
      timings.sanitize = this.now() - t;

      t = this.now();
      let guarded: GuardedPayload;
      try {
        guarded = await guard(context, this.policy, this.vault, { imageRescan: imageRescanDeps, canaries: this.deps.canaries });
        this.controller.send({ type: 'guard_pass' });
        this.ledger.record({
          stepId,
          payload: context,
          timings,
          guardVerdict: { ok: true },
          policyVersion: this.policy.version,
          entityCountsByClass: countBy(context.redactions, (r) => r.class),
          entityCountsByChannel: countBy(context.redactions.flatMap((r) => r.sources), (s) => s),
          coverage: context.coverage,
        });
      } catch (err) {
        const blocked = err instanceof GuardBlockedError ? err : new GuardBlockedError('SCHEMA');
        this.controller.send({ type: 'guard_block' });
        this.ledger.record({
          stepId,
          payload: context,
          timings,
          guardVerdict: { ok: false, rule: blocked.rule, entity: blocked.entity },
          policyVersion: this.policy.version,
          entityCountsByClass: countBy(context.redactions, (r) => r.class),
          entityCountsByChannel: countBy(context.redactions.flatMap((r) => r.sources), (s) => s),
          coverage: context.coverage,
        });
        this.emitState();
        this.deps.onEvent({ type: 'guard_blocked', rule: blocked.rule, entity: blocked.entity });
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

  /** design.md §9.3/§9.4 — confirmation (for CRITICAL/`confirm`-class refs), then `resolveFor`'s
   * six conditions, then dispatch with the real value. The value exists as a JS string only
   * between `resolveRehydration` returning and `dispatchAndAwait` handing it to the content
   * script — it is never placed in an event, a log, or `this.history`. */
  private async resolveAndDispatchRehydration(req: { node: string; ref: string; clearFirst?: boolean }): Promise<{ ok: true } | { ok: false; code: string }> {
    const targetNode = this.allSeenNodes.get(req.node);
    if (!targetNode) return { ok: false, code: 'NODE_UNRESOLVED' };

    const description = this.vault.describe(req.ref);
    if (!description) return { ok: false, code: 'REF_UNKNOWN' };

    let confirmed = true;
    if (rehydrationRequiresConfirmation(this.policy, description.entity)) {
      const preview = '•'.repeat(Math.max(0, description.len - 4)) + `#${description.len}`;
      const desc = `Type your ${description.entity} (${preview}) into "${targetNode.name}"?`;
      this.deps.onEvent({ type: 'confirmation_required', risk: 'high', description: desc });
      confirmed = this.deps.confirm ? await this.deps.confirm('high', desc) : false;
    }

    const result = resolveRehydration(this.vault, this.policy, req.ref, {
      originKey: this.deps.guardOrigin,
      confirmed,
      targetNode,
    });
    if (!result.ok) return { ok: false, code: result.code };

    const actionId = `a-${Math.random().toString(36).slice(2)}`;
    const dispatched = await this.dispatchAndAwait(actionId, { op: 'type', node: req.node, text: result.value, clearFirst: req.clearFirst });
    if (!dispatched.ok) return { ok: false, code: dispatched.reason ?? 'NODE_UNRESOLVED' };
    return { ok: true };
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

      if (classified.kind === 'rehydrate') {
        const resolved = await this.resolveAndDispatchRehydration(classified);
        if (!resolved.ok) {
          this.deps.onEvent({ type: 'rehydration_rejected', code: resolved.code });
          this.history.push({ step_id: '', actions: [{ op: 'type' }], outcome: `REHYDRATE_${resolved.code}` });
          const decision = this.reconcile.decide(false);
          if (decision.action === 'stop') {
            this.stop(decision.reason);
            return 'stopped';
          }
          return 'stopped';
        }
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
