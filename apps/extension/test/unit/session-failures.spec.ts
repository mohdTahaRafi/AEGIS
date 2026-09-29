// @vitest-environment jsdom
// Every way a task can end emits an event (the panel never sits on "Running"), a failed action is
// re-observed within the budget, and a retryable gateway error is retried once.

import { describe, expect, it, vi } from 'vitest';
import { StepFailedError } from '../../src/host/egress/gateway-client';
import { ContentPortClient, type HostPort } from '../../src/host/port';
import { parseWebUrl, Session, type BrowserControl, type SessionEvent } from '../../src/host/session';
import type { WireScreenNode } from '../../src/shared/messages';

const BUTTON: WireScreenNode = {
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

class ScriptedPort implements HostPort {
  sent: unknown[] = [];
  private listeners: Array<(m: unknown) => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.listeners.push(cb) };
  onDisconnect = { addListener: () => {} };
  constructor(
    private readonly actionOk: boolean,
    private readonly answerActions = true,
    private readonly nodes: WireScreenNode[] = [BUTTON],
  ) {}
  postMessage(message: unknown): void {
    this.sent.push(message);
    queueMicrotask(() => {
      const msg = message as { type: string; actionId?: string };
      if (msg.type === 'extract') this.emit({ type: 'graph', frame: 'f-0', nodes: this.nodes, removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
      if (msg.type === 'dispatch-action' && this.answerActions) this.emit({ type: 'action-result', actionId: msg.actionId, ok: this.actionOk, reason: this.actionOk ? undefined : 'HIT_TEST_FAILED' });
    });
  }
  private emit(m: unknown): void {
    for (const cb of this.listeners) cb(m);
  }
}

function build(sendToGateway: (p: unknown, s: AbortSignal) => Promise<unknown>, opts: { actionOk?: boolean; confirm?: () => Promise<boolean>; answerActions?: boolean; nodes?: WireScreenNode[] } = {}) {
  const port = new ScriptedPort(opts.actionOk ?? true, opts.answerActions ?? true, opts.nodes);
  const events: SessionEvent[] = [];
  // eslint-disable-next-line prefer-const
  let session!: Session;
  const contentPort = new ContentPortClient(port, {
    onGraph: (m) => session.onGraph(m),
    onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
  });
  session = new Session({
    sleep: async () => {},
    contentPort,
    sendToGateway,
    guardOrigin: 'http://localhost:5600',
    pageCategory: 'unknown',
    pageTitle: 'Test',
    onEvent: (e) => events.push(e),
    confirm: opts.confirm,
  });
  return { session, events, port };
}

describe('Session — terminal paths always emit', () => {
  it("op 'stop' ends the task as MODEL_STOPPED with the model's reason, not as a user cancel", async () => {
    const { session, events } = build(vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'stop', reason: 'captcha' }] }));
    await session.start('t');
    expect(session.getState()).toBe('STOPPED');
    expect(events.find((e) => e.type === 'stopped')).toEqual({ type: 'stopped', reason: 'MODEL_STOPPED', detail: 'captcha' });
  });

  it("a stop's detail (the model's own reason) reaches the panel", async () => {
    const { session, events } = build(vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'stop', reason: 'cannot_proceed', detail: 'no username given in the task' }] }));
    await session.start('t');
    expect(events.find((e) => e.type === 'stopped')).toEqual({ type: 'stopped', reason: 'MODEL_STOPPED', detail: 'cannot_proceed (no username given in the task)' });
  });

  it('reports each operation as validated then executed / failed / not run, described with the sent names', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }, { op: 'done', summary: 'x' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done', summary: 'ok' }] });
    const { session, events } = build(send, { actionOk: false });
    await session.start('t');
    expect(events.find((e) => e.type === 'plan')).toEqual({ type: 'plan', stepId: 's-1', actions: ['click → "Sign in"', 'done: x'] });
    const statuses = events.filter((e) => e.type === 'action_status');
    expect(statuses).toEqual([
      { type: 'action_status', stepId: 's-1', index: 0, status: 'failed', reason: 'FAILED_HIT_TEST_FAILED' },
      { type: 'action_status', stepId: 's-1', index: 1, status: 'skipped', reason: 'an earlier action failed' },
      { type: 'action_status', stepId: 's-2', index: 0, status: 'executed', reason: undefined },
    ]);
  });

  it("a plan the extension's validator refuses is reported as rejected, not executed", async () => {
    const send = vi.fn().mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'teleport' }] }).mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, events } = build(send);
    await session.start('t');
    expect(events.find((e) => e.type === 'plan_rejected')).toEqual({ type: 'plan_rejected', stepId: 's-1', reason: 'SCHEMA_INVALID' });
  });

  it('a failed action re-observes and asks again (history carries the failure), then succeeds', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done', summary: 'ok' }] });
    const { session, events } = build(send, { actionOk: false });
    await session.start('t');
    expect(session.getState()).toBe('DONE');
    const second = send.mock.calls[1]![0] as { history: { step_id: string; outcome: string }[] };
    expect(second.history).toEqual([{ step_id: 's-1', actions: [{ op: 'click' }], outcome: 'FAILED_HIT_TEST_FAILED' }]);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('repeated failures stop with RECOVERY_EXHAUSTED instead of hanging', async () => {
    const send = vi.fn().mockImplementation(async (payload: { step_id: string }) => ({ step_id: payload.step_id, actions: [{ op: 'click', node: 'n-1' }] }));
    const { session, events } = build(send, { actionOk: false });
    await session.start('t');
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'RECOVERY_EXHAUSTED' });
  });

  it('declining a risky action stops as USER_DECLINED', async () => {
    const send = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'click_point', x: 10, y: 10, label: 'x' }] });
    const { session, events } = build(send, { confirm: async () => false });
    await session.start('t');
    expect(session.getState()).toBe('STOPPED');
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'USER_DECLINED' });
  });
});

describe('Session — gateway errors', () => {
  it('retries a retryable error once (same step), then proceeds', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new StepFailedError(503, 'MODEL_UNAVAILABLE upstream_5xx', true, 0.01))
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'done' }] });
    const { session } = build(send);
    await session.start('t');
    expect(session.getState()).toBe('DONE');
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as { step_id: string }).step_id).toBe((send.mock.calls[1]![0] as { step_id: string }).step_id);
  });

  it("reseals once on the gateway's own tripwire, then does not retry a non-retryable error, and reports its code", async () => {
    const send = vi.fn().mockRejectedValue(new StepFailedError(422, 'UNSANITIZED_CONTEXT', false));
    const { session, events } = build(send);
    await session.start('t');
    expect(send).toHaveBeenCalledTimes(2);
    expect(session.getState()).toBe('STOPPED');
    expect(events.find((e) => e.type === 'stopped')).toEqual({ type: 'stopped', reason: 'SERVER_ERROR', detail: 'UNSANITIZED_CONTEXT' });
  });

  it('does not wait out a long Retry-After', async () => {
    const send = vi.fn().mockRejectedValue(new StepFailedError(503, 'MODEL_UNAVAILABLE upstream_429 retry in 195 s', true, 195));
    const { session, events } = build(send);
    await session.start('t');
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'SERVER_ERROR', detail: 'MODEL_UNAVAILABLE upstream_429 retry in 195 s' });
  });
});

/** A page whose content script disconnects right after executing an action, like a link click
 * that loads a new document. */
class NavigatingPort implements HostPort {
  private listeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.listeners.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.disconnectListeners.push(cb) };
  constructor(private readonly node: WireScreenNode, private readonly navigates: boolean) {}
  postMessage(message: unknown): void {
    queueMicrotask(() => {
      const msg = message as { type: string; actionId?: string };
      if (msg.type === 'extract') this.emit({ type: 'graph', frame: 'f-0', nodes: [this.node], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
      if (msg.type === 'dispatch-action') {
        this.emit({ type: 'action-result', actionId: msg.actionId, ok: true });
        if (this.navigates) {
          this.emit({ type: 'settled', actionId: msg.actionId });
          for (const cb of this.disconnectListeners) cb();
        }
      }
    });
  }
  private emit(m: unknown): void {
    for (const cb of this.listeners) cb(m);
  }
}

describe('Session — an action that loads a new page', () => {
  const LINK: WireScreenNode = { ...BUTTON, id: 'n-link', role: 'link', name: 'Next page' };
  const NEXT: WireScreenNode = { ...BUTTON, id: 'n-next', name: 'Continue' };

  function navSession(send: (p: unknown, s: AbortSignal) => Promise<unknown>, reconnectsTo: 'page' | 'nothing') {
    const events: SessionEvent[] = [];
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const wire = (port: HostPort) =>
      new ContentPortClient(port, {
        onGraph: (m) => session.onGraph(m),
        onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
        onSettled: (m) => session.onSettled(m.actionId),
        onDisconnect: () => session.onContentDisconnected(),
      });
    const reconnect = vi.fn(async () => (reconnectsTo === 'page' ? { contentPort: wire(new NavigatingPort(NEXT, false)), origin: 'https://next.example', title: 'Next' } : null));
    session = new Session({
    sleep: async () => {},
      contentPort: wire(new NavigatingPort(LINK, true)),
      sendToGateway: send,
      guardOrigin: 'https://start.example',
      pageCategory: 'unknown',
      pageTitle: 'Start',
      onEvent: (e) => events.push(e),
      reconnect,
    });
    return { session, events, reconnect };
  }

  it('re-attaches to the new page and continues the task there', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-link' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done', summary: 'ok' }] });
    const { session, reconnect } = navSession(send, 'page');
    await session.start('open the next page');
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(session.getState()).toBe('DONE');
    const second = send.mock.calls[1]![0] as { nodes: { id: string }[]; page: { title: string }; history: { outcome: string }[] };
    expect(second.nodes.map((n) => n.id)).toEqual(['n-next']);
    expect(second.page.title).toBe('Next');
    expect(second.history[0]!.outcome).toBe('acted; page navigated');
  });

  it('stops clearly when the new page cannot be reached', async () => {
    const send = vi.fn().mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-link' }] });
    const { session, events } = navSession(send, 'nothing');
    await session.start('open the next page');
    expect(events.find((e) => e.type === 'stopped')).toEqual({ type: 'stopped', reason: 'PAGE_DISCONNECTED', detail: 'NEW_PAGE_UNREACHABLE' });
  });
});

describe('Session — the page replaces its own document (a redirect, a slow page finishing its load)', () => {
  /** Drops its document the moment it is first asked for the page, before AEGIS has acted. */
  class ReplacedPort implements HostPort {
    private disconnectListeners: Array<() => void> = [];
    onMessage = { addListener: () => {} };
    onDisconnect = { addListener: (cb: () => void) => this.disconnectListeners.push(cb) };
    postMessage(): void {
      queueMicrotask(() => {
        for (const cb of this.disconnectListeners) cb();
      });
    }
  }

  it('re-attaches to the tab\'s new document instead of stopping (Amazon search, 2026-09-29)', async () => {
    const events: SessionEvent[] = [];
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const wire = (port: HostPort) =>
      new ContentPortClient(port, {
        onGraph: (m) => session.onGraph(m),
        onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
        onDisconnect: () => session.onContentDisconnected(),
      });
    const reconnect = vi.fn(async () => ({ contentPort: wire(new NavigatingPort(BUTTON, false)), origin: 'https://www.shop.example', title: 'Results' }));
    const send = vi.fn().mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'done', summary: 'ok' }] });
    session = new Session({
    sleep: async () => {},
      contentPort: wire(new ReplacedPort()),
      sendToGateway: send,
      guardOrigin: 'https://shop.example',
      pageCategory: 'unknown',
      pageTitle: 'Loading',
      onEvent: (e) => events.push(e),
      reconnect,
    });
    await session.start('find a charger');
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(session.getState()).toBe('DONE');
    expect((send.mock.calls[0]![0] as { page: { title: string } }).page.title).toBe('Results');
  });
});

describe('Session — an action that opens a new tab', () => {
  const LINK: WireScreenNode = { ...BUTTON, id: 'n-link', role: 'link', name: 'Product page' };
  const PRODUCT: WireScreenNode = { ...BUTTON, id: 'n-buy', name: 'Buy now' };

  function tabSession(send: (p: unknown, s: AbortSignal) => Promise<unknown>, opensTab: boolean) {
    const events: SessionEvent[] = [];
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const wire = (port: HostPort) =>
      new ContentPortClient(port, {
        onGraph: (m) => session.onGraph(m),
        onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
        onSettled: (m) => session.onSettled(m.actionId),
        onDisconnect: () => session.onContentDisconnected(),
      });
    const followOpenedTab = vi.fn(async () => (opensTab ? { contentPort: wire(new NavigatingPort(PRODUCT, false)), origin: 'https://shop.example', title: 'Product' } : null));
    session = new Session({
    sleep: async () => {},
      contentPort: wire(new NavigatingPort(LINK, false)),
      sendToGateway: send,
      guardOrigin: 'https://search.example',
      pageCategory: 'unknown',
      pageTitle: 'Results',
      onEvent: (e) => events.push(e),
      followOpenedTab,
    });
    return { session, followOpenedTab };
  }

  const clickThenDone = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-link' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done', summary: 'ok' }] });

  it('continues the task in the tab the click opened (the old tab is left behind it)', async () => {
    const send = clickThenDone();
    const { session, followOpenedTab } = tabSession(send, true);
    await session.start('open the product');
    expect(followOpenedTab).toHaveBeenCalledTimes(1);
    expect(session.getState()).toBe('DONE');
    const second = send.mock.calls[1]![0] as { nodes: { id: string }[]; page: { title: string }; history: { outcome: string }[] };
    expect(second.nodes.map((n) => n.id)).toEqual(['n-buy']);
    expect(second.page.title).toBe('Product');
    expect(second.history[0]!.outcome).toBe('acted; opened a new tab');
  });

  it('stays on its tab when the action opened none', async () => {
    const send = clickThenDone();
    const { session, followOpenedTab } = tabSession(send, false);
    await session.start('open the product');
    expect(followOpenedTab).toHaveBeenCalledTimes(1);
    const second = send.mock.calls[1]![0] as { nodes: { id: string }[] };
    expect(second.nodes.map((n) => n.id)).toEqual(['n-link']);
  });
});

describe('Session — the model\'s browser actions (navigate, open_tab, back/forward/reload, wait)', () => {
  function browserSession(send: (p: unknown, s: AbortSignal) => Promise<unknown>, confirm = vi.fn(async () => true)) {
    const events: SessionEvent[] = [];
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const wire = (port: HostPort) =>
      new ContentPortClient(port, {
        onGraph: (m) => session.onGraph(m),
        onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
        onSettled: (m) => session.onSettled(m.actionId),
        onDisconnect: () => session.onContentDisconnected(),
      });
    const browser: BrowserControl = {
      navigate: vi.fn(async () => {}),
      openTab: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      waitForPageReady: vi.fn(async () => {}),
    };
    session = new Session({
    sleep: async () => {},
      contentPort: wire(new NavigatingPort(BUTTON, false)),
      sendToGateway: send,
      guardOrigin: 'https://chatgpt.com',
      pageCategory: 'unknown',
      pageTitle: 'ChatGPT',
      onEvent: (e) => events.push(e),
      confirm,
      browser,
    });
    return { session, events, browser, confirm };
  }
  const twoSteps = (first: unknown[]) =>
    vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: first })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done', summary: 'ok' }] });

  it('opens another site in a new tab after you confirm, and ends the step there', async () => {
    const send = twoSteps([{ op: 'open_tab', url: 'https://www.amazon.in/s?k=65w+charger' }, { op: 'click', node: 'n-1' }]);
    const { session, events, browser, confirm } = browserSession(send);
    await session.start('buy a 65W charger');
    expect(confirm).toHaveBeenCalledWith('medium', 'open in a new tab https://www.amazon.in');
    expect(browser.openTab).toHaveBeenCalledWith('https://www.amazon.in/s?k=65w+charger');
    expect(events).toContainEqual({ type: 'action_status', stepId: 's-1', index: 1, status: 'skipped', reason: 'the page changed' });
    expect(browser.waitForPageReady).toHaveBeenCalled();
    expect(session.getState()).toBe('DONE');
  });

  it('Deny on the new-site card stops the task and opens nothing', async () => {
    const send = twoSteps([{ op: 'navigate', url: 'https://www.amazon.in/' }]);
    const { session, events, browser } = browserSession(send, vi.fn(async () => false));
    await session.start('buy a charger');
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'USER_DECLINED' });
  });

  it('same-site navigation and back/forward/reload need no confirmation', async () => {
    const send = twoSteps([{ op: 'navigate', url: 'https://chatgpt.com/c/new' }]);
    const { session, browser, confirm } = browserSession(send);
    await session.start('open a new chat');
    expect(confirm).not.toHaveBeenCalled();
    expect(browser.navigate).toHaveBeenCalledWith('https://chatgpt.com/c/new');

    const back = browserSession(twoSteps([{ op: 'go_back' }]));
    await back.session.start('go back');
    expect(back.browser.goBack).toHaveBeenCalledTimes(1);
    expect(back.confirm).not.toHaveBeenCalled();
  });

  it('wait really waits', async () => {
    const send = twoSteps([{ op: 'wait', ms: 300 }]);
    const { session } = browserSession(send);
    const t0 = Date.now();
    await session.start('wait');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });
});

describe('parseWebUrl — what the model may open', () => {
  it.each(['https://www.amazon.in/s?k=charger', 'http://127.0.0.1:8080/x'])('accepts %s', (url) => {
    expect(parseWebUrl(url)?.href).toBeTruthy();
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://user:pw@example.com/', 'https://x.example/\u27eaEMAIL#1\u27eb', 'not a url'])('refuses %s', (url) => {
    expect(parseWebUrl(url)).toBeNull();
  });
});

describe('Session — the model asks the user something', () => {
  it('shows the question and ends the task as NEEDS_USER instead of looping', async () => {
    const send = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'ask_user', question: 'Which account?' }] });
    const { session, events } = build(send);
    await session.start('t');
    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: 'report', title: 'AEGIS needs your input', content: 'Which account?' });
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'NEEDS_USER' });
  });
});


describe('Session — an action the page never answers', () => {
  it('fails the action after the timeout instead of hanging the task (Gmail, 2026-09-29)', async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] })
        .mockResolvedValue({ step_id: 's-2', actions: [{ op: 'stop', reason: 'cannot_proceed' }] });
      const { session, events } = build(send, { answerActions: false });
      const run = session.start('t');
      await vi.advanceTimersByTimeAsync(16_000);
      await run;
      expect(events).toContainEqual({ type: 'action_status', stepId: 's-1', index: 0, status: 'failed', reason: 'FAILED_NO_RESULT' });
      expect(session.getState()).toBe('STOPPED');
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('Session — a click on an irreversible control is confirmed by the user', () => {
  const SEND: WireScreenNode = { ...BUTTON, id: 'n-send', name: 'Send (Ctrl-Enter)' };

  it('asks before clicking "Send (Ctrl-Enter)"; Deny stops the task and nothing is clicked (Gmail, 2026-09-29)', async () => {
    const send = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'click', node: 'n-send' }] });
    const confirm = vi.fn().mockResolvedValue(false);
    const { session, events, port } = build(send, { confirm, nodes: [SEND] });
    await session.start('t');
    expect(confirm).toHaveBeenCalledWith('medium', 'click "Send (Ctrl-Enter)"');
    expect(events).toContainEqual({ type: 'confirmation_required', risk: 'medium', description: 'click "Send (Ctrl-Enter)"' });
    expect(port.sent.some((m) => (m as { type: string }).type === 'dispatch-action')).toBe(false);
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'USER_DECLINED' });
  });

  it('an ordinary click ("Sign in") is not held for confirmation', async () => {
    const send = vi.fn().mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }, { op: 'done', summary: 'ok' }] });
    const confirm = vi.fn().mockResolvedValue(true);
    const { session } = build(send, { confirm });
    await session.start('t');
    expect(confirm).not.toHaveBeenCalled();
    expect(session.getState()).toBe('DONE');
  });
});
