// @vitest-environment jsdom
// The task keeps going on its own and stops cleanly: Stop unwinds every wait (nothing queued behind
// a card can still act), a content script that stops answering is re-attached instead of hanging
// the task, an invalid model answer costs a step rather than the task, and a plan that changed
// nothing is reported to the model. Plus the agent's memory, plan normalisation, the Set-of-Marks
// tags and the model pick on "Test key".

import { describe, expect, it, vi } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { StepFailedError } from '../../src/host/egress/gateway-client';
import { ContentPortClient, type HostPort } from '../../src/host/port';
import { Session, type SessionEvent } from '../../src/host/session';
import type { WireScreenNode } from '../../src/shared/messages';
import { createAgentEngine } from '../../src/host/agent/engine';
import { brand } from '../../src/host/egress/brand';
import { extractExtras, normalizePlan } from '../../src/host/agent/plan';
import { buildUserMessage, markLabelsFor } from '../../src/host/agent/prompt';
import { verifyApiKey } from '../../src/host/egress/model-client';
import { fakeStep as step } from './agent-fixtures';

const DELETE: WireScreenNode = {
  id: 'n-1',
  frame: 'f-0',
  role: 'button',
  name: 'Delete account',
  box: [0, 0, 100, 30],
  z: 0,
  state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
  affordances: ['click'],
  container: 'root',
  textRuns: [],
};

class Port implements HostPort {
  sent: { type: string; actionId?: string }[] = [];
  answerExtract = true;
  private listeners: Array<(m: unknown) => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.listeners.push(cb) };
  onDisconnect = { addListener: () => {} };
  postMessage(message: unknown): void {
    const msg = message as { type: string; actionId?: string };
    this.sent.push(msg);
    queueMicrotask(() => {
      if (msg.type === 'extract' && this.answerExtract) this.emit({ type: 'graph', frame: 'f-0', nodes: [DELETE], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false });
      if (msg.type === 'dispatch-action') this.emit({ type: 'action-result', actionId: msg.actionId, ok: true });
    });
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
  const contentPort = new ContentPortClient(port, {
    onGraph: (m) => session.onGraph(m),
    onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason),
  });
  session = new Session({
    sleep: async () => {},
    contentPort,
    sendToGateway: send,
    guardOrigin: 'http://localhost:5600',
    pageCategory: 'unknown',
    pageTitle: 'Test',
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { session, events, port };
}

describe('Stop', () => {
  it('during a confirmation card: the task ends, start() returns, and the action is never dispatched', async () => {
    let cardOpen!: () => void;
    const opened = new Promise<void>((resolve) => (cardOpen = resolve));
    let allow!: (v: boolean) => void;
    const send = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] });
    const { session, events, port } = build(send, {
      confirm: () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
          cardOpen();
        }),
    });
    const running = session.start('delete it');
    await opened;
    session.cancel();
    await running;
    // A late "Allow" on a card that should be gone changes nothing.
    allow(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(session.getState()).toBe('CANCELLED');
    expect(port.sent.some((m) => m.type === 'dispatch-action')).toBe(false);
    expect(events.filter((e) => e.type === 'stopped')).toEqual([{ type: 'stopped', reason: 'CANCELLED' }]);
  });

  it('a link with a high-risk name still needs confirmation (links can act, not only navigate)', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const send = vi.fn().mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] }).mockResolvedValue({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session, port } = build(send, { confirm });
    const original = port.postMessage.bind(port);
    port.postMessage = (m: unknown) => {
      DELETE.role = 'link';
      original(m);
    };
    try {
      await session.start('t');
    } finally {
      DELETE.role = 'button';
    }
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(port.sent.some((m) => m.type === 'dispatch-action')).toBe(false);
  });

  it('while waiting for a page that never answers: start() returns at once', async () => {
    const { session, port } = build(vi.fn());
    port.answerExtract = false;
    const running = session.start('t');
    await new Promise((r) => setTimeout(r, 5));
    session.cancel();
    await running;
    expect(session.getState()).toBe('CANCELLED');
  });
});

describe('a page that stops answering', () => {
  it('is re-attached after the graph timeout instead of hanging the task', async () => {
    const fresh = new Port();
    // eslint-disable-next-line prefer-const
    let session!: Session;
    const reconnect = vi.fn(async () => ({
      contentPort: new ContentPortClient(fresh, { onGraph: (m) => session.onGraph(m), onActionResult: (m) => session.onActionResult(m.actionId, m.ok, m.reason) }),
      origin: 'http://localhost:5600',
      title: 'Test',
    }));
    const send = vi.fn().mockResolvedValue({ step_id: 's-1', actions: [{ op: 'done' }] });
    const built = build(send, { reconnect, graphTimeoutMs: 20 });
    session = built.session;
    built.port.answerExtract = false;
    await session.start('t');
    expect(reconnect).toHaveBeenCalled();
    expect(session.getState()).toBe('DONE');
  });
});

describe('invalid model answers', () => {
  it('cost a step, not the task: the next step says why the last reply was rejected', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new StepFailedError(422, 'PLAN_INVALID (schema: /actions/0 bad op)', false))
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session } = build(send);
    await session.start('t');
    expect(session.getState()).toBe('DONE');
    const second = send.mock.calls[1]![0] as { history: { outcome: string }[] };
    expect(second.history.at(-1)!.outcome).toMatch(/your reply was rejected/);
  });

  it('a refused key still ends the task at once', async () => {
    const send = vi.fn().mockRejectedValue(new StepFailedError(502, 'MODEL_UNAVAILABLE upstream_auth (401)', false));
    const { session, events } = build(send);
    await session.start('t');
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'stopped')).toMatchObject({ reason: 'SERVER_ERROR' });
  });
});

describe('no-progress detection', () => {
  it('tells the model when its actions left the page unchanged', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'scroll', direction: 'down' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'done' }] });
    const { session } = build(send);
    await session.start('t');
    const second = send.mock.calls[1]![0] as { history: { outcome: string }[] };
    expect(second.history.at(-1)!.outcome).toBe('acted; no visible change on the page');
  });
});

describe('agent memory and commentary', () => {
  it("feeds the model's notes back on the next step and reports its reasoning", async () => {
    const prompts: string[] = [];
    const commentary = vi.fn();
    const answers = [
      { thought: 'search first', notes: 'PLAN: search. FOUND: price ₹999', actions: [{ op: 'click', node: 'e1' }] },
      { actions: [{ op: 'done', summary: 'ok' }] },
    ];
    const engine = createAgentEngine(
      {
        complete: async (messages) => {
          const user = messages[1]!.content;
          prompts.push(typeof user === 'string' ? user : (user[0] as { text: string }).text);
          return answers.shift();
        },
      },
      'm',
      { profile: 'rich', grounding: 'image-px' },
      commentary,
    );
    const { session_id } = engine.openSession();
    const s1 = brand(step());
    const plan = await engine.sendStep(session_id, s1);
    expect(plan.note).toBe('search first');
    expect(commentary).toHaveBeenCalledWith(expect.objectContaining({ thought: 'search first', notes: 'PLAN: search. FOUND: price ₹999', tier: 'smart' }));
    await engine.sendStep(session_id, brand(step({ step_id: 's-2' })));
    expect(prompts[0]).toContain('NOTES: (none yet');
    expect(prompts[1]).toContain('NOTES: PLAN: search. FOUND: price ₹999');
    expect(prompts[1]).toContain('PAGE: "Test"');
  });
});

describe('plan normalisation', () => {
  it('maps common op names, cuts over-long fields, drops observation requests and caps the list', () => {
    const plan = normalizePlan(
      {
        thought: 'x',
        notes: 'y',
        actions: [
          { op: 'request_observation', level: 'L1' },
          { op: 'Fill', node: 'e1', text: 'hi' },
          { op: 'finish', summary: 's'.repeat(500) },
          { op: 'click', node: 'e1' },
          { op: 'click', node: 'e1' },
          { op: 'click', node: 'e1' },
          { op: 'click', node: 'e1' },
        ],
      },
      's-1',
    );
    expect(plan.actions).toHaveLength(5);
    expect(plan.actions[0]).toMatchObject({ op: 'type', text: 'hi' });
    expect((plan.actions[1] as { op: string; summary: string }).summary).toHaveLength(300);
    expect(plan.note).toBe('x');
    expect(extractExtras({ notes: ['a', 'b'] })).toEqual({ notes: 'a\nb' });
  });
});

describe('Set-of-Marks tags', () => {
  it('tags visible, uncovered interactive elements with the alias the prompt uses', () => {
    const s = step();
    const marks = markLabelsFor(s.nodes, s.viewport);
    expect(marks.map((m) => m.label)).toEqual(['e1', 'e2']);
    const hidden = { ...s.nodes[0]!, state: { ...s.nodes[0]!.state, occluded: true } };
    expect(markLabelsFor([hidden, s.nodes[1]!], s.viewport).map((m) => m.label)).toEqual(['e2']);
  });

  it('the rich prompt carries text below the screen, marked as such', () => {
    const s: SanitizedContext = step({ text: [{ id: 't-1', box: [0, 900, 100, 20], text: 'Further down: specs' }] });
    expect(buildUserMessage(s, { profile: 'rich' })).toContain('↓ "Further down: specs"');
    expect(buildUserMessage(s, { profile: 'compact' })).not.toContain('Further down');
  });
});

describe('"Test key" picks the best vision model the key can use', () => {
  it('skips a listed model that does not take images', async () => {
    const body = { data: [{ id: 'mistral-large-latest', capabilities: { vision: false } }, { id: 'mistral-medium-latest', capabilities: { vision: true } }] };
    const check = await verifyApiKey({ apiKey: 'k'.repeat(32), baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', provider: 'mistral' }, (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch);
    expect(check).toEqual({ ok: true, visionModelListed: true, model: 'mistral-medium-latest' });
  });
});

describe('one-time actions and memory across pages', () => {
  it('"Add to Cart" is pressed once per page: a repeat is skipped and the model is told it is done', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ step_id: 's-1', actions: [{ op: 'click', node: 'n-1' }] })
      .mockResolvedValueOnce({ step_id: 's-2', actions: [{ op: 'click', node: 'n-1' }] })
      .mockResolvedValue({ step_id: 's-3', actions: [{ op: 'done' }] });
    const original = DELETE.name;
    DELETE.name = 'Add to Cart';
    let port!: Port;
    try {
      const built = build(send);
      port = built.port;
      await built.session.start('add deep work to my cart');
    } finally {
      DELETE.name = original;
    }
    expect(port.sent.filter((m) => m.type === 'dispatch-action')).toHaveLength(1);
    const third = send.mock.calls[2]![0] as { history: { page?: string; actions: { op: string; name?: string }[]; outcome: string }[] };
    // Every step says what it pressed, by name, and on which page.
    expect(third.history[0]).toMatchObject({ page: 'Test', actions: [{ op: 'click', name: 'Add to Cart' }] });
    expect(third.history[1]!.outcome).toMatch(/NOT repeated: "Add to Cart" was already pressed on this page at s-1/);
  });

  it('the prompt names what each step pressed and the page it was on, and the user\'s region', () => {
    const s = step({
      history: [
        { step_id: 's-1', page: 'Deep Work - Amazon.in', actions: [{ op: 'click', node: 'n-gone', name: 'Add to Cart' }], outcome: 'acted' },
        { step_id: 's-2', page: 'Deep Work - Amazon.in', actions: [{ op: 'navigate' }], outcome: 'acted' },
      ],
    } as Partial<SanitizedContext>);
    const text = buildUserMessage(s, { profile: 'rich', region: 'IN' });
    expect(text).toContain('s-1 on "Deep Work - Amazon.in": click "Add to Cart" -> acted');
    // The page is named only where it changed.
    expect(text).toContain('\ns-2: navigate -> acted');
    expect(text).toContain('REGION: IN\n');
    expect(buildUserMessage(s, { profile: 'rich', region: 'india' })).not.toContain('REGION');
  });
});

describe('memory of the whole task', () => {
  it('a 40-step task still shows step 1, every page visited and the cart action done at step 2', () => {
    const history = Array.from({ length: 40 }, (_, i) => {
      const n = i + 1;
      if (n === 1) return { step_id: 's-1', page: 'Amazon.in : deep work', actions: [{ op: 'click', node: 'n-a', name: 'Deep Work Paperback' }], outcome: 'acted; page navigated' };
      if (n === 2) return { step_id: 's-2', page: 'Deep Work - Amazon.in', actions: [{ op: 'click', node: 'n-b', name: 'Add to Cart' }], outcome: 'acted' };
      return { step_id: `s-${n}`, page: 'Flipkart search', actions: [{ op: 'scroll' }], outcome: 'acted' };
    });
    const text = buildUserMessage(step({ history } as Partial<SanitizedContext>), { profile: 'rich' });
    expect(text).toContain('PAGES VISITED: "Amazon.in : deep work" (s-1); "Deep Work - Amazon.in" (s-2); "Flipkart search" (s-3..s-40)');
    expect(text).toContain('LASTING ACTIONS DONE: "Add to Cart" on "Deep Work - Amazon.in" (s-2)');
    expect(text).toContain('HISTORY: s-1 on "Amazon.in : deep work": click "Deep Work Paperback"');
    expect(text).toContain('\ns-40: scroll -> acted');
    // Older steps are one short line each, so a long task stays small.
    const historyPart = text.slice(text.indexOf('HISTORY:'), text.indexOf('\nVIEWPORT'));
    expect(historyPart.split('\n')).toHaveLength(40);
    expect(historyPart.length).toBeLessThan(3000);
  });
});

describe('checklist and smart-model routing', () => {
  function engineWith(answers: unknown[]) {
    const calls: { tier?: string; text: string }[] = [];
    const commentary = vi.fn();
    const engine = createAgentEngine(
      {
        complete: async (messages, _signal, tier) => {
          const user = messages[1]!.content;
          calls.push({ tier, text: typeof user === 'string' ? user : (user[0] as { text: string }).text });
          return answers.shift();
        },
      },
      'm',
      { profile: 'rich', grounding: 'image-px' },
      commentary,
    );
    return { engine, calls, commentary, session: engine.openSession().session_id };
  }

  it('refuses done while a checklist item is todo, until it is done or skipped with a reason', async () => {
    const { engine, calls, session } = engineWith([
      { checklist: ['Amazon.in price', 'Flipkart price', 'Bookswagon price'], actions: [{ op: 'click', node: 'e1' }] },
      // Step 2: claims to be finished with item 3 still todo; refused, and the correction skips it.
      { checklist: [{ id: 1, status: 'done', result: '₹219' }, { id: 2, status: 'done', result: '₹126' }], actions: [{ op: 'done', summary: 'x' }] },
      { checklist: [{ id: 3, status: 'skipped', result: 'blocked by a login wall' }], actions: [{ op: 'done', summary: 'Flipkart is cheapest' }] },
    ]);
    await engine.sendStep(session, brand(step()));
    const plan = await engine.sendStep(session, brand(step({ step_id: 's-2' })));
    expect(plan.actions).toEqual([{ op: 'done', summary: 'Flipkart is cheapest' }]);
    // The correction was told exactly which item was open, and made by the smart model.
    expect(calls[2]!.tier).toBe('smart');
    expect(calls[1]!.text).toContain('1. [todo] Amazon.in price');
  });

  it('a model that drops an item cannot make it disappear', async () => {
    const { engine, calls, session } = engineWith([
      { checklist: [{ id: 1, item: 'Amazon.in price' }, { id: 2, item: 'Flipkart price' }], actions: [{ op: 'click', node: 'e1' }] },
      { checklist: [{ id: 1, item: 'Amazon.in price', status: 'done' }], actions: [{ op: 'click', node: 'e1' }] },
      { actions: [{ op: 'click', node: 'e1' }] },
    ]);
    await engine.sendStep(session, brand(step()));
    await engine.sendStep(session, brand(step({ step_id: 's-2' })));
    await engine.sendStep(session, brand(step({ step_id: 's-3' })));
    expect(calls[2]!.text).toContain('1. [done] Amazon.in price\n2. [todo] Flipkart price');
  });

  it('plans with the smart model, does routine steps with the fast one, and re-plans after trouble', async () => {
    const { engine, calls, session } = engineWith([
      { checklist: ['find the price'], actions: [{ op: 'click', node: 'e1' }] },
      { actions: [{ op: 'click', node: 'e1' }] },
      { actions: [{ op: 'click', node: 'e1' }] },
    ]);
    await engine.sendStep(session, brand(step()));
    await engine.sendStep(session, brand(step({ step_id: 's-2', history: [{ step_id: 's-1', actions: [{ op: 'click' }], outcome: 'acted' }] })));
    await engine.sendStep(session, brand(step({ step_id: 's-3', history: [{ step_id: 's-2', actions: [{ op: 'click' }], outcome: 'acted; no visible change on the page' }] })));
    expect(calls.map((c) => c.tier)).toEqual(['smart', 'fast', 'smart']);
  });
});
