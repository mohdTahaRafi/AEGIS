// design.md §3.5 (T-2.15) — closed shadow roots are readable on both browsers via a privileged,
// extension-only API: `chrome.dom.openOrClosedShadowRoot(el)` on Chrome,
// `element.openOrClosedShadowRoot` on Firefox (architecture §1.3 C-8(a): Firefox *can* do this,
// correcting an earlier draft). An open shadow root needs no special API at all — `el.shadowRoot`
// already returns it to any script.
//
// Both privileged APIs require a genuine loaded-extension content-script context; a bare
// Playwright page (this project's `test/browser/` harness) has neither, so the platform lookup is
// injectable for testing (`setShadowRootPlatformForTesting`) and the *real* Chrome/Firefox APIs
// are exercised only once there is a loaded extension to run them in — `test/e2e/spine.spec.ts`
// (T-2.47), not here. What real-Chromium tests here verify directly: open shadow roots are walked
// correctly (no privileged API involved), and the platform-selection wiring calls whichever
// injected API is present.

export interface ShadowRootPlatform {
  getShadowRoot(el: Element): ShadowRoot | null;
}

type ChromeDomGlobal = { dom?: { openOrClosedShadowRoot?(el: Element): ShadowRoot | null } };
type FirefoxShadowElement = Element & { openOrClosedShadowRoot?: ShadowRoot | null };

function detectPlatform(): ShadowRootPlatform {
  const chromeDom = (globalThis as typeof globalThis & { chrome?: ChromeDomGlobal }).chrome?.dom;
  if (typeof chromeDom?.openOrClosedShadowRoot === 'function') {
    const openOrClosedShadowRoot = chromeDom.openOrClosedShadowRoot.bind(chromeDom);
    return { getShadowRoot: (el) => openOrClosedShadowRoot(el) ?? el.shadowRoot };
  }
  if ('openOrClosedShadowRoot' in Element.prototype) {
    return { getShadowRoot: (el) => (el as FirefoxShadowElement).openOrClosedShadowRoot ?? el.shadowRoot };
  }
  return { getShadowRoot: (el) => el.shadowRoot };
}

let platform: ShadowRootPlatform = detectPlatform();

/** Test hook only. Passing `null` restores real feature detection. */
export function setShadowRootPlatformForTesting(injected: ShadowRootPlatform | null): void {
  platform = injected ?? detectPlatform();
}

export function getShadowRoot(el: Element): ShadowRoot | null {
  try {
    return platform.getShadowRoot(el) ?? null;
  } catch {
    return null;
  }
}

/**
 * Every element under `root`, in its light DOM and recursively inside every shadow tree this
 * platform can see into (open always; closed wherever the privileged API is available). One
 * `querySelectorAll('*')` per tree, matching T-2.10's "single pass" geometry-read discipline —
 * the geometry read itself still happens once, over this flat list, in `readBoxesInOnePass`.
 */
export function collectAllElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  const trees: ParentNode[] = [root];
  while (trees.length > 0) {
    const tree = trees.pop()!;
    for (const el of Array.from(tree.querySelectorAll('*'))) {
      out.push(el);
      const shadow = getShadowRoot(el);
      if (shadow) trees.push(shadow);
    }
  }
  return out;
}
