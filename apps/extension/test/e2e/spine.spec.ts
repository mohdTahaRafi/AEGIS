// phase_2_spine.md §10's milestone / T-2.47 — end-to-end on fixtures/login.html.
//
// What this test honestly proves, in a real browser against the real fixture file: the extractor
// finds the real username/password/submit nodes, pre-flight resolves and clears them for
// dispatch, and the real synthetic event sequences (src/content/execute/dispatch.ts) actually
// drive the page — the username field fills, the password field fills, the button depresses, and
// the fixture's own submit handler runs and shows the success state. This is the one part of the
// milestone that *needs* a real browser (jsdom cannot run a real `submit` handler's behavior).
//
// What this test does NOT prove, and why: a live vLLM call (no GPU in this environment — OQ-13
// is still open) and driving the actual side-panel UI end-to-end through a loaded MV3 extension
// (Playwright's extension support targets pages, not automating a loaded side panel's own UI the
// way eval/'s Playwright runner drives ordinary page content — see docs/HISTORY.md). The gateway
// half of this pipeline (real HTTP server, real replay-mode round trip) is proven separately in
// server/gateway/tests/test_e2e_subprocess.py, and the orchestration logic tying content + gateway
// together (src/host/session.ts) is proven with fakes in test/unit/session.spec.ts. This file is
// the one piece neither of those can cover: real DOM manipulation actually working.
import { afterEach, describe, expect, it } from 'vitest';
// `?raw`: this test runs *in* the real browser tab (Vitest browser mode transforms and executes
// the test file there, not in Node), so `node:fs` isn't available — Vite inlines the fixture's
// content as a string at transform time instead, which works in any Vite context.
import fixtureHtml from '../fixtures/login.html?raw';
import { runPreflight, NodeResolutionRegistry } from '../../src/content/execute/preflight';
import { dispatchClick, dispatchType } from '../../src/content/execute/dispatch';
import { passesHitTest } from '../../src/content/execute/preflight';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { waitForSettle } from '../../src/content/execute/settle';
import type { WireAction } from '../../src/shared/messages';

afterEach(() => {
  document.body.innerHTML = '';
});

function loadFixtureIntoDocument(): void {
  const bodyMatch = fixtureHtml.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error('fixture has no <body>');
  document.body.innerHTML = bodyMatch[1]!.replace(/<script>[\s\S]*?<\/script>/, '');

  // Re-attach the fixture's own submit handler exactly as its inline <script> defines it — the
  // real point of this test is proving that handler actually runs in response to our synthetic
  // event sequence, not merely that events were dispatched.
  const form = document.getElementById('login-form') as HTMLFormElement;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    form.hidden = true;
    document.getElementById('success')!.hidden = false;
  });
}

describe('End-to-end on fixtures/login.html (T-2.47, real-browser scope)', () => {
  it('fills username and password and submits via the real synthetic dispatch sequence', async () => {
    loadFixtureIntoDocument();

    const identity = createNodeIdentityRegistry();
    const containerResolver = new ContainerResolver();
    const registry = new NodeResolutionRegistry();

    const graph = extractScreenGraph(identity, containerResolver, {});
    const index = registry.observe(graph, containerResolver);

    const usernameNode = graph.nodes.find((n) => n.name === 'Username' && n.role === 'textbox')!;
    const passwordNode = graph.nodes.find((n) => n.name === 'Password' && n.role === 'textbox')!;
    const submitNode = graph.nodes.find((n) => n.name === 'Sign in' && n.role === 'button')!;
    expect(usernameNode).toBeDefined();
    expect(passwordNode).toBeDefined();
    expect(submitNode).toBeDefined();

    // Simulates the plan the model would return, per phase_2_spine.md §10's milestone script:
    // type into the username field, type into the password field, click submit.
    const actions: WireAction[] = [
      { op: 'type', node: usernameNode.id, text: 'ramesh.kumar' },
      { op: 'type', node: passwordNode.id, text: 'correct-horse-battery-staple' },
      { op: 'click', node: submitNode.id },
    ];

    for (const action of actions) {
      const preflight = runPreflight(action, registry, index, containerResolver);
      expect(preflight.ok).toBe(true);
      if (!preflight.ok) continue;

      if (action.op === 'type') {
        const result = dispatchType(preflight.element, action.text, { willMoveFocusNext: false });
        expect(result.ok).toBe(true);
      } else if (action.op === 'click') {
        const result = dispatchClick(preflight.element, passesHitTest);
        expect(result.ok).toBe(true);
      }
    }

    const outcome = await waitForSettle(document.body, { quietMs: 100, maxWaitMs: 2000 });
    expect(outcome).toBe('settled');

    expect((document.getElementById('username') as HTMLInputElement).value).toBe('ramesh.kumar');
    expect((document.getElementById('password') as HTMLInputElement).value).toBe('correct-horse-battery-staple');
    expect((document.getElementById('login-form') as HTMLFormElement).hidden).toBe(true);
    expect(document.getElementById('success')!.hidden).toBe(false);
    expect(document.getElementById('success')!.textContent).toContain('Signed in successfully');
  });

  it('rejects the submit click if a transparent overlay covers the button (AC-5 clickjacking guard, on the real fixture)', () => {
    loadFixtureIntoDocument();
    const overlay = document.createElement('div');
    overlay.id = 'injected-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;';
    document.body.appendChild(overlay);

    const identity = createNodeIdentityRegistry();
    const containerResolver = new ContainerResolver();
    const registry = new NodeResolutionRegistry();
    const graph = extractScreenGraph(identity, containerResolver, {});
    const index = registry.observe(graph, containerResolver);
    const submitNode = graph.nodes.find((n) => n.name === 'Sign in' && n.role === 'button')!;

    const preflight = runPreflight({ op: 'click', node: submitNode.id }, registry, index, containerResolver);
    expect(preflight).toEqual({ ok: false, reason: 'HIT_TEST_FAILED' });
  });
});
