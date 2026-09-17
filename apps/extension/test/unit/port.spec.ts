// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootContentScript, type PortLike } from '../../src/content/port';
import { PORT_NAME } from '../../src/shared/messages';

// jsdom has no ResizeObserver; TopFrameSession's use of startObserving() needs one to exist even
// though this test never exercises resize behaviour itself.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);

afterEach(() => {
  document.body.innerHTML = '';
});

class FakePort implements PortLike {
  name: string;
  sender?: { id?: string };
  sent: unknown[] = [];
  private messageListeners: Array<(message: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  constructor(name = PORT_NAME, sender?: { id?: string }) {
    this.name = name;
    this.sender = sender;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  onMessage = { addListener: (cb: (message: unknown) => void) => this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.disconnectListeners.push(cb) };

  emit(message: unknown): void {
    for (const cb of this.messageListeners) cb(message);
  }
  disconnect(): void {
    for (const cb of this.disconnectListeners) cb();
  }
}

const EXTENSION_ID = 'aegis-extension-id';

function bootAndConnect(port: FakePort, isTopFrame = true): { onConnect: ReturnType<typeof vi.fn> } {
  const onConnect = vi.fn((listener: (p: PortLike) => void) => listener(port));
  bootContentScript({ isTopFrame, onConnect, extensionId: EXTENSION_ID });
  return { onConnect };
}

describe('bootContentScript (T-2.5, T-2.6)', () => {
  it('a non-top frame never calls onConnect — no port for child frames', () => {
    const onConnect = vi.fn();
    bootContentScript({ isTopFrame: false, onConnect, extensionId: EXTENSION_ID });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('the top frame connects, sends "ready" and an initial "graph" message', async () => {
    const port = new FakePort(PORT_NAME, { id: EXTENSION_ID });
    bootAndConnect(port);
    await Promise.resolve(); // let the async sendGraph() microtask land
    await Promise.resolve();
    expect(port.sent).toContainEqual({ type: 'ready', frame: 'f-0' });
    expect(port.sent.some((m) => (m as { type?: string }).type === 'graph')).toBe(true);
  });

  it('ignores a connection whose port name does not match', () => {
    const port = new FakePort('some-other-extension-port', { id: EXTENSION_ID });
    bootAndConnect(port);
    expect(port.sent).toEqual([]);
  });

  it('refuses a connection whose sender.id does not match this extension (T-2.5 AC)', () => {
    const port = new FakePort(PORT_NAME, { id: 'a-different-extension' });
    bootAndConnect(port);
    expect(port.sent).toEqual([]);
  });

  it('a malformed message is dropped, never thrown (T-2.5 AC)', () => {
    const port = new FakePort(PORT_NAME, { id: EXTENSION_ID });
    bootAndConnect(port);
    expect(() => port.emit({ garbage: true })).not.toThrow();
    expect(() => port.emit('not even an object')).not.toThrow();
    expect(() => port.emit(null)).not.toThrow();
  });

  it('responds to "ping" with "pong"', () => {
    const port = new FakePort(PORT_NAME, { id: EXTENSION_ID });
    bootAndConnect(port);
    port.emit({ type: 'ping' });
    expect(port.sent).toContainEqual({ type: 'pong' });
  });

  it('an action referencing an id nobody ever assigned resolves NODE_UNRESOLVED, not a crash', async () => {
    const port = new FakePort(PORT_NAME, { id: EXTENSION_ID });
    bootAndConnect(port);
    port.emit({ type: 'dispatch-action', actionId: 'a-1', action: { op: 'click', node: 'n-does-not-exist' } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.sent).toContainEqual({ type: 'action-result', actionId: 'a-1', ok: false, reason: 'NODE_UNRESOLVED' });
  });
});
