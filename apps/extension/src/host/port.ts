// design.md §5.1 (T-2.5, host half) — the host is the port's initiator: it calls
// `browser.tabs.connect(tabId, {name})`, which the content script receives via
// `runtime.onConnect` (see src/content/port.ts's doc comment for why the connection direction is
// host→content rather than the reverse, and why that's what keeps the content script idle-cost).

import { log } from '../shared/logger';
import type { ActionResultMessage, ContentToHostMessage, GraphMessage, HostToContentMessage, PageReadyMessage, SettledMessage, WireAction } from '../shared/messages';
import { PORT_NAME, isContentToHostMessage } from '../shared/messages';

export interface HostPort {
  postMessage(message: HostToContentMessage): void;
  disconnect?(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface TabsApi {
  connect(tabId: number, options: { name: string }): HostPort;
}

export function connectToTab(tabs: TabsApi, tabId: number): HostPort {
  return tabs.connect(tabId, { name: PORT_NAME });
}

export interface ContentPortHandlers {
  onReady?(frame: string): void;
  onGraph?(message: GraphMessage): void;
  onActionResult?(message: ActionResultMessage): void;
  onSettled?(message: SettledMessage): void;
  onNavigated?(): void;
  onDisconnect?(): void;
}

/** Validated dispatch of every inbound message, and typed helpers for the two outbound requests
 * the host ever makes of the content script. A malformed message is logged (closed vocabulary)
 * and dropped, never thrown. */
export class ContentPortClient {
  private readonly readyWaiters = new Map<string, (message: PageReadyMessage | null) => void>();
  private readonly spanWaiters = new Map<string, (boxes: [number, number, number, number][][] | null) => void>();
  private readyCounter = 0;

  constructor(
    private readonly port: HostPort,
    private readonly handlers: ContentPortHandlers,
  ) {
    port.onMessage.addListener(this.onMessage);
    port.onDisconnect.addListener(() => {
      for (const resolve of this.readyWaiters.values()) resolve(null);
      this.readyWaiters.clear();
      for (const resolve of this.spanWaiters.values()) resolve(null);
      this.spanWaiters.clear();
      this.handlers.onDisconnect?.();
    });
  }

  private onMessage = (raw: unknown): void => {
    if (!isContentToHostMessage(raw)) {
      log({ code: 'port_message_malformed' });
      return;
    }
    this.route(raw);
  };

  private route(message: ContentToHostMessage): void {
    switch (message.type) {
      case 'ready':
        this.handlers.onReady?.(message.frame);
        return;
      case 'graph':
        this.handlers.onGraph?.(message);
        return;
      case 'action-result':
        this.handlers.onActionResult?.(message);
        return;
      case 'settled':
        this.handlers.onSettled?.(message);
        return;
      case 'navigated':
        this.handlers.onNavigated?.();
        return;
      case 'span-boxes':
        this.spanWaiters.get(message.requestId)?.(message.boxes);
        this.spanWaiters.delete(message.requestId);
        return;
      case 'page-ready':
        this.readyWaiters.get(message.requestId)?.(message);
        this.readyWaiters.delete(message.requestId);
        return;
      case 'pong':
        return;
    }
  }

  /** On-screen rectangles of text-run character spans, or null if the page cannot answer (within
   * `timeoutMs`). Never rejects. */
  measureSpans(spans: { runId: string; start: number; end: number }[], timeoutMs = 1500): Promise<[number, number, number, number][][] | null> {
    const requestId = `m-${++this.readyCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (boxes: [number, number, number, number][][] | null): void => {
        clearTimeout(timer);
        this.spanWaiters.delete(requestId);
        resolve(boxes);
      };
      this.spanWaiters.set(requestId, finish);
      try {
        this.port.postMessage({ type: 'measure-spans', requestId, spans });
      } catch {
        finish(null);
      }
    });
  }

  /** Resolves when the page reports itself visually complete, or null if it cannot answer (an
   * older content script, a disconnect, or no answer within `maxMs` plus a margin). Never rejects. */
  awaitReady(maxMs: number): Promise<PageReadyMessage | null> {
    const requestId = `r-${++this.readyCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), maxMs + 1500);
      const finish = (message: PageReadyMessage | null): void => {
        clearTimeout(timer);
        this.readyWaiters.delete(requestId);
        resolve(message);
      };
      this.readyWaiters.set(requestId, finish);
      try {
        this.port.postMessage({ type: 'await-ready', requestId, maxMs });
      } catch {
        finish(null);
      }
    });
  }

  requestExtract(): void {
    this.port.postMessage({ type: 'extract' });
  }

  dispatchAction(actionId: string, action: WireAction): void {
    this.port.postMessage({ type: 'dispatch-action', actionId, action });
  }
}
