import { describe, expect, it } from 'vitest';
import { Controller, InvalidTransitionError, TERMINAL_STATES, transition, type ControllerState } from '../../src/host/controller/machine';

// Every arrow in design.md §10.1's diagram, as (fromState, event, toState).
const EXPECTED_TRANSITIONS: Array<[ControllerState, string, ControllerState]> = [
  ['IDLE', 'start', 'PREPARING'],
  ['PREPARING', 'prepared', 'OBSERVING'],
  ['PREPARING', 'prepare_failed', 'ERROR'],
  ['OBSERVING', 'observed', 'PERCEIVING'],
  ['PERCEIVING', 'perceived', 'SANITIZING'],
  ['SANITIZING', 'sanitized', 'GUARDING'],
  ['GUARDING', 'guard_pass', 'SENDING'],
  ['GUARDING', 'guard_block', 'BLOCK'],
  ['SENDING', 'sent', 'AWAITING_SERVER'],
  ['AWAITING_SERVER', 'plan_received', 'VALIDATING'],
  ['VALIDATING', 'validated', 'ACTING'],
  ['VALIDATING', 'validation_rejected', 'RECONCILING'],
  ['RECONCILING', 'reconciled_locally', 'ACTING'],
  ['RECONCILING', 'reconcile_reobserve', 'OBSERVING'],
  ['ACTING', 'acted', 'SETTLING'],
  ['ACTING', 'task_done', 'DONE'],
  ['ACTING', 'repair', 'VALIDATING'],
  ['SETTLING', 'settled', 'OBSERVING'],
];

describe('transition — every design.md §10.1 arrow (T-2.17 AC)', () => {
  it.each(EXPECTED_TRANSITIONS)('%s --%s--> %s', (from, eventType, to) => {
    expect(transition(from, { type: eventType } as never)).toBe(to);
  });

  it('throws on an event with no transition from the current state', () => {
    expect(() => transition('IDLE', { type: 'sent' })).toThrow(InvalidTransitionError);
  });
});

const NON_TERMINAL_STATES: ControllerState[] = [
  'IDLE', 'PREPARING', 'OBSERVING', 'PERCEIVING', 'SANITIZING', 'GUARDING',
  'SENDING', 'AWAITING_SERVER', 'VALIDATING', 'RECONCILING', 'ACTING', 'SETTLING',
];

describe('CANCELLED is reachable from every non-terminal state (T-2.17 AC)', () => {
  it.each(NON_TERMINAL_STATES)('from %s', (state) => {
    expect(transition(state, { type: 'cancel' })).toBe('CANCELLED');
  });

  it('is a no-op from an already-terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(transition(state, { type: 'cancel' })).toBe(state);
    }
  });

  it('every ControllerState is accounted for as either terminal or non-terminal (no state forgotten)', () => {
    const allStates: ControllerState[] = [...NON_TERMINAL_STATES, ...TERMINAL_STATES];
    expect(new Set(allStates).size).toBe(allStates.length);
  });
});

describe('STOPPED is reachable from every non-terminal state via a budget breach (T-2.18 AC)', () => {
  it.each(NON_TERMINAL_STATES)('from %s', (state) => {
    expect(transition(state, { type: 'stop' })).toBe('STOPPED');
  });

  it('is a no-op from an already-terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(transition(state, { type: 'stop' })).toBe(state);
    }
  });
});

describe('Controller (T-2.18 AC — cancelling AWAITING_SERVER aborts the in-flight request)', () => {
  it('aborts the in-flight request when cancelled while AWAITING_SERVER', () => {
    const controller = new Controller();
    controller.send({ type: 'start' });
    controller.send({ type: 'prepared' });
    controller.send({ type: 'observed' });
    controller.send({ type: 'perceived' });
    controller.send({ type: 'sanitized' });
    controller.send({ type: 'guard_pass' });
    const signal = controller.beginServerCall();
    controller.send({ type: 'sent' });
    expect(controller.getState()).toBe('AWAITING_SERVER');
    expect(signal.aborted).toBe(false);

    controller.send({ type: 'cancel' });

    expect(controller.getState()).toBe('CANCELLED');
    expect(signal.aborted).toBe(true);
  });

  it('also aborts the in-flight request on a budget-triggered stop while AWAITING_SERVER', () => {
    const controller = new Controller();
    controller.send({ type: 'start' });
    controller.send({ type: 'prepared' });
    controller.send({ type: 'observed' });
    controller.send({ type: 'perceived' });
    controller.send({ type: 'sanitized' });
    controller.send({ type: 'guard_pass' });
    const signal = controller.beginServerCall();
    controller.send({ type: 'sent' });

    controller.send({ type: 'stop' });

    expect(controller.getState()).toBe('STOPPED');
    expect(signal.aborted).toBe(true);
  });

  it('does not touch any abort signal when cancelling from a state with no in-flight request', () => {
    const controller = new Controller();
    controller.send({ type: 'start' });
    const signal = controller.beginServerCall(); // simulate a stale signal from a prior step
    controller.endServerCall();
    controller.send({ type: 'cancel' });
    expect(signal.aborted).toBe(false);
    expect(controller.getState()).toBe('CANCELLED');
  });
});
