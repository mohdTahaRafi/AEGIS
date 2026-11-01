// design.md §10.1 (T-2.17) — the agent's state machine, as an explicit table rather than nested
// async: FR-3 requires the user can stop the agent, and `CANCELLED` must be reachable from every
// non-terminal state, which is much easier to guarantee (and to prove with a test) against an
// explicit table than against control flow scattered across async functions.
//
// [A] The design diagram doesn't enumerate every state by name in one place; this file names them
// from the diagram's boxes and arrows (phase_2_spine.md §4.1). `DONE`, `ERROR`, `STOPPED` and
// `CANCELLED` are terminal (no outgoing transitions). The diagram's `BLOCK` state is not modelled:
// a guard block fails only the step, so the session sends `recover` from `GUARDING` instead.
// Every non-terminal state can cancel, which the test suite checks exhaustively.

export type ControllerState =
  | 'IDLE'
  | 'PREPARING'
  | 'OBSERVING'
  | 'PERCEIVING'
  | 'SANITIZING'
  | 'GUARDING'
  | 'SENDING'
  | 'AWAITING_SERVER'
  | 'VALIDATING'
  | 'RECONCILING'
  | 'ACTING'
  | 'SETTLING'
  | 'DONE'
  | 'ERROR'
  | 'CANCELLED'
  | 'STOPPED';

export type ControllerEvent =
  | { type: 'start' }
  | { type: 'prepared' }
  | { type: 'prepare_failed' }
  | { type: 'observed' }
  | { type: 'perceived' }
  | { type: 'sanitized' }
  | { type: 'guard_pass' }
  | { type: 'sent' }
  | { type: 'plan_received' }
  | { type: 'validated' }
  | { type: 'validation_rejected' }
  | { type: 'reconcile_reobserve' }
  | { type: 'acted' }
  | { type: 'task_done' }
  | { type: 'repair' }
  | { type: 'settled' }
  | { type: 'cancel' }
  | { type: 'stop' }
  /** A step failed part-way (a crash, an unreachable page or server): back to OBSERVING, from any
   * non-terminal state, so the next step starts from a fresh observation instead of the task
   * ending. */
  | { type: 'recover' };

const TABLE: Partial<Record<`${ControllerState}:${ControllerEvent['type']}`, ControllerState>> = {
  'IDLE:start': 'PREPARING',
  'PREPARING:prepared': 'OBSERVING',
  'PREPARING:prepare_failed': 'ERROR',
  'OBSERVING:observed': 'PERCEIVING',
  'PERCEIVING:perceived': 'SANITIZING',
  'SANITIZING:sanitized': 'GUARDING',
  'GUARDING:guard_pass': 'SENDING',
  'SENDING:sent': 'AWAITING_SERVER',
  'AWAITING_SERVER:plan_received': 'VALIDATING',
  'VALIDATING:validated': 'ACTING',
  'VALIDATING:validation_rejected': 'RECONCILING',
  'RECONCILING:reconcile_reobserve': 'OBSERVING',
  'ACTING:acted': 'SETTLING',
  'ACTING:task_done': 'DONE',
  'ACTING:repair': 'VALIDATING',
  'SETTLING:settled': 'OBSERVING',
};

export const TERMINAL_STATES: ReadonlySet<ControllerState> = new Set(['DONE', 'ERROR', 'CANCELLED', 'STOPPED']);

export class InvalidTransitionError extends Error {
  constructor(state: ControllerState, event: ControllerEvent) {
    super(`no transition for event "${event.type}" from state "${state}"`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Pure reducer. `cancel` (user-initiated, FR-3) and `stop` (a budget breach — design.md §10.2:
 * every budget is a *stop* condition, never a *degrade* condition) are both handled before the
 * table lookup and work from *any* non-terminal state, landing on `CANCELLED`/`STOPPED`
 * respectively; a terminal state ignores either (the task has already finished one way or
 * another). Any other event with no table entry throws: an invalid transition is a programming
 * error in the caller's own step tracking, not a recoverable runtime condition.
 */
export function transition(state: ControllerState, event: ControllerEvent): ControllerState {
  if (event.type === 'cancel') {
    return TERMINAL_STATES.has(state) ? state : 'CANCELLED';
  }
  if (event.type === 'stop') {
    return TERMINAL_STATES.has(state) ? state : 'STOPPED';
  }
  if (event.type === 'recover') {
    return TERMINAL_STATES.has(state) ? state : 'OBSERVING';
  }
  const next = TABLE[`${state}:${event.type}`];
  if (!next) throw new InvalidTransitionError(state, event);
  return next;
}

/**
 * Wraps the pure reducer with the one piece of real side-effecting state the design calls out
 * explicitly: cancelling while `AWAITING_SERVER` must abort the in-flight request (T-2.18 AC), not
 * just relabel the state and let the response arrive anyway.
 */
export class Controller {
  private state: ControllerState = 'IDLE';
  private abortController: AbortController | null = null;

  getState(): ControllerState {
    return this.state;
  }

  /** Call once, right before making the network request, to get the signal to pass to `fetch`. */
  beginServerCall(): AbortSignal {
    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  endServerCall(): void {
    this.abortController = null;
  }

  send(event: ControllerEvent): ControllerState {
    if ((event.type === 'cancel' || event.type === 'stop' || event.type === 'recover') && this.state === 'AWAITING_SERVER') {
      this.abortController?.abort();
    }
    this.state = transition(this.state, event);
    return this.state;
  }
}
