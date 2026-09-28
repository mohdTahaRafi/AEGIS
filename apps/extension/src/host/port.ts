// design.md §5.1 (T-2.5, host half) — the host is the port's initiator: it calls
// `browser.tabs.connect(tabId, {name})`, which the content script receives via
// `runtime.onConnect` (see src/content/port.ts's doc comment for why the connection direction is
// host→content rather than the reverse, and why that's what keeps the content script idle-cost).

import { log } from '../shared/logger';
import type { ActionResultMessage, ContentToHostMessage, GraphMessage, HostToContentMessage, SettledMessage, WireAction } from '../shared/messages';
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
  constructor(
    private readonly port: HostPort,
    private readonly handlers: ContentPortHandlers,
  ) {
    port.onMessage.addListener(this.onMessage);
    port.onDisconnect.addListener(() => this.handlers.onDisconnect?.());
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
      case 'pong':
        return;
    }
  }

  requestExtract(): void {
    this.port.postMessage({ type: 'extract' });
  }

  dispatchAction(actionId: string, action: WireAction): void {
    this.port.postMessage({ type: 'dispatch-action', actionId, action });
  }
}
