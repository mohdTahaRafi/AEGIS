// @vitest-environment jsdom
// design.md §5.1 / phase_2_spine.md §3.1 (T-2.6): "does nothing observable until the host
// connects a port". This counts actual observer registrations rather than trusting the claim —
// a counting fixture around MutationObserver/ResizeObserver, exactly as the task's AC asks for.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootContentScript, type PortLike } from '../../src/content/port';
import { PORT_NAME } from '../../src/shared/messages';

let mutationObserverCount = 0;
let resizeObserverCount = 0;

class CountingMutationObserver {
  constructor(_cb: MutationCallback) {
    mutationObserverCount += 1;
  }
  observe(): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] {
    return [];
  }
}

class CountingResizeObserver {
  constructor(_cb: ResizeObserverCallback) {
    resizeObserverCount += 1;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.stubGlobal('MutationObserver', CountingMutationObserver);
vi.stubGlobal('ResizeObserver', CountingResizeObserver);

afterEach(() => {
  document.body.innerHTML = '';
  mutationObserverCount = 0;
  resizeObserverCount = 0;
});

class FakePort implements PortLike {
  name = PORT_NAME;
  sender = { id: 'aegis-extension-id' };
  sent: unknown[] = [];
  onMessage = { addListener: () => {} };
  onDisconnect = { addListener: () => {} };
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
}

describe('content-script idle cost (T-2.6 AC)', () => {
  it('registers zero observers before any port connects', () => {
    const onConnect = vi.fn(); // never actually calls the listener — simulates "host hasn't connected yet"
    bootContentScript({ isTopFrame: true, onConnect, extensionId: 'aegis-extension-id' });
    expect(mutationObserverCount).toBe(0);
    expect(resizeObserverCount).toBe(0);
  });

  it('registers exactly one MutationObserver and one ResizeObserver once the host connects', () => {
    const onConnect = vi.fn((listener: (p: PortLike) => void) => listener(new FakePort()));
    bootContentScript({ isTopFrame: true, onConnect, extensionId: 'aegis-extension-id' });
    expect(mutationObserverCount).toBe(1);
    expect(resizeObserverCount).toBe(1);
  });

  it('a non-top frame registers zero observers regardless of connection state', () => {
    const onConnect = vi.fn();
    bootContentScript({ isTopFrame: false, onConnect, extensionId: 'aegis-extension-id' });
    expect(mutationObserverCount).toBe(0);
    expect(resizeObserverCount).toBe(0);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
