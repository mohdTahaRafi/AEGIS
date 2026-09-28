// design.md §5.1 (host half) — getting a LIVE content script on the other end of the port.
// Declared content scripts are only injected on page load, so a tab that was already open when
// the extension was installed/reloaded (or that loaded before its host grant) has either no
// content script or an orphaned one from the previous extension instance. `tabs.connect` to such
// a tab "succeeds" and then immediately disconnects with "Could not establish connection.
// Receiving end does not exist." — and a session built on that port would wait forever for a
// graph that can never arrive. So: connect, wait for the content script's own `ready`, and if it
// never comes, inject the declared script programmatically (allowed by `activeTab` on the tab the
// toolbar icon was clicked on, or by a host grant) and try once more.

import type { HostPort } from './port';

export interface ContentConnectDeps {
  connect(tabId: number): HostPort;
  /** Injects the manifest's declared content script into every frame of the tab. */
  inject(tabId: number): Promise<void>;
  /** Reads (and so marks as checked) the browser's `runtime.lastError` after a disconnect. */
  lastErrorMessage?(): string | undefined;
  readyTimeoutMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type ContentConnectResult =
  | { ok: true; port: HostPort; injected: boolean }
  | { ok: false; reason: 'inject-failed'; detail?: string }
  | { ok: false; reason: 'no-ready' };

const DEFAULT_READY_TIMEOUT_MS = 1500;

/** Buffers inbound messages until the first real listener attaches, then replays them in order —
 * the content script starts auto-sending graph deltas as soon as it is connected, and a delta
 * dropped between the handshake and `ContentPortClient`'s construction would leave the host's
 * accumulated node set permanently out of step with the content script's delta tracker. */
function buffered(inner: HostPort): HostPort {
  const listeners: Array<(message: unknown) => void> = [];
  const pending: unknown[] = [];
  let draining = true;
  const deliver = (message: unknown): void => {
    for (const listener of listeners) listener(message);
  };
  inner.onMessage.addListener((message) => {
    if (draining) pending.push(message);
    else deliver(message);
  });
  return {
    postMessage: (message) => inner.postMessage(message),
    disconnect: () => inner.disconnect?.(),
    onDisconnect: inner.onDisconnect,
    onMessage: {
      addListener(cb) {
        listeners.push(cb);
        if (listeners.length > 1) return;
        // Replayed on the next microtask, never inside `addListener`: the listener is attached in
        // ContentPortClient's constructor, and the panel's handlers forward to a Session that is
        // only assigned on the statement AFTER that constructor returns. A synchronous replay of a
        // buffered graph called `newSession.onGraph` on `undefined` and froze the panel on
        // "Loading" — reproduced in Chromium 153 before this was deferred.
        queueMicrotask(() => {
          for (const message of pending.splice(0)) deliver(message);
          draining = false;
        });
      },
    },
  };
}

function isReady(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready';
}

async function tryConnect(tabId: number, deps: ContentConnectDeps): Promise<HostPort | null> {
  const setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const inner = deps.connect(tabId);
  const port = buffered(inner);
  const live = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      resolve(value);
    };
    const timer = setTimeoutFn(() => settle(false), deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    inner.onDisconnect.addListener(() => {
      deps.lastErrorMessage?.();
      settle(false);
    });
    // On the inner port, so it peeks without counting as the buffered wrapper's consumer: `ready`
    // and anything after it are still replayed to ContentPortClient once that attaches.
    inner.onMessage.addListener((message) => {
      if (isReady(message)) settle(true);
    });
  });
  if (live) return port;
  // A late `ready` on an abandoned port would otherwise start a second content session.
  port.disconnect?.();
  return null;
}

export async function connectToLiveContent(tabId: number, deps: ContentConnectDeps): Promise<ContentConnectResult> {
  const first = await tryConnect(tabId, deps);
  if (first) return { ok: true, port: first, injected: false };

  try {
    await deps.inject(tabId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'inject-failed', detail: message.replace(/"[^"]*"/g, '"…"') };
  }

  const second = await tryConnect(tabId, deps);
  return second ? { ok: true, port: second, injected: true } : { ok: false, reason: 'no-ready' };
}
