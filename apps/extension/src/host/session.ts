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

import type { ActionPlan, SanitizedContext } from '@aegis/protocol';
import type { RecognizerMatch } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { defaultPolicy } from '@aegis/policy';
import { classifyAction } from './actions/dispatch';
import { rehydrationRequiresConfirmation, resolveRehydration } from './actions/rehydrate';
import { classifyRisk, requiresConfirmation, type RiskLevel, type RiskSignals, hasHighRiskVerb } from './actions/risk';
import { validatePlan, type HardDenialContext } from './actions/validator';
import { BudgetTracker, DEFAULT_BUDGETS, type BudgetLimits } from './controller/budgets';
import { Controller, TERMINAL_STATES } from './controller/machine';
import { ReconciliationTracker } from './controller/reconcile';
import type { GuardedPayload } from './egress/brand';
import { StepFailedError } from './egress/gateway-client';
import { Ledger } from './ledger/ledger';
import type { ContentPortClient } from './port';
import { attachImage, composeOptionsFor } from './privacy/context/attach-image';
import { buildSanitizedContext, collectFreeTextSources, redactionSpanOrigin } from './privacy/context/builder';
import { GuardBlockedError, guard } from './privacy/guard/guard';
import { scrubPayloadText } from './privacy/guard/sweeps';
import type { ImageRescanDeps } from './privacy/guard/image-rescan';
import { Vault } from './privacy/vault';
import type { PerceptionClient } from './perception-client/client';
import { GeometryDigestGuard } from './capture/digest';
import { runPerceptionStep, type CaptureFn, type PerceptionStepResult, type PerceptionStepStatus } from './perception-client/run-step';
import type { AblationArm } from '../shared/ablation';
import type { BudgetReasonCode } from '../shared/errors';
import type { GraphMessage, PageViewport, WireScreenNode } from '../shared/messages';
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
  | { type: 'stopped'; reason: StopReason; detail?: string }
  | { type: 'done'; summary?: string }
  | { type: 'confirmation_required'; risk: RiskLevel; description: string }
  | { type: 'guard_blocked'; rule: string; entity?: string }
  | { type: 'rehydration_rejected'; code: string }
  | { type: 'sanitized_preview'; payload: ReturnType<typeof buildSanitizedContext>; protectedFields?: ProtectedField[] }
  | { type: 'perception'; stepId: string; status: PerceptionStepStatus }
  /** The plan after gateway AND extension validation, one line per action, described with the
   * sanitized names that were sent (never raw page text or a rehydrated value). */
  | { type: 'plan'; stepId: string; actions: string[] }
  /** What happened to action `index` of that plan on this page. */
  | { type: 'action_status'; stepId: string; index: number; status: ActionStatus; reason?: string }
  /** The gateway returned a plan the extension's own validator refused; nothing was executed. */
  | { type: 'plan_rejected'; stepId: string; reason: string }
  /** The gateway asked to retry later (model rate limit): the step is re-sent after `seconds`. */
  | { type: 'waiting'; seconds: number; reason: string }
  /** Something failed and the task carries on: what failed, and what happens instead. */
  | { type: 'recovering'; what: 'vision' | 'server' | 'guard' | 'page' | 'step'; detail: string }
  /** The task is paused on something only the user can do (solve a CAPTCHA, answer a question). */
  | { type: 'waiting_user'; reason: 'captcha' | 'question'; detail?: string }
  /** How long the page took to be visually complete before this step's observation. */
  | { type: 'page_ready'; waitedMs: number; pendingImages: number; timedOut: boolean };

export type StopReason =
  | BudgetReasonCode
  | 'BLOCKED'
  | 'SERVER_ERROR'
  | 'CANCELLED'
  | 'PAGE_DISCONNECTED'
  | 'MODEL_STOPPED'
  | 'USER_DECLINED'
  | 'NEEDS_USER'
  | 'VISION_UNAVAILABLE'
  /** Several steps in a row failed even after recovery: stopping beats looping. */
  | 'RECOVERY_EXHAUSTED';

export type ActionStatus = 'executed' | 'failed' | 'declined' | 'skipped';

/** A form field the local classifier decided is sensitive from its label/type (not its value),
 * and how its value was sent this step. */
export interface ProtectedField {
  entity: string;
  /** The field's name as SENT (sanitized). */
  label: string;
  sent: 'empty' | 'placeholder' | 'presence' | 'text';
  ref?: string;
}

/** Every form field whose label/type the local classifier marked sensitive, with how its value
 * went out this step. An EMPTY sensitive field has nothing to redact yet, so it never appears in
 * `redactions`; this is what lets the panel show it is protected anyway. */
export function protectedFieldsOf(pageNodes: readonly WireScreenNode[], sent: readonly { id: string; name: string; value?: SentNodeValue }[]): ProtectedField[] {
  const sentById = new Map(sent.map((n) => [n.id, n]));
  const out: ProtectedField[] = [];
  for (const node of pageNodes) {
    const signal = node.domSignal;
    if (!signal || !node.field || signal.entity === 'CAPTCHA') continue;
    const sentNode = sentById.get(node.id);
    if (!sentNode) continue;
    const v = sentNode.value;
    const sentAs = !v || (v.kind === 'text' && v.text === '') ? 'empty' : v.kind;
    const field: ProtectedField = { entity: signal.entity, label: sentNode.name, sent: sentAs };
    if (v?.kind === 'placeholder') field.ref = v.ref;
    out.push(field);
  }
  return out;
}

/** Label-classified sensitive fields whose value went out unsealed (empty, or plain text): their
 * boxes are masked in the image regardless of value (attach-image.ts `maskedFields`). A sealed
 * or never-read value already has its own redaction box. */
export function labelProtectedFieldsWithoutRedaction(pageNodes: readonly WireScreenNode[], sent: readonly { id: string; box: readonly number[]; value?: SentNodeValue | null }[]): { entity: string; box: Box }[] {
  const sentById = new Map(sent.map((n) => [n.id, n]));
  const out: { entity: string; box: Box }[] = [];
  for (const node of pageNodes) {
    const sentNode = sentById.get(node.id);
    if (!sentNode || !node.field || !node.domSignal || node.domSignal.entity === 'CAPTCHA') continue;
    const kind = sentNode.value?.kind;
    if (kind === 'placeholder' || kind === 'presence') continue;
    out.push({ entity: node.domSignal.entity, box: [...sentNode.box] as Box });
  }
  return out;
}

type SentNodeValue = { kind: 'empty' } | { kind: 'presence' } | { kind: 'placeholder'; ref: string } | { kind: 'text'; text: string };

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
  /** The perception worker: capture → `perceive` → (after fusion) `compose` → the guard's image
   * re-scan. Present (the panel always passes it), vision is REQUIRED: every step sends a redacted
   * screenshot, or the task stops (VISION_UNAVAILABLE) — no step is sent text-only. Absent (unit
   * tests of the text pipeline only), every step is L0/text-only. */
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
  /** design.md §18.3, T-6.9 — "config switches in a debug build only." Absent (the production
   * default, and every pre-T-6.9 caller/test) behaves exactly like `'fused'`. Set only by
   * `entrypoints/sidepanel/main.tsx`'s debug-only branch (never in a release build — see
   * `src/debug/ablations.ts`'s doc comment) or directly by the eval harness's own ablation
   * runner, the same shape `canaries` above already uses. */
  ablation?: AblationArm;
  /** Re-attaches to the task's tab after a page load that one of AEGIS's own actions caused (a
   * link, a form submit). Resolves the new document's content port, origin and title, or null if
   * the page cannot be reached (not http(s), no host permission, content script never ready). */
  reconnect?: () => Promise<{ contentPort: ContentPortClient; origin: string; title: string } | null>;
  /** After AEGIS's own action: if it opened a NEW tab (a `target=_blank` link, a shop's product
   * page), attaches to that tab, makes it the task's tab and resolves it; null if no tab was opened
   * (or it cannot be reached, and the task stays on its tab). */
  followOpenedTab?: () => Promise<{ contentPort: ContentPortClient; origin: string; title: string } | null>;
  /** The task's tab, through the browser's tabs API: the model's navigation ops, and the wait for
   * a page to finish loading before it is observed and captured. */
  browser?: BrowserControl;
  /** Opens a fresh gateway session (the gateway restarted and forgot ours, or our step lease is
   * out of step with it); later steps go to the new one. */
  reopenSession?: () => Promise<void>;
  /** Shows the model's question and resolves with the user's answer, or null if they decline. */
  askUser?: (question: string) => Promise<string | null>;
  /** The content script answers `await-ready` and `measure-spans` (the panel's real one does). */
  pageQueries?: boolean;
  /** Every wait the session makes (retry back-off, CAPTCHA polling); tests pass an instant one. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface BrowserControl {
  /** Each resolves once the navigation has run its course (loaded, or clearly not starting). */
  navigate(url: string): Promise<void>;
  /** Opens `url` in a new tab opened from the task's tab; `followOpenedTab` then moves the task. */
  openTab(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  /** After a step's actions: resolves once the task's tab has finished loading and painted, so the
   * next observation and screenshot show the page the actions produced. */
  waitForPageReady(): Promise<void>;
}

/** A URL the model asked to open: http(s) only, no credentials, no sealed placeholder in it. */
export function parseWebUrl(raw: string): URL | null {
  if (/[\u27ea\u27eb\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}

interface PendingGraph {
  resolve: (message: GraphMessage) => void;
  reject: (err: Error) => void;
}

/** The content-script port closed mid-task (tab closed, navigated, reloaded, or the extension was
 * reloaded under it). Rejects every in-flight wait so the step loop unwinds and stops instead of
 * awaiting a graph or action result that can never arrive. */
class PageDisconnectedError extends Error {
  /** `fatal`: the task's page is gone for good (tab closed, not a web page, no access) — retrying
   * cannot bring it back. */
  constructor(
    readonly detail?: string,
    readonly fatal = false,
  ) {
    super('PAGE_DISCONNECTED');
    this.name = 'PageDisconnectedError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** How a failed gateway call is handled: sent again (after `waitS`), sent again on a fresh gateway
 * session, or given up on. */
type SendFailure = { kind: 'retry'; waitS?: number } | { kind: 'reopen' } | { kind: 'fatal' };

function classifySendFailure(err: unknown, maxWaitS: number): SendFailure {
  if (err instanceof StepFailedError) {
    if (err.status === 404 || err.status === 409) return { kind: 'reopen' };
    if (err.retryable) {
      // A Retry-After of many minutes is a daily quota, not a busy minute: report it.
      if (err.retryAfterS !== undefined && err.retryAfterS > maxWaitS) return { kind: 'fatal' };
      return { kind: 'retry', waitS: err.retryAfterS };
    }
    return { kind: 'fatal' };
  }
  // The gateway could not be reached, or did not answer in time: it may be restarting.
  return { kind: 'retry' };
}

function describeSendError(err: unknown): string {
  if (err instanceof StepFailedError) return err.detail || `HTTP_${err.status}`;
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'CLIENT_TIMEOUT';
  return 'GATEWAY_UNREACHABLE';
}

function describeError(err: unknown): string {
  if (err instanceof PageDisconnectedError) return `page ${err.detail ?? 'disconnected'}`;
  if (err instanceof Error) return err.name.replace(/[^A-Za-z_]/g, '').slice(0, 40) || 'Error';
  return 'unknown';
}

/** A capture worth retrying within the step: the page moved during it, Chrome throttled or briefly
 * could not take it, or the vision worker failed on it (the client replaces a dead worker on the
 * next request). Missing permission or host access, a restricted page, a closed tab or a changed
 * origin are not retried here; the step fails and is observed afresh (which re-attaches). */
function isTransientVisionFailure(status: PerceptionStepStatus): boolean {
  if (status.worker === 'failed') return true;
  return status.capture === 'geometry-changed' || status.capture === 'throttled' || status.capture === 'not-visible' || status.capture === 'decode' || status.capture === 'unknown' || (status.capture === 'ok' && status.worker === 'ok');
}

function describeVisionFailure(status: PerceptionStepStatus): string {
  if (status.worker === 'failed') return 'the local vision worker failed; restarting it';
  if (status.capture === 'disabled') return status.disabledReason === 'hostile-dynamic' ? 'the page kept changing' : 'vision is disabled';
  if (status.capture === 'ok') return 'the page kept changing: the whole-frame check did not finish';
  return `capture ${status.capture}`;
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
  private pendingActions = new Map<string, { resolveOk: (ok: boolean, reason?: string) => void; reject: (err: Error) => void }>();
  private pageDisconnected = false;
  private contentPort: ContentPortClient;
  private originKey: string;
  private pageTitle: string;
  // An action was dispatched since the last observation (a tab it opened is followed then).
  private actedSinceObserve = false;
  // The task's tab dropped its document (a navigation, a redirect, a slow page replacing itself):
  // the next observation re-attaches to the tab's new document instead of stopping.
  private navigationPending = false;
  private lastDispatchedActionId: string | null = null;
  private settleWaiter: { actionId: string; resolve: () => void } | null = null;
  private static readonly SETTLE_WAIT_MS = 2500;
  private lastGraphMessage: GraphMessage | null = null;
  private allSeenNodes = new Map<string, WireScreenNode>();
  /** Node names exactly as sent in the last payload: the panel describes plans with these. */
  private sentNames = new Map<string, string>();
  private history: { step_id: string; actions: { op: string; node?: string }[]; outcome: string }[] = [];
  private readonly digestGuard: GeometryDigestGuard;
  // design.md §5.5, T-6.7: consecutive steps observed under hostile-dynamic mode. A single step
  // disables the image path (see the perception gate below) but does not itself stop the agent —
  // "eventually stops" (phase_6_tier2_parity.md §7's AC) means giving a brief mutation storm a
  // chance to settle before giving up, not stopping on the very first hostile-dynamic reading.
  private hostileDynamicStepStreak = 0;
  private static readonly HOSTILE_DYNAMIC_STEP_LIMIT = 3;
  /** Times one step re-attaches after its page dropped its document mid-observation. */
  private static readonly REATTACH_LIMIT = 4;
  /** Steps in a row that may fail (and be retried from a fresh observation) before the task stops. */
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  /** Sends of one step's payload: the first try plus retries on a busy, restarting or unreachable
   * gateway. */
  private static readonly SEND_ATTEMPTS = 6;
  /** How long a CAPTCHA may wait for the user before the task stops. */
  private static readonly CAPTCHA_WAIT_MS = 5 * 60_000;
  /** Page readiness: the first look at a page (it may still be loading) and every later one. */
  private static readonly READY_FIRST_MS = 8000;
  private static readonly READY_MS = 3000;
  /** Tries per step to get a redacted screenshot before the step is retried from a fresh
   * observation (every step carries one: none, nothing is sent). */
  private static readonly VISION_ATTEMPTS = 4;
  /** Between tries: lets an animation or scroll finish, and stays under Chrome's 2 captures/s. */
  private static readonly VISION_RETRY_MS = 700;
  // Above the gateway's own deadline (45 s model call + up to 30 s wait + one more call); a retry after a Retry-After wait gets its own deadline.
  private static readonly STEP_TIMEOUT_MS = 150_000;
  private static readonly DEFAULT_RETRY_WAIT_S = 2;
  // Groq's per-minute token limit asks for waits of up to about a minute; a daily-limit 429 asks
  // for many minutes and is reported instead of waited out.
  private static readonly MAX_RETRY_WAIT_S = 65;
  private static readonly ACTION_RESULT_TIMEOUT_MS = 15_000;
  // T-6.12 (FR-36): in-memory only, never persisted anywhere — a fresh `Session` (one per task,
  // per `main.tsx`'s own per-task perception-worker lifetime comment) starts with an empty set,
  // which is exactly "it expires with the session" (phase_6_tier2_parity.md's AC).
  private readonly unredactedRefs = new Set<string>();
  private task = '';
  // The next observation is the first of its page (task start, a navigation, a new tab).
  private freshPage = true;
  private pageQueriesUnanswered = false;

  constructor(private readonly deps: SessionDeps) {
    this.contentPort = deps.contentPort;
    this.originKey = deps.guardOrigin;
    this.pageTitle = deps.pageTitle;
    this.now = deps.now ?? (() => Date.now());
    this.budgets = new BudgetTracker(deps.budgetLimits ?? DEFAULT_BUDGETS, this.now);
    this.policy = deps.policy ?? defaultPolicy;
    this.digestGuard = deps.perception?.digestGuard ?? new GeometryDigestGuard();
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.sleep ?? sleep)(ms, signal);
  }

  getLedger(): Ledger {
    return this.ledger;
  }

  getState(): ReturnType<Controller['getState']> {
    return this.controller.getState();
  }

  /** T-6.12 (FR-36, design.md §7.1 step 9): "The user shall be able to un-redact a specific
   * region for the session" — the only de-escalation path besides a versioned policy allow-rule.
   * Takes the placeholder REF the user is already looking at (from a step's own
   * `SanitizedContext.redactions[]`/rendered payload), not a raw value — this class never hands a
   * caller a raw value to pass back in. `vault.has(ref)` is the only validation: a ref this
   * session never minted can't be un-redacted (there is nothing to de-escalate), and a
   * presence-only entity was never minted with a value-bearing ref to begin with, so it can never
   * satisfy this check either — no separate presence-only guard needed here.
   *
   * Returns `false` (and records nothing) for an unknown ref rather than throwing — the caller
   * (a UI button click) has no meaningful recovery beyond "don't claim it worked." */
  unredact(ref: string, reason: string): boolean {
    if (!this.vault.has(ref)) return false;
    this.unredactedRefs.add(ref);
    const description = this.vault.describe(ref);
    this.ledger.recordUnredact({
      ref,
      entity: description?.entity ?? 'UNKNOWN_SENSITIVE',
      reason,
      stepId: this.ledger.latest()?.stepId ?? '',
      ts: this.now(),
    });
    return true;
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

  /** The content script's `settled` for an action (sent at once on `pagehide` if it navigated). */
  onSettled(actionId: string): void {
    if (this.settleWaiter?.actionId === actionId) this.settleWaiter.resolve();
  }

  onActionResult(actionId: string, ok: boolean, reason?: string): void {
    this.pendingActions.get(actionId)?.resolveOk(ok, reason);
    this.pendingActions.delete(actionId);
  }

  /** Wired to the content port's `onDisconnect` by whoever owns it (entrypoints/sidepanel). */
  onContentDisconnected(): void {
    if (this.pageDisconnected) return;
    this.pageDisconnected = true;
    // Whatever loaded the new document (an action of ours, a redirect, the page itself), the task's
    // tab still holds the task; reconnect() decides whether the new page can be attached to.
    if (this.deps.reconnect) this.navigationPending = true;
    this.settleWaiter?.resolve();
    // A navigating action's own result may never arrive; the page moving on IS its result.
    if (this.navigationPending) {
      for (const pending of this.pendingActions.values()) pending.resolveOk(true);
      this.pendingActions.clear();
    }
    const err = new PageDisconnectedError(undefined, !this.navigationPending);
    this.pendingGraph?.reject(err);
    this.pendingGraph = null;
    for (const pending of this.pendingActions.values()) pending.reject(err);
    this.pendingActions.clear();
  }

  cancel(): void {
    this.controller.send({ type: 'cancel' });
    this.vault.clear();
    this.deps.onEvent({ type: 'stopped', reason: 'CANCELLED' });
  }

  private isFinished(): boolean {
    return TERMINAL_STATES.has(this.controller.getState());
  }

  private emitState(): void {
    this.deps.onEvent({ type: 'state', state: this.controller.getState() });
  }

  private stop(reason: Exclude<StopReason, 'CANCELLED'>, detail?: string): void {
    this.controller.send({ type: 'stop' });
    this.vault.clear();
    this.emitState();
    this.deps.onEvent({ type: 'stopped', reason, ...(detail ? { detail } : {}) });
  }

  /** Before re-observing after an action: let the page settle, or start navigating, so the next
   * observation is of the page the action produced (not the old one about to unload). */
  private async awaitSettle(): Promise<void> {
    const actionId = this.lastDispatchedActionId;
    if (!this.deps.reconnect || !actionId || this.pageDisconnected) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Session.SETTLE_WAIT_MS);
      this.settleWaiter = {
        actionId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
    this.settleWaiter = null;
  }

  private perceive(pageNodes: readonly WireScreenNode[], viewport: PageViewport, textRuns: GraphMessage['textRuns'], pixelVerified: boolean): Promise<PerceptionStepResult> {
    const perception = this.deps.perception!;
    return runPerceptionStep(pageNodes, {
      textRuns,
      pixelVerified,
      client: perception.client,
      capture: perception.capture,
      digestGuard: this.digestGuard,
      // T-6.10: `requestGraph()`'s resolved `GraphMessage.nodes` is a DELTA (only nodes
      // new/changed since the last extraction — `onGraph` folds it into `allSeenNodes`, which is
      // exactly why that accumulator exists), not a full snapshot. Using the delta directly here
      // made every post-capture digest recheck compare this step's full initial node set against
      // a near-always-empty delta, which made `computeGeometryDigest` mismatch on essentially every
      // real capture and `digestGuard.check` discard it before `client.perceive()` was ever called
      // — silently defeating the whole vision path project-wide (found by driving a real fixture
      // end to end, T-6.9/T-6.10). `computeGeometryDigest` sorts before hashing, so
      // `allSeenNodes`' insertion order doesn't need to match the original snapshot's order.
      reobserveGeometry: async () => {
        await this.requestGraph();
        return [...this.allSeenNodes.values()];
      },
      viewport,
      ablation: this.deps.ablation,
    });
  }

  /** Observes the current page, re-attaching first if AEGIS's own action loaded a new document
   * in the task's tab or opened a new tab (which then becomes the task's tab). */
  private async observe(): Promise<GraphMessage> {
    if (this.actedSinceObserve && !this.navigationPending && this.deps.followOpenedTab) {
      const opened = await this.deps.followOpenedTab();
      if (opened) {
        this.attach(opened, 'opened a new tab');
        await this.awaitPageReady();
        return this.requestGraph();
      }
    }
    try {
      if (!this.navigationPending) {
        await this.awaitPageReady();
        return await this.requestGraph();
      }
    } catch (err) {
      if (!(err instanceof PageDisconnectedError) || !this.navigationPending) throw err;
    }
    const next = this.deps.reconnect ? await this.deps.reconnect() : null;
    if (!next) throw new PageDisconnectedError('NEW_PAGE_UNREACHABLE', true);
    this.attach(next, 'page navigated');
    await this.awaitPageReady();
    return this.requestGraph();
  }

  /** Waits for the page to be visually complete (its pictures loaded, its content no longer
   * arriving) so the observation and the screenshot show the page the user would see. A content
   * script that cannot answer costs nothing: the wait resolves null. */
  private async awaitPageReady(): Promise<void> {
    if (!this.deps.pageQueries || this.pageQueriesUnanswered || this.pageDisconnected) return;
    const maxMs = this.freshPage ? Session.READY_FIRST_MS : Session.READY_MS;
    this.freshPage = false;
    const ready = await this.contentPort.awaitReady(maxMs);
    // A content script that never answers (an older build still in the page) is not asked again.
    if (!ready && !this.pageDisconnected) this.pageQueriesUnanswered = true;
    if (ready && (ready.timedOut || ready.waitedMs > 400)) {
      this.deps.onEvent({ type: 'page_ready', waitedMs: ready.waitedMs, pendingImages: ready.pendingImages, timedOut: ready.timedOut });
    }
  }

  /** Continues the task on another document: the same tab's next page, or a tab the action opened. */
  private attach(next: { contentPort: ContentPortClient; origin: string; title: string }, outcome: string): void {
    this.contentPort = next.contentPort;
    this.originKey = next.origin;
    this.pageTitle = next.title;
    this.pageDisconnected = false;
    this.navigationPending = false;
    this.allSeenNodes.clear();
    this.lastGraphMessage = null;
    this.digestGuard.reset();
    this.freshPage = true;
    this.pageQueriesUnanswered = false;
    const last = this.history[this.history.length - 1];
    if (last) last.outcome = `${last.outcome}; ${outcome}`;
  }

  private requestGraph(): Promise<GraphMessage> {
    if (this.pageDisconnected) return Promise.reject(new PageDisconnectedError(undefined, !this.navigationPending));
    return new Promise((resolve, reject) => {
      this.pendingGraph = { resolve, reject };
      this.contentPort.requestExtract();
    });
  }

  private dispatchAndAwait(actionId: string, action: Parameters<ContentPortClient['dispatchAction']>[1]): Promise<{ ok: boolean; reason?: string }> {
    if (this.pageDisconnected) return Promise.reject(new PageDisconnectedError(undefined, !this.navigationPending));
    return new Promise((resolve, reject) => {
      // The content script answers right after dispatching (before any settle wait); no answer at
      // all means its handler died, and the step must fail rather than wait forever.
      const timer = setTimeout(() => {
        if (!this.pendingActions.has(actionId)) return;
        this.pendingActions.delete(actionId);
        resolve({ ok: false, reason: 'NO_RESULT' });
      }, Session.ACTION_RESULT_TIMEOUT_MS);
      this.pendingActions.set(actionId, {
        resolveOk: (ok, reason) => {
          clearTimeout(timer);
          resolve({ ok, reason });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.actedSinceObserve = true;
      this.lastDispatchedActionId = actionId;
      this.contentPort.dispatchAction(actionId, action);
    });
  }

  async start(task: string): Promise<void> {
    this.controller.send({ type: 'start' });
    this.budgets.startTask();
    this.emitState();
    this.controller.send({ type: 'prepared' });
    this.emitState();
    this.task = task;
    let stepIndex = 0;
    let failures = 0;
    // Nothing that goes wrong inside one step ends the task: a crash, an unreachable page or
    // server, a refused payload all end THAT step, and the next one starts from a fresh look at
    // the page. Only the user, a budget, a page that is gone for good, or several failed steps in
    // a row stop it.
    while (!this.isFinished()) {
      stepIndex += 1;
      let outcome: 'ok' | 'failed';
      let crashed = false;
      try {
        outcome = await this.runStep(stepIndex);
      } catch (err) {
        crashed = true;
        if (this.isFinished()) break;
        if (err instanceof PageDisconnectedError && err.fatal) {
          this.stop('PAGE_DISCONNECTED', err.detail);
          break;
        }
        this.deps.onEvent({ type: 'recovering', what: err instanceof PageDisconnectedError ? 'page' : 'step', detail: `${describeError(err)}; observing the page again` });
        outcome = 'failed';
      }
      if (this.isFinished()) break;
      if (outcome === 'ok') {
        failures = 0;
        continue;
      }
      failures += 1;
      if (failures >= Session.MAX_CONSECUTIVE_FAILURES) {
        this.stop('RECOVERY_EXHAUSTED', `${failures} steps in a row could not be completed`);
        break;
      }
      this.controller.endServerCall();
      this.controller.send({ type: 'recover' });
      this.emitState();
      // A crash or an unreachable page/server gets time to come back; a refused plan or a failed
      // action is simply asked again from a fresh observation.
      if (crashed) await this.pause(Math.min(8000, 500 * 2 ** failures));
    }
  }

  /** One observe → perceive → sanitize → guard → send → validate → act cycle. `'failed'`: the step
   * made no progress (the caller retries from a fresh observation); `'ok'`: it did, or the task
   * ended (the caller checks). */
  private async runStep(stepIndex: number): Promise<'ok' | 'failed'> {
    const stepId = `s-${stepIndex}`;
    this.reconcile.resetForNewStep();

    const stepBreach = this.budgets.beginStep();
    if (stepBreach) {
      this.stop(stepBreach);
      return 'ok';
    }
    const wallClockBreach = this.budgets.checkWallClock();
    if (wallClockBreach) {
      this.stop(wallClockBreach);
      return 'ok';
    }

    const timings: StepStageTimings = { observe: 0, perceive: 0, sanitize: 0, guard: 0, server: 0, validate: 0, act: 0 };

    let t = this.now();
    this.controller.send({ type: 'observed' });
    let graphMessage!: GraphMessage;
    let pageNodes: WireScreenNode[] = [];
    let viewport!: PageViewport;
    let hostileDynamic = false;
    let perceptionResult: PerceptionStepResult | null = null;
    const visionWanted = !!this.deps.perception && this.deps.ablation !== 'dom_only';
    // A slow page can still replace its document after it was observed (a redirect, a search
    // result page finishing its load): that drops the content port mid-perception. Observe the
    // tab's new document and perceive again, rather than stop the task on a page that is fine.
    for (let reattach = 0; ; reattach++) {
      try {
        t = this.now();
        graphMessage = await this.observe();
        this.actedSinceObserve = false;
        // Every step is built from the full current page, not the content script's delta: graphs
        // auto-sent between steps (after an action settles) are folded into `allSeenNodes` but never
        // reach the gateway on their own, so a delta-built step 2 showed the model almost nothing.
        pageNodes = [...this.allSeenNodes.values()];
        timings.observe = this.now() - t;

        // design.md §5.5, T-6.7: a page in a mutation storm cannot tie a frame to the DOM it was
        // observed with, so its screenshot is checked from the pixels alone (pixel-verified below).
        this.hostileDynamicStepStreak = graphMessage.hostileDynamic ? this.hostileDynamicStepStreak + 1 : 0;
        hostileDynamic = graphMessage.hostileDynamic;

        // T-6.13 (FR-8, NG-8): a CAPTCHA is never attempted — control goes to the user. The task
        // waits for them to solve it and carries on, instead of ending.
        if (this.captchaPresent()) {
          const cleared = await this.waitForCaptchaCleared();
          if (this.isFinished()) return 'ok';
          if (!cleared) {
            this.stop('CAPTCHA_DETECTED', 'the CAPTCHA was not solved within 5 minutes');
            return 'ok';
          }
          this.controller.send({ type: 'recover' });
          return 'ok';
        }

        t = this.now();
        // The PAGE's viewport, as measured by the content script (this loop runs in the side panel,
        // whose own window is the panel). The panel-window fallback exists only for unit tests.
        viewport = graphMessage.viewport ?? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY, docH: document.documentElement.scrollHeight };
        // Every step captures the screen, runs the local vision models over it and sends the
        // redacted screenshot; no step is sent without one. A capture that fails is retried: a page
        // that moved during it (or never stops moving) is captured again and checked from the
        // pixels alone, a crashed or wedged vision worker is replaced first. Never an unredacted
        // screenshot: if none can be made, nothing is sent and the step is tried again.
        perceptionResult = null;
        if (visionWanted) {
          let pixelVerified = hostileDynamic;
          for (let attempt = 1; ; attempt++) {
            try {
              perceptionResult = await this.perceive(pageNodes, viewport, graphMessage.textRuns, pixelVerified);
            } catch (err) {
              if (err instanceof PageDisconnectedError) throw err;
              perceptionResult = null;
            }
            if (this.isFinished()) return 'ok';
            // Pixel-verified means the DOM's boxes were not trusted, so the whole-frame face and
            // text passes must have completed: a partial analysis cannot be cleared from DOM boxes.
            if (perceptionResult?.captured && pixelVerified && !composeOptionsFor(perceptionResult.analysis).clearDefault) perceptionResult = { ...perceptionResult, captured: false };
            if (perceptionResult?.captured) break;
            const status = perceptionResult?.status;
            if (attempt >= Session.VISION_ATTEMPTS || (status && !isTransientVisionFailure(status))) break;
            if (status?.capture === 'geometry-changed') pixelVerified = true;
            this.deps.onEvent({ type: 'recovering', what: 'vision', detail: `screenshot attempt ${attempt} failed (${status ? describeVisionFailure(status) : 'no capture'}); capturing again` });
            await this.pause(Session.VISION_RETRY_MS * attempt);
            if (this.isFinished()) return 'ok';
            const graph = await this.requestGraph();
            hostileDynamic = graph.hostileDynamic;
            pixelVerified ||= hostileDynamic;
            pageNodes = [...this.allSeenNodes.values()];
          }
        }
        break;
      } catch (err) {
        if (!(err instanceof PageDisconnectedError) || !this.navigationPending || reattach >= Session.REATTACH_LIMIT || this.isFinished()) throw err;
      }
    }
    if (this.isFinished()) return 'ok';
    this.controller.send({ type: 'perceived' });
    timings.perceive = this.now() - t;
    const perceptionStatus: PerceptionStepStatus | undefined = perceptionResult
      ? perceptionResult.status
      : this.deps.perception
        ? { capture: 'disabled', disabledReason: hostileDynamic ? 'hostile-dynamic' : 'dom_only', worker: 'not-called', level: 'L0', regionsRequested: 0 }
        : undefined;
    if (perceptionStatus) this.deps.onEvent({ type: 'perception', stepId, status: perceptionStatus });
    if (visionWanted && !perceptionResult?.captured) {
      const why = perceptionStatus ? describeVisionFailure(perceptionStatus) : 'no capture';
      this.deps.onEvent({ type: 'recovering', what: 'vision', detail: `no redacted screenshot yet (${why}): nothing was sent; observing the page again` });
      return 'failed';
    }
    const perceptionEvidence = perceptionStatus ? { status: perceptionStatus, screenLabel: perceptionResult?.screenLabel } : undefined;

    // T-6.8: NER (profile L) runs in the perception worker, over the exact free-text sources the
    // builder will scan; a dead worker means no NER contribution, never a thrown error.
    let nerMatchesByKey: Map<string, RecognizerMatch[]> | undefined;
    if (this.deps.perception) {
      const freeTextSources = collectFreeTextSources({
        task: this.task,
        pageTitle: this.pageTitle,
        nodes: pageNodes,
        textRuns: graphMessage.textRuns,
        ablation: this.deps.ablation,
      });
      try {
        const nerResult = await this.deps.perception.client.ner(freeTextSources.map((s) => ({ id: s.key, text: s.text })));
        const textByKey = new Map(freeTextSources.map((s) => [s.key, s.text]));
        nerMatchesByKey = new Map();
        for (const span of nerResult.spans) {
          const text = textByKey.get(span.id);
          if (text === undefined) continue;
          const list = nerMatchesByKey.get(span.id) ?? [];
          list.push({
            entity: span.entity,
            start: span.start,
            end: span.end,
            matchedText: text.slice(span.start, span.end),
            score: span.score,
            source: `ner:${span.entity.toLowerCase()}`,
            valid: true,
          });
          nerMatchesByKey.set(span.id, list);
        }
      } catch {
        nerMatchesByKey = undefined;
      }
    }

    t = this.now();
    this.controller.send({ type: 'sanitized' });
    let context = buildSanitizedContext({
      stepId,
      task: this.task,
      reason: graphMessage.reason,
      deltaOf: null,
      viewport,
      pageCategory: this.deps.pageCategory,
      pageTitle: this.pageTitle,
      nodes: pageNodes,
      removed: [],
      textRuns: graphMessage.textRuns,
      history: this.history,
      clientTiming: {},
      vault: this.vault,
      policy: this.policy,
      originKey: this.originKey,
      visionCandidates: perceptionResult?.visionCandidates,
      visionAnalyzedNodeIds: perceptionResult?.visionAnalyzedNodeIds,
      ablation: this.deps.ablation,
      unredactedRefs: this.unredactedRefs,
      nerMatchesByKey,
    });
    context = await this.tightenTextRedactionBoxes(context);

    // T-4.16/T-4.17: the composed image is attached only once the final fused `redactions` are
    // known — the compositor draws exactly those boxes, never a pre-fusion guess.
    let imageRescanDeps: ImageRescanDeps | undefined;
    if (perceptionResult?.captured && this.deps.perception) {
      const client = this.deps.perception.client;
      const scale = perceptionResult.scale;
      const composeOptions = composeOptionsFor(perceptionResult.analysis);
      const blackbox = this.deps.ablation === 'blackbox';
      try {
        context = await attachImage({
          context,
          scale,
          visionAnalyzedNodeIds: perceptionResult.visionAnalyzedNodeIds,
          nodeRequiresVision: (node) => node.role === 'img',
          maskedFields: labelProtectedFieldsWithoutRedaction(pageNodes, context.nodes),
          frameAnalysis: perceptionResult.analysis,
          // Sent every step, so kept short: the system prompt already explains the markings.
          legend: composeOptions.clearDefault
            ? 'Page as seen. Black = redacted (placeholder/type label); grey = not checked locally; "<TYPE> field" = sensitive field, pixels withheld.'
            : 'Grey = not checked locally; black = redacted (placeholder/type label); "<TYPE> field" = sensitive field, pixels withheld; the rest as seen.',
          compose: (regions, cleared, s, options) => {
            this.lastCleared = cleared;
            return client.compose(regions, cleared, s, blackbox, options);
          },
        });
        const cleared = composeOptions.clearDefault ? [] : this.lastCleared;
        imageRescanDeps = {
          rescan: async (imageBytes, redactionBoxes) => {
            const result = await client.rescan(imageBytes, [...redactionBoxes], [], scale);
            return { hits: result.hits.map((h) => ({ box: h.box as Box })), ringText: result.ringText };
          },
          // Same composition as the first time (clear-by-default stays clear-by-default), with the
          // dilated boxes and whatever the re-scan found blacked out on top.
          recompose: async (dilatedRegions) => {
            const composed = await client.compose([...dilatedRegions], cleared, scale, blackbox, composeOptions);
            return composed.webp;
          },
        };
      } catch {
        // The worker died between perceive and compose (the capture died with it): nothing is
        // sent, and the step is taken again from a fresh capture.
        this.deps.onEvent({ type: 'recovering', what: 'vision', detail: 'the redacted screenshot could not be composed: nothing was sent; observing the page again' });
        return 'failed';
      }
    }
    timings.sanitize = this.now() - t;

    t = this.now();
    let guarded: GuardedPayload;
    try {
      guarded = await this.guardWithRepair(context, imageRescanDeps);
    } catch (err) {
      const blocked = err instanceof GuardBlockedError ? err : new GuardBlockedError('SCHEMA');
      this.ledger.record({
        stepId,
        payload: context,
        timings,
        guardVerdict: { ok: false, rule: blocked.rule, entity: blocked.entity },
        policyVersion: this.policy.version,
        entityCountsByClass: countBy(context.redactions, (r) => r.class),
        entityCountsByChannel: countBy(context.redactions.flatMap((r) => r.sources), (s) => s),
        coverage: context.coverage,
        perception: perceptionEvidence,
      });
      this.deps.onEvent({ type: 'guard_blocked', rule: blocked.rule, entity: blocked.entity });
      this.deps.onEvent({ type: 'recovering', what: 'guard', detail: `nothing was sent this step (guard: ${blocked.rule}); observing the page again` });
      return 'failed';
    }
    this.controller.send({ type: 'guard_pass' });
    // The GUARDED payload — the exact bytes `sendToGateway` gets.
    this.ledger.record({
      stepId,
      payload: guarded,
      timings,
      guardVerdict: { ok: true },
      policyVersion: this.policy.version,
      entityCountsByClass: countBy(guarded.redactions, (r) => r.class),
      entityCountsByChannel: countBy(guarded.redactions.flatMap((r) => r.sources), (s) => s),
      coverage: guarded.coverage,
      perception: perceptionEvidence,
    });
    // DR-2: emitted before the network call, so a server failure still leaves the payload on screen.
    this.sentNames = new Map(guarded.nodes.map((n) => [n.id, n.name]));
    this.deps.onEvent({ type: 'sanitized_preview', payload: guarded, protectedFields: protectedFieldsOf(pageNodes, guarded.nodes) });
    timings.guard = this.now() - t;

    if (this.isFinished()) return 'ok';
    t = this.now();
    this.controller.send({ type: 'sent' });
    this.emitState();
    const serverCallBreach = this.budgets.recordServerCall();
    if (serverCallBreach) {
      this.stop(serverCallBreach);
      return 'ok';
    }
    const signal = this.controller.beginServerCall();
    let rawPlan: unknown;
    try {
      rawPlan = await this.sendWithRetry(guarded, signal);
    } catch (err) {
      if (this.isFinished()) return 'ok'; // cancelled while the call was in flight
      // The gateway's own tripwire found something our recognizers let through: seal it and send
      // once more, rather than lose the step.
      if (err instanceof StepFailedError && err.detail.startsWith('UNSANITIZED_CONTEXT')) {
        try {
          const rescrubbed = await guard(scrubPayloadText(guarded, this.policy, this.vault, true), this.policy, this.vault, { canaries: this.deps.canaries });
          rawPlan = await this.sendWithRetry(rescrubbed, signal);
          this.deps.onEvent({ type: 'recovering', what: 'server', detail: 'the gateway flagged unsealed text: sealed it and re-sent' });
        } catch (retryErr) {
          if (this.isFinished()) return 'ok';
          return this.serverFailure(retryErr);
        }
      } else {
        return this.serverFailure(err);
      }
    }
    this.controller.endServerCall();
    this.controller.send({ type: 'plan_received' });
    timings.server = this.now() - t;

    t = this.now();
    // T-6.13: the CAPTCHA_SOLVE hard denial needs this step's presence-kind nodes.
    const nodeEntities = new Map<string, string>();
    for (const n of guarded.nodes) {
      if (n.value?.kind === 'presence') nodeEntities.set(n.id, n.value.entity);
    }
    const hardDenialContext: HardDenialContext = { nodeEntities, extensionOwnedNodeIds: new Set() };
    const validated = validatePlan(rawPlan, stepId, hardDenialContext);
    if (!validated.ok) {
      this.deps.onEvent({ type: 'plan_rejected', stepId, reason: validated.reason });
      this.controller.send({ type: 'validation_rejected' });
      this.emitState();
      this.controller.send({ type: 'reconcile_reobserve' });
      this.emitState();
      this.history.push({ step_id: stepId, actions: [], outcome: `plan rejected: ${validated.reason}` });
      this.deps.onEvent({ type: 'step', step: { stepIndex, stepId, stageTimings: timings, actionsPlanned: 0, outcome: 'validation_failed' } });
      return 'failed';
    }
    this.controller.send({ type: 'validated' });
    timings.validate = this.now() - t;
    this.deps.onEvent({ type: 'plan', stepId, actions: validated.plan.actions.map((a) => this.describeAction(a)) });

    t = this.now();
    const outcome = await this.actOnPlan(validated.plan, stepId);
    timings.act = this.now() - t;

    // Which element each action targeted (an opaque node id): the model can tell what it already typed where.
    if (outcome !== 'retry') this.history.push({ step_id: stepId, actions: validated.plan.actions.map((a) => ('node' in a && a.node ? { op: a.op, node: a.node } : { op: a.op })), outcome });
    this.deps.onEvent({
      type: 'step',
      step: { stepIndex, stepId, stageTimings: timings, actionsPlanned: validated.plan.actions.length, outcome: outcome === 'retry' ? 'acted' : outcome },
    });

    if (outcome === 'done') {
      this.controller.send({ type: 'task_done' });
      this.emitState();
      return 'ok';
    }
    if (outcome === 'stopped') return 'ok';

    await this.awaitSettle();
    if (this.deps.browser && !this.isFinished()) await this.deps.browser.waitForPageReady();
    if (this.isFinished()) return 'ok';
    this.controller.send({ type: 'acted' });
    this.controller.send({ type: 'settled' });
    this.emitState();
    return outcome === 'retry' ? 'failed' : 'ok';
  }

  /** A value inside a DOM text run is redacted with the rectangles of its own characters, measured
   * by the page, not the run's whole box (a paragraph with one email in it keeps the rest of its
   * text visible). Falls back to the run's box whenever the page cannot measure it. */
  private async tightenTextRedactionBoxes(context: SanitizedContext): Promise<SanitizedContext> {
    const origins = context.redactions.map((r) => redactionSpanOrigin.get(r));
    const wanted = origins.filter((o): o is NonNullable<typeof o> => o !== undefined);
    if (wanted.length === 0 || !this.deps.pageQueries || this.pageQueriesUnanswered || this.pageDisconnected) return context;
    const measured = await this.contentPort.measureSpans(wanted.map((o) => ({ runId: o.runId, start: o.span[0], end: o.span[1] })));
    if (!measured) return context;
    let k = 0;
    const PAD = 2;
    const redactions = context.redactions.map((r, i) => {
      if (!origins[i]) return r;
      const rects = measured[k++] ?? [];
      const [rx, ry, rw, rh] = r.boxes[0] as Box;
      // Only rectangles inside the run's own box: anything else means the page changed under us.
      const inside = rects.filter(([x, y, w, h]) => x >= rx - 4 && y >= ry - 4 && x + w <= rx + rw + 4 && y + h <= ry + rh + 4);
      if (inside.length === 0 || inside.length !== rects.length) return r;
      return { ...r, boxes: inside.map(([x, y, w, h]) => [x - PAD, y - 1, w + PAD * 2, h + 2] as Box) as typeof r.boxes };
    });
    return { ...context, redactions };
  }

  /** Legacy (grey-by-default) clearance of the last composition, for its re-scan recompose. */
  private lastCleared: Box[] = [];

  private captchaPresent(): boolean {
    return [...this.allSeenNodes.values()].some((n) => n.domSignal?.entity === 'CAPTCHA');
  }

  /** Hands the page to the user until the CAPTCHA is gone (solved, or the page moved on); false
   * after `CAPTCHA_WAIT_MS`. Nothing about the CAPTCHA is ever sent or attempted. */
  private async waitForCaptchaCleared(): Promise<boolean> {
    this.deps.onEvent({ type: 'waiting_user', reason: 'captcha', detail: 'Solve the CAPTCHA on the page; AEGIS continues by itself once it is gone.' });
    for (let poll = 0; poll < Session.CAPTCHA_WAIT_MS / 2000; poll++) {
      await this.pause(2000);
      if (this.isFinished()) return false;
      try {
        await this.requestGraph();
      } catch (err) {
        if (err instanceof PageDisconnectedError && this.navigationPending) return true; // the page moved on
        throw err;
      }
      if (!this.captchaPresent()) return true;
    }
    return false;
  }

  /** The guard, and if it refuses the payload, one repair: every flagged string sealed
   * (`scrubPayloadText`), then the guard again. Throws `GuardBlockedError` if even that fails. */
  private async guardWithRepair(context: SanitizedContext, imageRescan: ImageRescanDeps | undefined): Promise<GuardedPayload> {
    try {
      return await guard(context, this.policy, this.vault, { imageRescan, canaries: this.deps.canaries, unredactedRefs: this.unredactedRefs });
    } catch (err) {
      if (!(err instanceof GuardBlockedError) || (err.rule !== 'PATTERN' && err.rule !== 'VAULT_LEAK')) throw err;
      const repaired = await guard(scrubPayloadText(context, this.policy, this.vault), this.policy, this.vault, { imageRescan, canaries: this.deps.canaries });
      this.deps.onEvent({ type: 'recovering', what: 'guard', detail: `the guard found unsealed text (${err.entity ?? err.rule}): sealed it before sending` });
      return repaired;
    }
  }

  /** A server call that failed even after its retries: a configuration problem or an exhausted
   * quota ends the task (retrying cannot fix it); anything else fails just this step. */
  private serverFailure(err: unknown): 'ok' | 'failed' {
    const detail = describeSendError(err);
    if (classifySendFailure(err, Session.MAX_RETRY_WAIT_S).kind === 'fatal') {
      this.stop('SERVER_ERROR', detail);
      return 'ok';
    }
    this.deps.onEvent({ type: 'recovering', what: 'server', detail: `no plan (${detail}); trying the step again` });
    return 'failed';
  }

  private describeAction(action: ActionPlan['actions'][number]): string {
    const node = 'node' in action && typeof action.node === 'string' ? action.node : undefined;
    const target = node ? `"${(this.sentNames.get(node) || node).slice(0, 60)}"` : '';
    switch (action.op) {
      case 'type':
        // A ref is a sealed placeholder; literal text came back from the model, which only ever
        // saw sanitized input, so it holds no raw page value.
        return `type ${'ref' in action && action.ref ? action.ref : `"${('text' in action ? action.text : '').slice(0, 40)}"`} → ${target}`;
      case 'click_point':
        return `click_point (${Math.round(action.x)}, ${Math.round(action.y)}) ${action.label ?? ''}`.trim();
      case 'scroll':
        return `scroll ${action.direction} ${action.amount ?? ''}`.trim();
      case 'select':
        return `select "${action.option}" → ${target}`;
      case 'press_key':
        return `press ${action.key}${target ? ` → ${target}` : ''}`;
      case 'navigate':
      case 'open_tab':
        return `${action.op} ${action.url.slice(0, 80)}`;
      case 'done':
        return `done${action.summary ? `: ${action.summary}` : ''}`;
      case 'stop':
        return `stop: ${action.reason}${action.detail ? ` (${action.detail})` : ''}`;
      default:
        return `${action.op} → ${target}`.replace(/ → $/, '');
    }
  }

  /** One step request, with a client-side deadline, re-sent while the gateway is busy (its
   * Retry-After), restarting or briefly unreachable (exponential back-off), and on a fresh gateway
   * session when the gateway no longer knows ours. The gateway releases the step lease on a failed
   * model call, so the same step id is re-sent. Throws once the failure is permanent or the
   * attempts run out. */
  private async sendWithRetry(payload: GuardedPayload, signal: AbortSignal): Promise<unknown> {
    let reopened = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.sendToGateway(payload, AbortSignal.any([signal, AbortSignal.timeout(Session.STEP_TIMEOUT_MS)]));
      } catch (err) {
        if (signal.aborted || this.isFinished()) throw err;
        const failure = classifySendFailure(err, Session.MAX_RETRY_WAIT_S);
        if (failure.kind === 'reopen' && !reopened && this.deps.reopenSession) {
          reopened = true;
          try {
            await this.deps.reopenSession();
            this.deps.onEvent({ type: 'recovering', what: 'server', detail: 'the gateway lost this session (restarted?): opened a new one and re-sent' });
            continue;
          } catch {
            // Could not open one either: treated like an unreachable gateway below.
          }
        }
        if (failure.kind === 'fatal' || (failure.kind === 'reopen' && reopened) || attempt >= Session.SEND_ATTEMPTS - 1) throw err;
        const waitS = failure.kind === 'retry' && failure.waitS !== undefined ? failure.waitS : Math.min(16, Session.DEFAULT_RETRY_WAIT_S * 2 ** attempt);
        this.deps.onEvent({ type: 'waiting', seconds: Math.ceil(waitS), reason: describeSendError(err) });
        await this.pause(waitS * 1000, signal);
        if (signal.aborted) throw err;
      }
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
      originKey: this.originKey,
      confirmed,
      targetNode,
      pageNodes: this.allSeenNodes.values(),
    });
    if (!result.ok) return { ok: false, code: result.code };

    const actionId = `a-${Math.random().toString(36).slice(2)}`;
    const dispatched = await this.dispatchAndAwait(actionId, { op: 'type', node: req.node, text: result.value, clearFirst: req.clearFirst });
    if (!dispatched.ok) return { ok: false, code: dispatched.reason ?? 'NODE_UNRESOLVED' };
    return { ok: true };
  }

  /** Runs every action in a validated plan, in order. `'retry'` means an action could not be
   * carried out (preflight failed, a ref was refused): the loop re-observes and asks again, within
   * the reconciliation budget, and the failure is in `history` so the model sees it. Every path
   * that ends the task emits a `stopped`/`done` event, so the panel never sits on "Running". */
  private async actOnPlan(plan: ActionPlan, stepId: string): Promise<'acted' | 'done' | 'stopped' | 'retry'> {
    this.reconcile.resetForNewAction();
    const status = (index: number, st: ActionStatus, reason?: string) => this.deps.onEvent({ type: 'action_status', stepId, index, status: st, reason });
    // Actions after the one that ended this plan early were validated but never run.
    const skipRest = (from: number, reason: string) => {
      for (let i = from; i < plan.actions.length; i++) status(i, 'skipped', reason);
    };
    const failed = (index: number, op: string, code: string): 'stopped' | 'retry' => {
      status(index, 'failed', code);
      skipRest(index + 1, 'an earlier action failed');
      this.history.push({ step_id: stepId, actions: [{ op }], outcome: code });
      const decision = this.reconcile.decide(false);
      if (decision.action === 'stop') {
        this.stop(decision.reason);
        return 'stopped';
      }
      return 'retry';
    };
    for (const [index, action] of plan.actions.entries()) {
      if (action.op === 'stop') {
        status(index, 'executed');
        skipRest(index + 1, 'the model stopped');
        this.stop('MODEL_STOPPED', action.detail ? `${action.reason} (${action.detail})` : action.reason);
        return 'stopped';
      }
      if (action.op === 'done') {
        status(index, 'executed');
        skipRest(index + 1, 'after done');
        this.deps.onEvent({ type: 'done', summary: action.summary });
        return 'done';
      }

      const classified = classifyAction(action);
      if (classified.kind === 'host') {
        if (classified.op === 'report') this.deps.onEvent({ type: 'report', title: classified.title, content: classified.content });
        if (classified.op === 'wait') await new Promise((resolve) => setTimeout(resolve, classified.ms));
        if (this.isFinished()) return 'stopped';
        status(index, 'executed');
        if (classified.op === 'ask_user') {
          // The model needs something only the user knows: ask, and carry on with the answer
          // (it joins the task text, which is sanitized like any other). No answer ends the task.
          this.deps.onEvent({ type: 'ask_user', question: classified.question });
          const answer = this.deps.askUser ? await this.deps.askUser(classified.question) : null;
          if (this.isFinished()) return 'stopped';
          if (!answer || !answer.trim()) {
            skipRest(index + 1, 'waiting for your answer');
            this.deps.onEvent({ type: 'report', title: 'AEGIS needs your input', content: classified.question });
            this.stop('NEEDS_USER');
            return 'stopped';
          }
          this.task = `${this.task}\n(The user answered "${classified.question.slice(0, 200)}": ${answer.trim().slice(0, 500)})`;
          skipRest(index + 1, 'the user answered a question');
          return 'acted';
        }
        continue;
      }

      if (classified.kind === 'rehydrate') {
        const resolved = await this.resolveAndDispatchRehydration(classified);
        if (!resolved.ok) {
          this.deps.onEvent({ type: 'rehydration_rejected', code: resolved.code });
          return failed(index, 'type', `REHYDRATE_${resolved.code}`);
        }
        status(index, 'executed');
        continue;
      }

      if (classified.kind === 'browser') {
        const browser = this.deps.browser;
        if (!browser) return failed(index, classified.op, 'FAILED_UNSUPPORTED');
        const url = 'url' in classified ? parseWebUrl(classified.url) : null;
        if ('url' in classified && !url) return failed(index, classified.op, 'FAILED_URL_REJECTED');
        // design.md §9.2: an action that goes to another origin is confirmed by the user.
        if (url && url.origin !== this.originKey) {
          const description = `${classified.op === 'open_tab' ? 'open in a new tab' : 'go to'} ${url.origin}`;
          this.deps.onEvent({ type: 'confirmation_required', risk: 'medium', description });
          const approved = this.deps.confirm ? await this.deps.confirm('medium', description) : true;
          if (!approved) {
            status(index, 'declined', 'you pressed Deny');
            skipRest(index + 1, 'you pressed Deny');
            this.stop('USER_DECLINED');
            return 'stopped';
          }
        }
        this.actedSinceObserve = true;
        this.lastDispatchedActionId = null;
        try {
          if (classified.op === 'navigate') await browser.navigate(url!.href);
          else if (classified.op === 'open_tab') await browser.openTab(url!.href);
          else if (classified.op === 'go_back') await browser.goBack();
          else if (classified.op === 'go_forward') await browser.goForward();
          else await browser.reload();
        } catch {
          return failed(index, classified.op, 'FAILED_NAVIGATION');
        }
        status(index, 'executed');
        // The page (or tab) changes: the rest of this plan targeted the old one.
        skipRest(index + 1, 'the page changed');
        return 'acted';
      }

      // The signals come from the page as this extension saw it, never from the model's plan.
      const targetId = 'node' in classified.action ? classified.action.node : undefined;
      const target = targetId ? this.allSeenNodes.get(targetId) : undefined;
      const clicks = classified.action.op === 'click' || classified.action.op === 'double_click' || (classified.action.op === 'press_key' && classified.action.key === 'Enter');
      const signals: RiskSignals = { highRiskVerbInName: clicks && !!target && hasHighRiskVerb(target.name) };
      const level = classifyRisk(classified.action, signals);
      if (requiresConfirmation(level)) {
        const description = target ? `${classified.action.op} "${target.name.slice(0, 60)}"` : `${classified.action.op} on the page`;
        this.deps.onEvent({ type: 'confirmation_required', risk: level, description });
        const approved = this.deps.confirm ? await this.deps.confirm(level, description) : true;
        if (!approved) {
          status(index, 'declined', 'you pressed Deny');
          skipRest(index + 1, 'you pressed Deny');
          this.stop('USER_DECLINED');
          return 'stopped';
        }
      }

      const actionId = `a-${Math.random().toString(36).slice(2)}`;
      let result: { ok: boolean; reason?: string };
      try {
        result = await this.dispatchAndAwait(actionId, classified.action);
      } catch (err) {
        // The previous action loaded a new page: the rest of this plan targeted the old one.
        if (err instanceof PageDisconnectedError && this.navigationPending) {
          skipRest(index, 'the page navigated');
          return 'acted';
        }
        throw err;
      }
      if (!result.ok) return failed(index, classified.action.op, `FAILED_${result.reason ?? 'UNKNOWN'}`);
      status(index, 'executed');
      if (this.navigationPending) {
        skipRest(index + 1, 'the page navigated');
        return 'acted';
      }
    }
    return 'acted';
  }

}
