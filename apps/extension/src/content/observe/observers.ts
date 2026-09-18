// design.md §5.5 — wires MutationObserver (classified, epoch-updating) plus ResizeObserver,
// scroll and focus listeners (which just signal "re-observe", carrying no classification of their
// own) into one lifecycle. phase_2_spine.md §3.1: content-script lifecycle is idle until the host
// connects a port and tears everything down on disconnect — `disconnect()` here is that teardown.

import { ContainerResolver } from '../screen-graph/identity';
import { classifyMutation } from './classify';
import { EpochTracker } from './epochs';
import { HostileDynamicTracker, VolatilityTracker } from './volatility';

export interface ScreenGraphObserverHandle {
  disconnect(): void;
}

/** T-6.7, optional (defaults to no rate tracking — every pre-existing 4-arg caller/test is
 * unaffected). `onHostileDynamicChange` fires only on a true/false transition edge, not on every
 * mutation batch while the state is unchanged. */
export interface VolatilityDeps {
  volatilityTracker: VolatilityTracker;
  hostileDynamicTracker: HostileDynamicTracker;
  onHostileDynamicChange?: (active: boolean) => void;
  now?: () => number;
}

function resolveTargetElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

/**
 * Starts observing `root` for mutations, resizes, scrolls and focus changes. Every mutation is
 * classified (design.md §5.5) and applied to `epochTracker`; any non-cosmetic change, plus every
 * resize/scroll/focus event, invokes `onChange` so a caller can trigger re-observation.
 *
 * `volatility` (T-6.7) records every mutation into `volatilityTracker` — deliberately including
 * cosmetic ones, since design.md's own "clocks and counters" volatile-node example is itself
 * classified cosmetic (see `volatility.ts`'s doc comment) — and every non-cosmetic one into
 * `hostileDynamicTracker`, the same "non-cosmetic" test the epoch bump already uses.
 */
export function startObserving(
  root: Node,
  containerResolver: ContainerResolver,
  epochTracker: EpochTracker,
  onChange: () => void,
  volatility?: VolatilityDeps,
): ScreenGraphObserverHandle {
  let wasHostileDynamic = false;
  const mutationObserver = new MutationObserver((records) => {
    let changed = false;
    const now = volatility?.now?.() ?? Date.now();
    for (const record of records) {
      const targetEl = resolveTargetElement(record.target);
      if (!targetEl) continue;
      volatility?.volatilityTracker.record(targetEl, now);
      const mutationClass = classifyMutation(record);
      if (mutationClass === 'cosmetic') continue;
      epochTracker.apply(mutationClass, containerResolver.resolve(targetEl));
      volatility?.hostileDynamicTracker.record(now);
      changed = true;
    }
    if (volatility) {
      const isHostileDynamic = volatility.hostileDynamicTracker.isHostileDynamic(now);
      if (isHostileDynamic !== wasHostileDynamic) {
        wasHostileDynamic = isHostileDynamic;
        volatility.onHostileDynamicChange?.(isHostileDynamic);
      }
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
