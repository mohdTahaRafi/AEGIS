// design.md §3.5 / architecture §5.4 (T-2.14) — child frames report their own sub-graphs. The
// offset that maps a child frame's local coordinates into top-level viewport coordinates always
// comes from the parent's own `getBoundingClientRect()` on the real <iframe> element — never from
// anything the child self-reports — so there is nothing for the child to forge there.
//
// What the nonce handshake actually defends against [A]: a hostile page script sharing the same
// `window` as a content script can call `dispatchEvent(new MessageEvent(...))` directly, forging
// any `source`/`origin` it likes on a *synthetic* event — object-identity or origin-string checks
// alone are not enough (and origin strings are unreliable here anyway: `about:blank`/`about:srcdoc`
// frames, which are legitimately same-origin, report the literal string `"null"`). The one thing a
// page script cannot forge is `event.isTrusted`: the browser sets that to `true` only for an event
// it dispatched itself from a genuine `postMessage` IPC delivery, never for a script-constructed
// one. Combined with a fresh, unpredictable per-handshake nonce that is only ever delivered into
// the challenged frame's own realm (a different global scope the parent cannot observe), a reply
// is accepted only if it is trusted and echoes the exact nonce — anything else (forged, wrong
// nonce, or silence) is treated the same as an uninjectable cross-origin frame: an unexplained
// region, never a guessed-at sub-graph. `iframe.contentDocument` access already proves same-origin
// (the browser throws otherwise), so the handshake's job is confirming a *live content script* is
// present, not re-proving an origin we already have direct DOM access to. Needs real nested
// browsing contexts, so this is exercised in test/browser/, not jsdom.

import { extractScreenGraph, type RawScreenNode } from './extractor';
import type { ContainerResolver, NodeIdentityRegistry } from './identity';

const CHALLENGE = 'aegis:frame-challenge';
const RESPONSE = 'aegis:frame-response';

interface ChallengeMessage {
  type: typeof CHALLENGE;
  nonce: string;
}

interface ResponseMessage {
  type: typeof RESPONSE;
  nonce: string;
}

function isResponseMessage(data: unknown): data is ResponseMessage {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as { type?: unknown; nonce?: unknown };
  return candidate.type === RESPONSE && typeof candidate.nonce === 'string';
}

function isChallengeMessage(data: unknown): data is ChallengeMessage {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as { type?: unknown; nonce?: unknown };
  return candidate.type === CHALLENGE && typeof candidate.nonce === 'string';
}

function randomNonce(): string {
  return crypto.randomUUID();
}

/**
 * Confirms `frameWindow` (already known same-origin via direct DOM access) is running a live
 * AEGIS content script by round-tripping a fresh, unguessable nonce. A reply is accepted only if
 * it is browser-trusted (not a page script's synthetic `dispatchEvent`) and echoes the exact
 * nonce; anything else — forged, wrong nonce, no reply — resolves `false` after `timeoutMs`.
 * Fail closed, not fail slow.
 */
export function handshake(frameWindow: Window, timeoutMs = 250, listenOn: Window = window): Promise<boolean> {
  const nonce = randomNonce();
  return new Promise((resolve) => {
    let settled = false;

    function finish(result: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listenOn.removeEventListener('message', onMessage);
      resolve(result);
    }

    function onMessage(event: MessageEvent): void {
      if (!event.isTrusted) return;
      if (!isResponseMessage(event.data)) return;
      if (event.data.nonce !== nonce) return;
      finish(true);
    }

    const timer = setTimeout(() => finish(false), timeoutMs);
    listenOn.addEventListener('message', onMessage);
    const challenge: ChallengeMessage = { type: CHALLENGE, nonce };
    frameWindow.postMessage(challenge, '*');
  });
}

/**
 * Installed once by a child frame's content script so it can answer its parent's handshake
 * challenge. Only answers a browser-trusted challenge (a synthetic `dispatchEvent` is ignored) —
 * it never originates geometry of its own, only echoes the nonce it was given.
 */
export function installFrameHandshakeResponder(target: Window = window): () => void {
  function onMessage(event: MessageEvent): void {
    if (target.parent === target) return;
    if (!event.isTrusted) return;
    if (!isChallengeMessage(event.data)) return;
    const response: ResponseMessage = { type: RESPONSE, nonce: event.data.nonce };
    target.parent.postMessage(response, '*');
  }
  target.addEventListener('message', onMessage);
  return () => target.removeEventListener('message', onMessage);
}

/** `f-<n>`, sequential per extraction session. `f-0` is reserved for the top-level frame. */
export function createFrameIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `f-${counter}`;
  };
}

function isSameOriginIframe(iframe: HTMLIFrameElement): boolean {
  try {
    return iframe.contentDocument !== null;
  } catch {
    return false;
  }
}

function translateNode(node: RawScreenNode, offset: DOMRectReadOnly): RawScreenNode {
  return {
    ...node,
    box: [node.box[0] + offset.left, node.box[1] + offset.top, node.box[2], node.box[3]],
  };
}

export interface FrameExtractionDeps {
  identity: NodeIdentityRegistry;
  containerResolver: ContainerResolver;
  nextFrameId: () => string;
  /** Test hook only — production callers use the default. */
  handshakeTimeoutMs?: number;
}

/**
 * Walks the same-origin iframes directly under `root`, confirms each one is running a live
 * content script via {@link handshake}, and merges its sub-graph (including its own nested
 * frames) with boxes translated into `root`'s coordinate space. Cross-origin frames and frames
 * that fail or don't answer the handshake are skipped — they become unexplained regions for the
 * vision channel (Phase 4), never a guessed-at sub-graph.
 */
export interface ChildFrameExtraction {
  nodes: RawScreenNode[];
  /** Same purpose as `ExtractedGraph.elements` — internal-only, never serialized. */
  elements: Map<string, Element>;
}

export async function extractChildFrames(root: ParentNode, deps: FrameExtractionDeps): Promise<ChildFrameExtraction> {
  const iframes = Array.from(root.querySelectorAll('iframe'));
  const nodes: RawScreenNode[] = [];
  const elements = new Map<string, Element>();

  for (const iframe of iframes) {
    if (!isSameOriginIframe(iframe)) continue;
    const contentWindow = iframe.contentWindow;
    const contentDocument = iframe.contentDocument;
    if (!contentWindow || !contentDocument || !contentDocument.body) continue;

    const trusted = await handshake(contentWindow, deps.handshakeTimeoutMs);
    if (!trusted) continue;

    const iframeBox = iframe.getBoundingClientRect();
    const frameId = deps.nextFrameId();

    const childGraph = extractScreenGraph(deps.identity, deps.containerResolver, {
      root: contentDocument.body,
      frame: frameId,
    });
    for (const node of childGraph.nodes) {
      nodes.push(translateNode(node, iframeBox));
      const el = childGraph.elements.get(node.id);
      if (el) elements.set(node.id, el);
    }

    const grandchildren = await extractChildFrames(contentDocument.body, deps);
    for (const node of grandchildren.nodes) {
      nodes.push(translateNode(node, iframeBox));
      const el = grandchildren.elements.get(node.id);
      if (el) elements.set(node.id, el);
    }
  }

  return { nodes, elements };
}
