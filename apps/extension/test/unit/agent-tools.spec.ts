// @vitest-environment jsdom
// The agent's page tools: find (jump to text anywhere in the page, page text only, no probing for
// personal data), read_page (the whole page's text next step, sanitized like any page text), and
// the task's tabs (listed with sanitized titles; switch_tab re-attaches, close_tab closes).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { ContentPortClient, type HostPort } from '../../src/host/port';
import { Session, type SessionEvent } from '../../src/host/session';
import type { WireScreenNode } from '../../src/shared/messages';
import { dispatchFind } from '../../src/content/execute/dispatch';
import { classifyAction } from '../../src/host/actions/dispatch';
import { normalizePlan } from '../../src/host/agent/plan';
import { buildUserMessage } from '../../src/host/agent/prompt';
import { fakeStep } from './agent-fixtures';

const BUTTON: WireScreenNode = {
  id: 'n-1',
  frame: 'f-0',
  role: 'button',
  name: 'Next',
  box: [0, 0, 100, 30],
  z: 0,
  state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
  affordances: ['click'],
  container: 'root',
  textRuns: [],
};

/** A content script stand-in: answers `extract` with a graph (marked whole-page when asked) and
 * every action with success. */
class Port implements HostPort {
  sent: { type: string; actionId?: string; fullText?: boolean; action?: { op: string } }[] = [];
  private listeners: Array<(m: unknown) => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.listeners.push(cb) };
  onDisconnect = { addListener: () => {} };
  postMessage(message: unknown): void {
    const msg = message as Port['sent'][number];
    this.sent.push(msg);
    queueMicrotask(() => {
      if (msg.type === 'extract') {
        // An automatic graph arrives first: a whole-page request must not take it as its answer.
        if (msg.fullText) this.emit(this.graph(false));
        this.emit(this.graph(msg.fullText === true));
      }
      if (msg.type === 'dispatch-action') this.emit({ type: 'action-result', actionId: msg.actionId, ok: true });
    });
  }
  private graph(wholePage: boolean) {
    return {
      type: 'graph',
      frame: 'f-0',
      nodes: [BUTTON],
      removed: [],
      textRuns: wholePage ? [{ id: 't-far', box: [0, 5000, 300, 20], text: 'Chapter 9: far below' }] : [],
      privacyEpoch: 0,
      reason: 'requested',
      hostileDynamic: false,
      ...(wholePage ? { textScope: 'page' } : {}),
    };
  }
  private emit(m: unknown): void {
    for (const cb of this.listeners) cb(m);
  }
}

function build(send: (p: unknown, s: AbortSignal) => Promise<unknown>, extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const port = new Port();
  const events: SessionEvent[] = [];
  // eslint-disable-next-line prefer-const
  let session!: Session;
  const contentPort = new ContentPortClient(port, { onGraph: (m) => session.onGraph(m), onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason) });
  session = new Session({ sleep: async () => {}, contentPort, sendToGateway: send, guardOrigin: 'http://localhost:5600', pageCategory: 'unknown', pageTitle: 'Test', onEvent: (e) => events.push(e), ...extra });
  return { session, events, port, contentPort };
}

const browserBase = {
  navigate: async () => {},
  openTab: async () => {},
  goBack: async () => {},
  goForward: async () => {},
  reload: async () => {},
  waitForPageReady: async () => {},
};

describe('find (content side)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function layOut(tops: Record<string, number>): HTMLElement[] {
    const scrolled: HTMLElement[] = [];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = tops[(this as HTMLElement).id] ?? -1;
      return { top, bottom: top + 20, left: 0, right: 200, width: top < 0 ? 0 : 200, height: top < 0 ? 0 : 20, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this as HTMLElement);
    };
    return scrolled;
  }

  it('scrolls the next occurrence below the top of the view into view, ignoring case and spacing', () => {
    document.body.innerHTML = '<p id="a">Price: ₹219</p><p id="b">Customer   reviews</p><p id="c">customer reviews (2)</p>';
    const scrolled = layOut({ a: 10, b: 30, c: 2000 });
    expect(dispatchFind('CUSTOMER reviews')).toEqual({ ok: true });
    // "b" sits in the top tenth of the 768 px view (jsdom's default height): the next one is "c".
    expect(scrolled.map((el) => el.id)).toEqual(['c']);
  });

  it('never matches a form field value, hidden text or AEGIS\'s own UI', () => {
    document.body.innerHTML = '<input id="i" value="secret token"><p id="h" aria-hidden="true">secret token</p><div data-aegis-ignore><p id="u">secret token</p></div>';
    layOut({ i: 400, h: 400, u: 400 });
    expect(dispatchFind('secret token')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('read_page', () => {
  it('asks the page for its whole text, waits for that answer, and the prompt shows text far below', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'read_page' }] })
      .mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, port } = build(send);
    await session.start('summarise the article');
    expect(port.sent.filter((m) => m.type === 'extract').map((m) => m.fullText === true)).toEqual([false, true]);
    const second = send.mock.calls[1]![0] as SanitizedContext;
    expect(second.text_scope).toBe('page');
    expect(second.text.map((t) => t.text)).toContain('Chapter 9: far below');
    expect(buildUserMessage(second, { profile: 'rich' })).toContain('"Chapter 9: far below"');
  });
});

describe('tabs', () => {
  it('lists the task\'s tabs with sanitized titles, and switch_tab re-attaches to the chosen one', async () => {
    const fresh = new Port();
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const switchTab = vi.fn(async () => ({
      contentPort: new ContentPortClient(fresh, { onGraph: (m) => session.onGraph(m), onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason) }),
      origin: 'https://shop.example',
      title: 'Cart',
    }));
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'switch_tab', tab: 1 }, { op: 'click', node: 'n-1' }] })
      .mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const listTabs = vi.fn(async () => [
      { title: 'Mail to alice@example.com', current: false },
      { title: 'Deep Work - Flipkart', current: true },
    ]);
    const built = build(send, { browser: { ...browserBase, listTabs, switchTab } });
    session = built.session;
    await session.start('t');
    expect(switchTab).toHaveBeenCalledWith(1);
    // The click after switch_tab targeted the old page: it was skipped, not sent to the new tab.
    expect(built.port.sent.some((m) => m.type === 'dispatch-action')).toBe(false);
    const first = send.mock.calls[0]![0] as SanitizedContext;
    expect(first.tabs).toHaveLength(2);
    expect(first.tabs![0]!.title).not.toContain('alice@example.com');
    expect(first.tabs![1]).toEqual({ index: 2, title: 'Deep Work - Flipkart', current: true });
    expect(buildUserMessage(first, { profile: 'rich' })).toContain('TABS: 1 "');
  });

  it('close_tab of a tab that is not there is reported to the model, not a crash', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'close_tab', tab: 3 }] })
      .mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session } = build(send, { browser: { ...browserBase, closeTab: async () => false } });
    await session.start('t');
    const second = send.mock.calls[1]![0] as SanitizedContext;
    expect(second.history.some((h) => h.outcome === 'FAILED_NO_SUCH_TAB')).toBe(true);
  });
});

describe('find (host side)', () => {
  it('refuses a search shaped like personal data: it could probe for a value the model never saw', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'find', text: 'alice@example.com' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'find', text: '98765 43210' }] })
      .mockResolvedValue({ step_id: 's-3', actions: [{ op: 'done' }] });
    const { session, port } = build(send);
    await session.start('t');
    expect(port.sent.some((m) => m.type === 'dispatch-action')).toBe(false);
    const third = send.mock.calls[2]![0] as SanitizedContext;
    expect(third.history.filter((h) => h.outcome === 'FAILED_FIND_REFUSED')).toHaveLength(2);
  });

  it('an ordinary search is sent to the page', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'find', text: 'Customer reviews' }] })
      .mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, port } = build(send);
    await session.start('t');
    expect(port.sent.find((m) => m.type === 'dispatch-action')?.action).toEqual({ op: 'find', text: 'Customer reviews' });
  });
});

describe('plan normalisation for the new tools', () => {
  it('maps the names models use and coerces a tab number written as text', () => {
    const plan = normalizePlan({ actions: [{ op: 'search_page', query: 'Reviews' }, { op: 'switch', index: '2' }, { op: 'read' }] }, 's-1');
    expect(plan.actions).toEqual([{ op: 'find', text: 'Reviews' }, { op: 'switch_tab', tab: 2 }, { op: 'read_page' }]);
    expect(classifyAction({ op: 'close_tab', tab: 2 })).toEqual({ kind: 'browser', op: 'close_tab', tab: 2 });
  });

  it('a step\'s TABS line is left out when the task has only one tab', () => {
    expect(buildUserMessage(fakeStep(), { profile: 'rich' })).not.toContain('TABS:');
  });
});
