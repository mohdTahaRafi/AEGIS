// design.md §5.1 (T-2.5, T-2.6) — the content script does nothing observable until the host
// connects a port, and tears everything down on disconnect. The receiving end (this file) is
// where `sender.id` gets checked: the host initiates via `browser.tabs.connect(tabId, {name})`
// (architecture line 160's "runtime.Port, per frame" — this project connects only the top frame;
// see frames.ts's doc comment for why child frames are walked directly instead of getting their
// own port).
//
// `PortLike` is a small structural subset of `Browser.runtime.Port` so this file's actual logic
// (`TopFrameSession`) can be unit-tested with a hand-written fake port — `wxt`'s `fakeBrowser`
// test double does not implement ports at all (verified directly: `runtime.onConnect.addListener`
// throws "not implemented" there), so depending on it here would make this file untestable.

import type { ContentToHostMessage, HostToContentMessage, WireAction, WireScreenNode } from '../shared/messages';
import { PORT_NAME, isHostToContentMessage } from '../shared/messages';
import { log } from '../shared/logger';
import { dispatchClick, dispatchClickPoint, dispatchScroll, dispatchSelect, dispatchType } from './execute/dispatch';
import { NodeResolutionRegistry, passesHitTest, runPreflight } from './execute/preflight';
import { waitForSettle } from './execute/settle';
import { DeltaTracker } from './observe/delta';
import { EpochTracker } from './observe/epochs';
import { startObserving, type ScreenGraphObserverHandle } from './observe/observers';
import type { ExtractedGraph, RawScreenNode } from './screen-graph/extractor';
import { extractScreenGraph } from './screen-graph/extractor';
import { createFrameIdGenerator, extractChildFrames, installFrameHandshakeResponder } from './screen-graph/frames';
import { ContainerResolver, createNodeIdentityRegistry, type NodeIdentityRegistry } from './screen-graph/identity';

export interface PortLike {
  name: string;
  sender?: { id?: string };
  postMessage(message: ContentToHostMessage): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

function toWireNode(node: RawScreenNode): WireScreenNode {
  const { key: _key, ...wire } = node;
  return wire;
}

export class TopFrameSession {
  private readonly identity: NodeIdentityRegistry = createNodeIdentityRegistry();
  private readonly containerResolver = new ContainerResolver();
  private readonly epochTracker = new EpochTracker();
  private readonly deltaTracker = new DeltaTracker();
  private readonly resolutionRegistry = new NodeResolutionRegistry();
  private readonly nextFrameId = createFrameIdGenerator();
  private observerHandle: ScreenGraphObserverHandle | null = null;

  constructor(private readonly port: PortLike) {}

  start(): void {
    this.port.onMessage.addListener(this.onMessage);
    this.port.onDisconnect.addListener(this.teardown);
    this.observerHandle = startObserving(document.body, this.containerResolver, this.epochTracker, () => {
      void this.sendGraph('after_action');
    });
    this.send({ type: 'ready', frame: 'f-0' });
    void this.sendGraph('initial');
  }

  private teardown = (): void => {
    this.observerHandle?.disconnect();
    this.observerHandle = null;
    log({ code: 'observers_stopped' });
  };

  private send(message: ContentToHostMessage): void {
    this.port.postMessage(message);
  }

  private onMessage = (raw: unknown): void => {
    if (!isHostToContentMessage(raw)) {
      log({ code: 'port_message_malformed' });
      return;
    }
    // Never let a rejection escape into an unhandled promise rejection observable outside this
    // isolated world (T-2.5's "never thrown into the page").
    this.handle(raw).catch(() => log({ code: 'port_message_malformed' }));
  };

  private async handle(message: HostToContentMessage): Promise<void> {
    if (message.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (message.type === 'extract') {
      await this.sendGraph('requested');
      return;
    }
    await this.handleDispatch(message.actionId, message.action);
  }

  /** Own frame plus every reachable same-origin child, merged — the shape `NodeResolutionRegistry`
   * and delta computation both need. */
  private async extractMerged(): Promise<{ graph: ExtractedGraph; wireNodes: WireScreenNode[] }> {
    const own = extractScreenGraph(this.identity, this.containerResolver, { frame: 'f-0' });
    const children = await extractChildFrames(document.body, {
      identity: this.identity,
      containerResolver: this.containerResolver,
      nextFrameId: this.nextFrameId,
    });
    const nodes = [...own.nodes, ...children.nodes];
    const elements = new Map(own.elements);
    for (const [id, el] of children.elements) elements.set(id, el);
    return { graph: { nodes, elements }, wireNodes: nodes.map(toWireNode) };
  }

  private async sendGraph(reason: 'initial' | 'after_action' | 'requested' | 'reconcile'): Promise<void> {
    const { graph, wireNodes } = await this.extractMerged();
    this.resolutionRegistry.observe(graph, this.containerResolver);
    const delta = this.deltaTracker.compute(wireNodes, this.epochTracker.privacyEpoch);
    this.send({
      type: 'graph',
      frame: 'f-0',
      nodes: delta.nodes,
      removed: delta.removed,
      privacyEpoch: this.epochTracker.privacyEpoch,
      reason,
    });
  }

  private async handleDispatch(actionId: string, action: WireAction): Promise<void> {
    const { graph } = await this.extractMerged();
    const index = this.resolutionRegistry.observe(graph, this.containerResolver);

    // Pre-flight, then dispatch, with no `await` between them (design.md §5.9 — a TOCTOU gap on a
    // live, possibly hostile page is exactly the bug the "synchronous, immediately before
    // dispatch" rule exists to prevent).
    const preflight = runPreflight(action, this.resolutionRegistry, index, this.containerResolver);
    if (!preflight.ok) {
      log({ code: 'preflight_failed', detail: preflight.reason });
      this.send({ type: 'action-result', actionId, ok: false, reason: preflight.reason });
      return;
    }
    const dispatched = this.dispatchOne(action, preflight.element);
    log({ code: 'action_dispatched' });
    if (!dispatched.ok) {
      this.send({ type: 'action-result', actionId, ok: false, reason: dispatched.reason });
      return;
    }
    this.send({ type: 'action-result', actionId, ok: true });

    const outcome = await waitForSettle(document.body);
    this.send({ type: 'settled', actionId });
    if (outcome === 'navigated') return; // the new document boots its own session
    await this.sendGraph('after_action');
  }

  private dispatchOne(action: WireAction, element: Element): { ok: true } | { ok: false; reason: 'HIT_TEST_FAILED' | 'DISABLED' | 'NODE_UNRESOLVED' } {
    switch (action.op) {
      case 'click':
        return dispatchClick(element, passesHitTest);
      case 'click_point':
        return dispatchClickPoint(action.x, action.y);
      case 'type':
        return dispatchType(element, action.text, { clearFirst: action.clearFirst, willMoveFocusNext: false });
      case 'select':
        return dispatchSelect(element, action.option);
      case 'scroll': {
        const target = element === document.documentElement ? window : element;
        void dispatchScroll(target, action.direction, action.amount);
        return { ok: true };
      }
    }
  }
}

/**
 * Boots the content script (`entrypoints/content.ts`). A non-top frame only ever installs the
 * handshake responder (T-2.14) — nothing else, ever, in a child frame; the top frame is the only
 * one that connects a port, and does nothing until the host actually connects to it.
 */
export function bootContentScript(deps: {
  isTopFrame: boolean;
  onConnect: (listener: (port: PortLike) => void) => void;
  extensionId: string;
}): void {
  if (!deps.isTopFrame) {
    installFrameHandshakeResponder();
    return;
  }
  deps.onConnect((port) => {
    if (port.name !== PORT_NAME) return;
    if (port.sender?.id !== undefined && port.sender.id !== deps.extensionId) {
      log({ code: 'port_sender_untrusted' });
      return;
    }
    log({ code: 'port_connected' });
    new TopFrameSession(port).start();
  });
}
