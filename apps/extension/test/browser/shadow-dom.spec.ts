import { afterEach, describe, expect, it } from 'vitest';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { collectAllElements, getShadowRoot, setShadowRootPlatformForTesting } from '../../src/content/screen-graph/shadow-dom';

afterEach(() => {
  document.body.innerHTML = '';
  setShadowRootPlatformForTesting(null);
});

describe('getShadowRoot / collectAllElements — open shadow roots (design.md §3.5)', () => {
  it('finds an element inside an open shadow root with no special API needed', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Inside shadow</button>';

    const elements = collectAllElements(document.body);
    expect(elements.some((el) => el.tagName === 'BUTTON' && el.textContent === 'Inside shadow')).toBe(true);
  });

  it('recurses into a shadow root nested inside another shadow root', () => {
    document.body.innerHTML = '<div id="outer-host"></div>';
    const outerHost = document.getElementById('outer-host')!;
    const outerShadow = outerHost.attachShadow({ mode: 'open' });
    outerShadow.innerHTML = '<div id="inner-host"></div>';
    const innerHost = outerShadow.getElementById('inner-host')!;
    const innerShadow = innerHost.attachShadow({ mode: 'open' });
    innerShadow.innerHTML = '<button>Deeply nested</button>';

    const elements = collectAllElements(document.body);
    expect(elements.some((el) => el.textContent === 'Deeply nested')).toBe(true);
  });

  it('a real screen-graph extraction picks up an interactive node inside an open shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Shadow submit</button>';

    const { nodes } = extractScreenGraph(createNodeIdentityRegistry(), new ContainerResolver());
    const shadowButton = nodes.find((n) => n.name === 'Shadow submit');
    expect(shadowButton).toBeDefined();
    expect(shadowButton!.role).toBe('button');
  });

  it('returns null for an element with a closed shadow root when no privileged API is available', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'closed' });
    // No platform injected — real feature detection in this bare Playwright page (no loaded
    // extension) finds neither chrome.dom nor Element.prototype.openOrClosedShadowRoot.
    expect(getShadowRoot(host)).toBeNull();
  });
});

describe('platform wiring for the privileged closed-shadow-root APIs (T-2.15)', () => {
  // The real chrome.dom.openOrClosedShadowRoot() / Element.openOrClosedShadowRoot only exist in a
  // genuine loaded-extension content-script context, which this Playwright-only harness does not
  // have. What's verified here is that getShadowRoot() correctly calls through to whichever
  // platform API is present — the actual Chrome and Firefox APIs are exercised by the real loaded
  // extension in test/e2e/spine.spec.ts (T-2.47), not here.
  it('calls an injected Chrome-shaped chrome.dom.openOrClosedShadowRoot for a closed shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const closedShadow = host.attachShadow({ mode: 'closed' });
    closedShadow.innerHTML = '<button>Closed via chrome.dom</button>';

    setShadowRootPlatformForTesting({
      getShadowRoot: (el) => (el === host ? closedShadow : el.shadowRoot),
    });

    expect(getShadowRoot(host)).toBe(closedShadow);
    const elements = collectAllElements(document.body);
    expect(elements.some((el) => el.textContent === 'Closed via chrome.dom')).toBe(true);
  });

  it('a platform that throws is treated as "no shadow root", never crashes extraction', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    setShadowRootPlatformForTesting({
      getShadowRoot: () => {
        throw new Error('simulated privileged-API failure');
      },
    });
    expect(getShadowRoot(host)).toBeNull();
    expect(() => collectAllElements(document.body)).not.toThrow();
  });
});
