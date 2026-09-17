// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentPortClient, type HostPort } from '../../src/host/port';
import { Session, type SessionEvent } from '../../src/host/session';
import type { WireScreenNode } from '../../src/shared/messages';

class ScriptedPort implements HostPort {
  sent: unknown[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.messageListeners.push(cb) };
  onDisconnect = { addListener: () => {} };

  constructor(private readonly respond: (sent: unknown, emit: (message: unknown) => void) => void) {}

  postMessage(message: unknown): void {
    this.sent.push(message);
    queueMicrotask(() => this.respond(message, (m) => this.emit(m)));
  }

  emit(message: unknown): void {
    for (const cb of this.messageListeners) cb(message);
  }
}

const NODE: WireScreenNode = {
  id: 'n-1',
  frame: 'f-0',
  role: 'button',
  name: 'Sign in',
  box: [0, 0, 100, 30],
  z: 0,
  state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
  affordances: ['click'],
  container: 'root',
  textRuns: [],
};

function buildSession(
  sendToGateway: (payload: unknown, signal: AbortSignal) => Promise<unknown>,
  respond: (sent: unknown, emit: (message: unknown) => void) => void,
  overrides: Partial<ConstructorParameters<typeof Session>[0]> = {},
): { session: Session; events: SessionEvent[]; port: ScriptedPort } {
  const port = new ScriptedPort(respond);
  const events: SessionEvent[] = [];
  // Forward reference: the handlers below must close over `session` before it exists, since
  // `ContentPortClient` needs its handlers at construction time but `Session` needs the
  // constructed `ContentPortClient`. `session` is assigned exactly once, right after.
  // eslint-disable-next-line prefer-const
  let session!: Session;
  const contentPort = new ContentPortClient(port, {
    onGraph: (m) => session.onGraph(m),
    onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
  });
  session = new Session({
    contentPort,
    sendToGateway,
    guardOrigin: 'http://localhost:5600',
    pageCategory: 'unknown',
    pageTitle: 'Test fixture',
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { session, events, port };
}

function graphResponder(sent: unknown, emit: (m: unknown) => void): void {
  const msg = sent as { type: string; actionId?: string };
  if (msg.type === 'extract') {
    emit({ type: 'graph', frame: 'f-0', nodes: [NODE], removed: [], privacyEpoch: 0, reason: 'initial' });
  }
  if (msg.type === 'dispatch-action') {
    emit({ type: 'action-result', actionId: msg.actionId, ok: true });
    emit({ type: 'settled', actionId: msg.actionId });
  }
}

describe('Session — golden path (phase_2_spine.md §10 milestone)', () => {
  it('reaches DONE and emits a done event when the plan says done', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({
      step_id: 's-1',
      actions: [{ op: 'done', summary: 'Logged in' }],
    });
    const { session, events } = buildSession(sendToGateway, graphResponder);

    await session.start('log in');

    expect(session.getState()).toBe('DONE');
    expect(events.some((e) => e.type === 'done' && e.summary === 'Logged in')).toBe(true);
    expect(events.some((e) => e.type === 'step')).toBe(true);
  });

  it('dispatches a click action through the content port and records the step', async () => {
    const sendToGateway = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, events, port } = buildSession(sendToGateway, graphResponder);

    await session.start('click sign in');

    expect(session.getState()).toBe('DONE');
    expect(port.sent.some((m) => (m as { type?: string }).type === 'dispatch-action')).toBe(true);
    const steps = events.filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);
  });
});

describe('Session — budgets (T-2.18 AC)', () => {
  it('stops with STEPS_EXCEEDED, distinct reason code, when the step budget is hit', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'wait', ms: 1 }] });
    const { session, events } = buildSession(sendToGateway, graphResponder, {
      budgetLimits: { stepsPerTask: 1, serverCallsPerStep: 4, localRepairsPerAction: 2, capturesPerStep: 3, settleTimeoutMs: 1500, serverResponseTimeoutMs: 20_000, taskWallClockMs: 600_000 },
    });

    await session.start('loop forever');

    expect(session.getState()).toBe('STOPPED');
    expect(events).toContainEqual({ type: 'stopped', reason: 'STEPS_EXCEEDED' });
  });

  it('a schema-invalid plan is rejected and does not dispatch anything', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ not: 'a valid plan' });
    const { session, events, port } = buildSession(sendToGateway, graphResponder, {
      budgetLimits: { stepsPerTask: 1, serverCallsPerStep: 4, localRepairsPerAction: 2, capturesPerStep: 3, settleTimeoutMs: 1500, serverResponseTimeoutMs: 20_000, taskWallClockMs: 600_000 },
    });

    await session.start('do something');

    expect(port.sent.some((m) => (m as { type?: string }).type === 'dispatch-action')).toBe(false);
    expect(events.some((e) => e.type === 'step' && e.step.outcome === 'validation_failed')).toBe(true);
  });
});

describe('Session — cancellation (FR-3)', () => {
  it('cancel() transitions to CANCELLED and emits a stopped event', () => {
    const sendToGateway = vi.fn();
    const { session, events } = buildSession(sendToGateway, graphResponder);
    session.cancel();
    expect(session.getState()).toBe('CANCELLED');
    expect(events).toContainEqual({ type: 'stopped', reason: 'CANCELLED' });
  });
});
