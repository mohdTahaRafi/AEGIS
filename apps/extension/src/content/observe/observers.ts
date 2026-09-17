// design.md §5.5 — wires MutationObserver (classified, epoch-updating) plus ResizeObserver,
// scroll and focus listeners (which just signal "re-observe", carrying no classification of their
// own) into one lifecycle. phase_2_spine.md §3.1: content-script lifecycle is idle until the host
// connects a port and tears everything down on disconnect — `disconnect()` here is that teardown.

import { ContainerResolver } from '../screen-graph/identity';
import { classifyMutation } from './classify';
import { EpochTracker } from './epochs';

export interface ScreenGraphObserverHandle {
  disconnect(): void;
}

function resolveTargetElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

/**
 * Starts observing `root` for mutations, resizes, scrolls and focus changes. Every mutation is
 * classified (design.md §5.5) and applied to `epochTracker`; any non-cosmetic change, plus every
 * resize/scroll/focus event, invokes `onChange` so a caller can trigger re-observation.
 */
export function startObserving(
  root: Node,
  containerResolver: ContainerResolver,
  epochTracker: EpochTracker,
  onChange: () => void,
): ScreenGraphObserverHandle {
  const mutationObserver = new MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      const targetEl = resolveTargetElement(record.target);
      if (!targetEl) continue;
      const mutationClass = classifyMutation(record);
      if (mutationClass === 'cosmetic') continue;
      epochTracker.apply(mutationClass, containerResolver.resolve(targetEl));
      changed = true;
    }
    if (changed) onChange();
  });
  mutationObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });

  const resizeObserver = new ResizeObserver(() => onChange());
  if (root instanceof Element) resizeObserver.observe(root);

  // `scrollend` (design.md §5.5), not `scroll`: it fires once scrolling settles rather than on
  // every frame of a scroll gesture, which matters for the idle-cost goal (NFR-4).
  const onScrollEnd = () => onChange();
  const onFocus = () => onChange();
  const listenerOptions = { passive: true, capture: true } as const;
  window.addEventListener('scrollend', onScrollEnd, listenerOptions);
  window.addEventListener('focus', onFocus, listenerOptions);

  return {
    disconnect() {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('scrollend', onScrollEnd, listenerOptions);
      window.removeEventListener('focus', onFocus, listenerOptions);
    },
  };
}
