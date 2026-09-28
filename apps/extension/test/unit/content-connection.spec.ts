import { describe, expect, it, vi } from 'vitest';
import { connectToLiveContent } from '../../src/host/content-connection';
import type { HostPort } from '../../src/host/port';

/** A fake `runtime.Port` whose far end is scripted: `live` answers `ready` on connect (a content
 * script is listening), `gone` disconnects straight away — Chrome's behaviour for "Could not
 * establish connection. Receiving end does not exist." — and `silent` never answers at all. */
class FakePort implements HostPort {
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  disconnected = false;
  onMessage = { addListener: (cb: (m: unknown) => void) => this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.disconnectListeners.push(cb) };
  postMessage = vi.fn();

  constructor(far: 'live' | 'gone' | 'silent', afterReady: unknown[] = []) {
    queueMicrotask(() => {
      if (far === 'live') for (const m of [{ type: 'ready', frame: 'f-0' }, ...afterReady]) this.emit(m);
      if (far === 'gone') for (const cb of this.disconnectListeners) cb();
    });
  }

  emit(message: unknown): void {
    for (const cb of this.messageListeners) cb(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

describe('connectToLiveContent', () => {
  it('uses the existing content script when one answers ready — no injection', async () => {
    const inject = vi.fn();
    const result = await connectToLiveContent(1, { connect: () => new FakePort('live'), inject });
    expect(result.ok && result.injected).toBe(false);
    expect(inject).not.toHaveBeenCalled();
  });

  it('"Receiving end does not exist" (tab open since before an extension reload): injects, reconnects, and reads lastError', async () => {
    const far: Array<'gone' | 'live'> = ['gone', 'live'];
    const inject = vi.fn().mockResolvedValue(undefined);
    const lastErrorMessage = vi.fn(() => 'Could not establish connection. Receiving end does not exist.');
    const result = await connectToLiveContent(9, { connect: () => new FakePort(far.shift()!), inject, lastErrorMessage });
    expect(result.ok && result.injected).toBe(true);
    expect(inject).toHaveBeenCalledWith(9);
    expect(lastErrorMessage).toHaveBeenCalled();
  });

  it('a script that never answers is abandoned (port closed, so a late ready cannot start a second session) and replaced', async () => {
    const made: FakePort[] = [];
    const far: Array<'silent' | 'live'> = ['silent', 'live'];
    const connect = (): FakePort => {
      const port = new FakePort(far.shift()!);
      made.push(port);
      return port;
    };
    const result = await connectToLiveContent(1, { connect, inject: vi.fn().mockResolvedValue(undefined), readyTimeoutMs: 5 });
    expect(result.ok).toBe(true);
    expect(made[0]!.disconnected).toBe(true);
  });

  it('reports inject-failed (no activeTab/host grant) instead of returning a dead port, URL stripped from the detail', async () => {
    const inject = vi.fn().mockRejectedValue(new Error('Cannot access contents of url "http://127.0.0.1:8080/x". Extension manifest must request permission to access this host.'));
    const result = await connectToLiveContent(1, { connect: () => new FakePort('gone'), inject });
    expect(result).toEqual({ ok: false, reason: 'inject-failed', detail: 'Cannot access contents of url "…". Extension manifest must request permission to access this host.' });
  });

  it('reports no-ready when even the injected script does not answer', async () => {
    const result = await connectToLiveContent(1, { connect: () => new FakePort('gone'), inject: vi.fn().mockResolvedValue(undefined) });
    expect(result).toEqual({ ok: false, reason: 'no-ready' });
  });

  it('buffers everything the content script sends before the real listener attaches, ready included, in order', async () => {
    const graph = { type: 'graph', frame: 'f-0', nodes: [], removed: [], textRuns: [], privacyEpoch: 0, reason: 'after_action', hostileDynamic: false };
    const result = await connectToLiveContent(1, { connect: () => new FakePort('live', [graph]), inject: vi.fn() });
    if (!result.ok) throw new Error('expected a live port');
    await new Promise((r) => setTimeout(r, 0));
    const received: unknown[] = [];
    result.port.onMessage.addListener((m) => received.push(m));
    await Promise.resolve();
    expect(received).toEqual([{ type: 'ready', frame: 'f-0' }, graph]);
  });

  it('never replays inside addListener — the panel forward-references a Session assigned right after the listener attaches', async () => {
    const graph = { type: 'graph', frame: 'f-0', nodes: [], removed: [], textRuns: [], privacyEpoch: 0, reason: 'after_action', hostileDynamic: false };
    const result = await connectToLiveContent(1, { connect: () => new FakePort('live', [graph]), inject: vi.fn() });
    if (!result.ok) throw new Error('expected a live port');
    await new Promise((r) => setTimeout(r, 0));

    // Mirrors entrypoints/sidepanel/main.tsx: handlers close over `session`, assigned one statement later.
    // eslint-disable-next-line prefer-const
    let session!: { onGraph(m: unknown): void };
    const seen: unknown[] = [];
    result.port.onMessage.addListener((m) => {
      if ((m as { type: string }).type === 'graph') session.onGraph(m);
    });
    session = { onGraph: (m) => seen.push(m) };

    await Promise.resolve();
    expect(seen).toEqual([graph]);
  });
});
