// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentPortClient, type HostPort } from '../../src/host/port';
import { Session, type SessionEvent } from '../../src/host/session';
import type { PerceptionClient } from '../../src/host/perception-client/client';
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
    emit({ type: 'graph', frame: 'f-0', nodes: [NODE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
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

describe('Session — sanitized preview survives a network failure (T-7.4, DR-2)', () => {
  it('emits sanitized_preview with the built context BEFORE sendToGateway is called, and it is the last thing emitted when the network call then fails', async () => {
    const sendToGateway = vi.fn().mockRejectedValue(new Error('network unreachable — airplane mode'));
    const { session, events } = buildSession(sendToGateway, graphResponder);

    await session.start('click sign in');

    // The preview must exist and must have been emitted before sendToGateway was ever invoked —
    // proving the sanitized context (detection + redaction, entirely local) was built and
    // guard-passed independently of whether the network call that follows it succeeds.
    const previewIndex = events.findIndex((e) => e.type === 'sanitized_preview');
    expect(previewIndex).toBeGreaterThanOrEqual(0);
    const preview = events[previewIndex] as Extract<SessionEvent, { type: 'sanitized_preview' }>;
    expect(preview.payload.nodes.length).toBeGreaterThan(0);

    // The preview is followed later by the 'stopped'/SERVER_ERROR event, never by a 'step' event
    // (the plan never validated — there was no plan) — so main.tsx's `lastPayload` state, once set
    // by 'sanitized_preview', is never subsequently cleared for this failed step.
    expect(events.slice(previewIndex + 1).some((e) => e.type === 'step')).toBe(false);

    // The session still ends up stopped with SERVER_ERROR — the fix doesn't paper over the
    // failure, it just keeps the already-built local privacy pipeline's output visible through it.
    expect(events.some((e) => e.type === 'stopped' && e.reason === 'SERVER_ERROR')).toBe(true);
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

describe('Session — canary check (design.md §7.6 step 6, T-5.8, phase_5_measurement.md §16a)', () => {
  // Short enough to stay below packages/recognizers' generic high-entropy SECRET fallback
  // (24+ chars) — isolates guard step 6 rather than the independent pattern re-sweep, exactly
  // like test/unit/canary.spec.ts's SHORT_CANARY.
  const SHORT_CANARY = 'CANARYSHORT123';

  function canaryResponder(sent: unknown, emit: (m: unknown) => void): void {
    const msg = sent as { type: string; actionId?: string };
    if (msg.type === 'extract') {
      emit({
        type: 'graph',
        frame: 'f-0',
        nodes: [],
        removed: [],
        textRuns: [{ id: 't-1', box: [0, 0, 10, 10], text: SHORT_CANARY }],
        privacyEpoch: 0,
        reason: 'initial',
        hostileDynamic: false,
      });
    }
  }

  it('a harness-supplied canary blocks the step, never reaching sendToGateway', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'wait', ms: 1 }] });
    const { session, events } = buildSession(sendToGateway, canaryResponder, { canaries: [SHORT_CANARY] });

    await session.start('report the page');

    expect(sendToGateway).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'guard_blocked' && e.rule === 'CANARY')).toBe(true);
    expect(events).toContainEqual({ type: 'stopped', reason: 'BLOCKED' });
  });

  it('without a canary list (the production default), the same page is not blocked by step 6', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done', summary: 'ok' }] });
    const { session, events } = buildSession(sendToGateway, canaryResponder);

    await session.start('report the page');

    expect(events.some((e) => e.type === 'guard_blocked')).toBe(false);
    expect(session.getState()).toBe('DONE');
  });
});

// design.md §5.5, T-6.7 — "a mutation storm disables the image path and eventually stops with an
// explanation." The image-path-disabled half is exercised structurally (perceptionResult stays
// null exactly as it does with no `deps.perception` at all — see `run-step.ts`); this suite covers
// the observable half: the graceful stop after a sustained streak, and NOT stopping on a single
// hostile-dynamic reading.
describe('Session — hostile-dynamic mode (design.md §5.5, T-6.7)', () => {
  function hostileDynamicResponder(sent: unknown, emit: (m: unknown) => void): void {
    const msg = sent as { type: string; actionId?: string };
    if (msg.type === 'extract') {
      emit({ type: 'graph', frame: 'f-0', nodes: [NODE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: true });
    }
    if (msg.type === 'dispatch-action') {
      emit({ type: 'action-result', actionId: msg.actionId, ok: true });
      emit({ type: 'settled', actionId: msg.actionId });
    }
  }

  it('stops with HOSTILE_DYNAMIC after a sustained streak of hostile-dynamic steps, never reaching DONE', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-x', actions: [{ op: 'click', node: 'n-1' }] });
    const { session, events } = buildSession(sendToGateway, hostileDynamicResponder);

    await session.start('click sign in');

    expect(session.getState()).toBe('STOPPED');
    expect(events).toContainEqual({ type: 'stopped', reason: 'HOSTILE_DYNAMIC' });
  });

  it('a single hostile-dynamic reading does not stop the agent — a brief storm gets a chance to settle', async () => {
    let extractCount = 0;
    const respond = (sent: unknown, emit: (m: unknown) => void) => {
      const msg = sent as { type: string; actionId?: string };
      if (msg.type === 'extract') {
        extractCount += 1;
        emit({ type: 'graph', frame: 'f-0', nodes: [NODE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: extractCount === 1 });
      }
      if (msg.type === 'dispatch-action') {
        emit({ type: 'action-result', actionId: msg.actionId, ok: true });
        emit({ type: 'settled', actionId: msg.actionId });
      }
    };
    const sendToGateway = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, events } = buildSession(sendToGateway, respond);

    await session.start('click sign in');

    expect(session.getState()).toBe('DONE');
    expect(events.some((e) => e.type === 'stopped')).toBe(false);
  });
});

// T-6.9, design.md §18.3 — `dom_only` "disables Channel V; never attaches images," exactly the
// image-path-disabled shape hostile-dynamic mode already produces (T-6.7) — see that check in
// session.ts's step loop. Proven here by a `perception.capture` that THROWS if ever called: if
// this arm were wired wrong and still attempted a capture, this test would fail loudly rather
// than silently passing on an untested path.
describe('Session — dom_only ablation arm (T-6.9)', () => {
  it('never calls capture()/the perception client even though deps.perception is present', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done', summary: 'ok' }] });
    const { session, events } = buildSession(sendToGateway, graphResponder, {
      ablation: 'dom_only',
      perception: {
        client: {} as PerceptionClient,
        capture: async () => {
          throw new Error('capture() must never be called under dom_only');
        },
      },
    });

    await session.start('report the page');

    expect(session.getState()).toBe('DONE');
    expect(events.some((e) => e.type === 'stopped')).toBe(false);
  });
});

// T-6.12 (FR-36, design.md §7.1 step 9) — session un-redact, the only de-escalation path besides
// a versioned policy allow-rule. Exercised through the real `Session.start()`/`getLedger()` path,
// not by reaching into private state — `unredactedRefs` is a private field precisely so nothing
// outside this class can touch it except through the audited `unredact()` method.
const EMAIL_NODE: WireScreenNode = {
  id: 'n-2',
  frame: 'f-0',
  role: 'textbox',
  name: 'Contact email',
  box: [0, 0, 100, 30],
  z: 0,
  state: { focused: false, disabled: false, readonly: false, required: false, hasValue: true, valueLen: 17, occluded: false, volatile: false },
  affordances: ['type'],
  field: { inputType: 'email', maskedCss: false, valueRead: true, value: 'user@example.com' },
  container: 'root',
  textRuns: [],
};

function emailGraphResponder(sent: unknown, emit: (m: unknown) => void): void {
  const msg = sent as { type: string; actionId?: string };
  if (msg.type === 'extract') {
    emit({ type: 'graph', frame: 'f-0', nodes: [EMAIL_NODE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
  }
  if (msg.type === 'dispatch-action') {
    emit({ type: 'action-result', actionId: msg.actionId, ok: true });
    emit({ type: 'settled', actionId: msg.actionId });
  }
}

describe('Session — un-redact (T-6.12, FR-36)', () => {
  it('an unknown ref is refused: returns false and records nothing in the ledger', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done' }] });
    const { session } = buildSession(sendToGateway, emailGraphResponder);
    await session.start('report contact info');

    expect(session.unredact('⟪EMAIL#999⟫', 'not real')).toBe(false);
    expect(session.getLedger().unredactEvents()).toHaveLength(0);
  });

  it('un-redacting a real minted ref records an audited ledger event with the reason', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done' }] });
    const { session } = buildSession(sendToGateway, emailGraphResponder);
    await session.start('report contact info');

    const value = session.getLedger().latest()!.payload.nodes[0]!.value as { kind: string; ref?: string };
    expect(value.kind).toBe('placeholder');
    const ref = value.ref!;

    expect(session.unredact(ref, 'user asked to share their own email')).toBe(true);
    const events = session.getLedger().unredactEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ref, entity: 'EMAIL', reason: 'user asked to share their own email' });
  });

  it('a subsequent step sends the same value as raw text, not a placeholder, once un-redacted', async () => {
    let session!: Session;
    let stepCount = 0;
    // The un-redact call has to land BETWEEN step 1 (which mints the ref) and step 2 (which
    // should see it de-escalated) — `session.start()` runs the whole task to completion, so
    // there's no external hook mid-task except this mock itself, which the step loop already
    // calls once per step, strictly after that step's own ledger entry is recorded (guard runs
    // before the server round trip — see session.ts's step loop order).
    const sendToGateway = vi.fn().mockImplementation(async () => {
      stepCount += 1;
      if (stepCount === 1) {
        const firstValue = session.getLedger().latest()!.payload.nodes[0]!.value as { kind: string; ref?: string };
        session.unredact(firstValue.ref!, 'confirmed by user');
        return { step_id: 's-1', actions: [{ op: 'wait', ms: 1 }] };
      }
      return { step_id: 's-2', actions: [{ op: 'done' }] };
    });
    ({ session } = buildSession(sendToGateway, emailGraphResponder));
    await session.start('report contact info');

    // The FIRST step was already sent as a placeholder (un-redact can only affect FUTURE steps,
    // never rewrite a payload already sent — design.md's own fail-closed framing for irreversible
    // network sends). The SECOND step is where the de-escalation actually shows.
    const firstValue = session.getLedger().all()[0]!.payload.nodes[0]!.value as { kind: string };
    expect(firstValue.kind).toBe('placeholder');
    const secondValue = session.getLedger().all()[1]!.payload.nodes[0]!.value as { kind: string; text?: string };
    expect(secondValue.kind).toBe('text');
    expect(secondValue.text).toBe('user@example.com');
  });
});

// T-6.13 (FR-8, NG-8) — session-level CAPTCHA detection stops the agent before it ever builds a
// payload or calls the server, "no solving attempt is ever made" in the strongest possible sense.
const CAPTCHA_NODE: WireScreenNode = {
  id: 'n-3',
  frame: 'f-0',
  role: 'generic',
  name: '',
  box: [0, 0, 300, 78],
  z: 0,
  state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
  affordances: [],
  container: 'root',
  textRuns: [],
  domSignal: { entity: 'CAPTCHA', score: 1.0, valueRead: false },
};

function captchaGraphResponder(sent: unknown, emit: (m: unknown) => void): void {
  const msg = sent as { type: string };
  if (msg.type === 'extract') {
    emit({ type: 'graph', frame: 'f-0', nodes: [CAPTCHA_NODE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
  }
}

describe('Session — CAPTCHA detection (T-6.13, FR-8/NG-8)', () => {
  it('stops with CAPTCHA_DETECTED and never calls the server at all', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done' }] });
    const { session, events } = buildSession(sendToGateway, captchaGraphResponder);

    await session.start('sign in');

    expect(session.getState()).toBe('STOPPED');
    expect(events).toContainEqual({ type: 'stopped', reason: 'CAPTCHA_DETECTED' });
    expect(sendToGateway).not.toHaveBeenCalled();
  });

  it('a page with no CAPTCHA is completely unaffected', async () => {
    const sendToGateway = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done' }] });
    const { session, events } = buildSession(sendToGateway, graphResponder);

    await session.start('log in');

    expect(session.getState()).toBe('DONE');
    expect(events.some((e) => e.type === 'stopped' && e.reason === 'CAPTCHA_DETECTED')).toBe(false);
  });
});
