// design.md §10.1 (T-2.17) — the agent's state machine, as an explicit table rather than nested
// async: FR-3 requires the user can stop the agent, and `CANCELLED` must be reachable from every
// non-terminal state, which is much easier to guarantee (and to prove with a test) against an
// explicit table than against control flow scattered across async functions.
//
// [A] The design diagram doesn't enumerate every state by name in one place; this file names them
// from the diagram's boxes and arrows (phase_2_spine.md §4.1). `BLOCK`, `DONE`, `ERROR`, `STOPPED`
// and `CANCELLED` are treated as terminal (no outgoing transitions) — `BLOCK` because Phase 2's
// guard stub always passes so it is unreached in practice, and because the diagram shows no arrow
// leaving it. That leaves 12 non-terminal states `CANCELLED` must be reachable from; the task
// table's "10" is likely counting a slightly different grouping of the same diagram and is not
// treated as a hard constraint here — what matters is that every actually-reachable non-terminal
// state can cancel, which the test suite checks exhaustively.

export type ControllerState =
  | 'IDLE'
  | 'PREPARING'
  | 'OBSERVING'
  | 'PERCEIVING'
  | 'SANITIZING'
  | 'GUARDING'
  | 'BLOCK'
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
  | { type: 'guard_block' }
  | { type: 'sent' }
  | { type: 'plan_received' }
  | { type: 'validated' }
  | { type: 'validation_rejected' }
  | { type: 'reconciled_locally' }
  | { type: 'reconcile_reobserve' }
  | { type: 'acted' }
  | { type: 'task_done' }
  | { type: 'repair' }
  | { type: 'settled' }
  | { type: 'cancel' }
  | { type: 'stop' };

const TABLE: Partial<Record<`${ControllerState}:${ControllerEvent['type']}`, ControllerState>> = {
  'IDLE:start': 'PREPARING',
  'PREPARING:prepared': 'OBSERVING',
  'PREPARING:prepare_failed': 'ERROR',
  'OBSERVING:observed': 'PERCEIVING',
  'PERCEIVING:perceived': 'SANITIZING',
  'SANITIZING:sanitized': 'GUARDING',
  'GUARDING:guard_pass': 'SENDING',
  'GUARDING:guard_block': 'BLOCK',
  'SENDING:sent': 'AWAITING_SERVER',
  'AWAITING_SERVER:plan_received': 'VALIDATING',
  'VALIDATING:validated': 'ACTING',
  'VALIDATING:validation_rejected': 'RECONCILING',
  'RECONCILING:reconciled_locally': 'ACTING',
  'RECONCILING:reconcile_reobserve': 'OBSERVING',
  'ACTING:acted': 'SETTLING',
  'ACTING:task_done': 'DONE',
  'ACTING:repair': 'VALIDATING',
  'SETTLING:settled': 'OBSERVING',
};

export const TERMINAL_STATES: ReadonlySet<ControllerState> = new Set(['DONE', 'ERROR', 'CANCELLED', 'STOPPED', 'BLOCK']);

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
    if ((event.type === 'cancel' || event.type === 'stop') && this.state === 'AWAITING_SERVER') {
      this.abortController?.abort();
    }
    this.state = transition(this.state, event);
    return this.state;
  }
}
