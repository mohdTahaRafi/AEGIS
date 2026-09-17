import { describe, expect, it, vi } from 'vitest';
import { ContentPortClient, connectToTab, type HostPort } from '../../src/host/port';
import { PORT_NAME } from '../../src/shared/messages';

class FakeHostPort implements HostPort {
  sent: unknown[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.disconnectListeners.push(cb) };
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  emit(message: unknown): void {
    for (const cb of this.messageListeners) cb(message);
  }
  disconnect(): void {
    for (const cb of this.disconnectListeners) cb();
  }
}

describe('connectToTab', () => {
  it('connects with the shared port name', () => {
    const tabs = { connect: vi.fn().mockReturnValue(new FakeHostPort()) };
    connectToTab(tabs, 42);
    expect(tabs.connect).toHaveBeenCalledWith(42, { name: PORT_NAME });
  });
});

describe('ContentPortClient', () => {
  it('routes each message type to its handler', () => {
    const port = new FakeHostPort();
    const handlers = {
      onReady: vi.fn(),
      onGraph: vi.fn(),
      onActionResult: vi.fn(),
      onSettled: vi.fn(),
      onNavigated: vi.fn(),
      onDisconnect: vi.fn(),
    };
    new ContentPortClient(port, handlers);

    port.emit({ type: 'ready', frame: 'f-0' });
    port.emit({ type: 'graph', frame: 'f-0', nodes: [], removed: [], privacyEpoch: 0, reason: 'initial' });
    port.emit({ type: 'action-result', actionId: 'a-1', ok: true });
    port.emit({ type: 'settled', actionId: 'a-1' });
    port.emit({ type: 'navigated' });
    port.disconnect();

    expect(handlers.onReady).toHaveBeenCalledWith('f-0');
    expect(handlers.onGraph).toHaveBeenCalledTimes(1);
    expect(handlers.onActionResult).toHaveBeenCalledTimes(1);
    expect(handlers.onSettled).toHaveBeenCalledTimes(1);
    expect(handlers.onNavigated).toHaveBeenCalledTimes(1);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed message without throwing and without calling any handler', () => {
    const port = new FakeHostPort();
    const onGraph = vi.fn();
    new ContentPortClient(port, { onGraph });
    expect(() => port.emit({ nonsense: true })).not.toThrow();
    expect(onGraph).not.toHaveBeenCalled();
  });

  it('requestExtract() and dispatchAction() send correctly typed messages', () => {
    const port = new FakeHostPort();
    const client = new ContentPortClient(port, {});
    client.requestExtract();
    client.dispatchAction('a-1', { op: 'click', node: 'n-1' });
    expect(port.sent).toEqual([{ type: 'extract' }, { type: 'dispatch-action', actionId: 'a-1', action: { op: 'click', node: 'n-1' } }]);
  });
});
