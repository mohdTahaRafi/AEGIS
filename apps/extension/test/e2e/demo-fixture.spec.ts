// phase_7_demo_submission.md T-7.2/DR-1 — proves the demo fixture (test/fixtures/demo-login.html,
// also the file demo operators open) actually exhibits every claim DR-1 makes: a visible Aadhaar
// number, a filled password field, a profile photo, and a task that completes with the real value
// while the outbound payload never carries it. Same jsdom-vs-real-Chromium reasoning as
// privacy.spec.ts (getBoundingClientRect/checkVisibility need real layout) — this file adds the
// two things that spec doesn't cover: the profile photo becoming a real vision-eligible node, and
// driving the fixture's own submit handler through to its `#success` state (not just resolving the
// ref into the DOM field, as privacy.spec.ts's zero-egress test already does).

import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it, afterEach } from 'vitest';
import fixtureHtml from '../fixtures/demo-login.html?raw';
import { dispatchClick } from '../../src/content/execute/dispatch';
import { NodeResolutionRegistry, runPreflight } from '../../src/content/execute/preflight';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { extractTextRuns } from '../../src/content/detect/spans';
import { buildSanitizedContext } from '../../src/host/privacy/context/builder';
import { guard } from '../../src/host/privacy/guard/guard';
import { Vault } from '../../src/host/privacy/vault';

const RAW_AADHAAR = '234567890124';
const RAW_PASSWORD = 'hunter2-correct-battery';
const ORIGIN = 'origin:demo-fixture';

afterEach(() => {
  document.body.innerHTML = '';
});

function loadFixture(): void {
  const bodyMatch = fixtureHtml.match(/<body>([\s\S]*)<\/body>/);
  // innerHTML-inserted <script> tags never execute (a standard DOM behaviour, not a test quirk —
  // see test/e2e/spine.spec.ts's identical handling of fixtures/login.html), so the fixture's own
  // submit handler is stripped and re-attached verbatim below.
  document.body.innerHTML = bodyMatch![1]!.replace(/<script>[\s\S]*?<\/script>/, '');
  const form = document.getElementById('login-form') as HTMLFormElement;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    form.hidden = true;
    document.getElementById('success')!.hidden = false;
  });
}

function extract() {
  const identity = createNodeIdentityRegistry();
  const containerResolver = new ContainerResolver();
  const graph = extractScreenGraph(identity, containerResolver, {});
  const nodes = graph.nodes.map(({ key: _key, ...wire }) => wire);
  const viewport = { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight };
  const textRuns = extractTextRuns(document.body, viewport);
  return { nodes, textRuns, graph, containerResolver };
}

describe('DR-1 demo fixture (T-7.2) — the 30-second claim, checked for real', () => {
  it('the outbound payload carries neither the Aadhaar digits nor the password, and the guard reports zero leaks', async () => {
    loadFixture();
    const { nodes, textRuns } = extract();
    const vault = new Vault();
    const context = buildSanitizedContext({
      stepId: 's-1',
      task: 'log in and submit the form',
      reason: 'initial',
      viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
      pageCategory: 'gov',
      pageTitle: 'Citizen Services — Sign in',
      nodes,
      removed: [],
      textRuns,
      history: [],
      clientTiming: {},
      vault,
      policy: defaultPolicy,
      originKey: ORIGIN,
    });

    const bytes = JSON.stringify(context);
    expect(bytes).not.toContain(RAW_AADHAAR);
    expect(bytes).not.toContain(RAW_PASSWORD);

    const passwordNode = context.nodes.find((n) => n.name === 'Password' && n.role === 'textbox')!;
    expect(passwordNode.value).toEqual({ kind: 'presence', entity: 'PASSWORD', len: RAW_PASSWORD.length });

    const aadhaarLine = context.text.find((t) => t.text.includes('Aadhaar on record'))!;
    expect(aadhaarLine.text).toMatch(/⟪AADHAAR#\d+⟫/);

    await expect(guard(context, defaultPolicy, vault)).resolves.not.toThrow();
  });

  it('the profile photo is a real, present <img> element extracted as a vision-eligible node', () => {
    loadFixture();
    const { nodes } = extract();
    const photoNode = nodes.find((n) => n.role === 'img');
    expect(photoNode).toBeDefined();
    // The image's own bytes don't decode here — the fixture is injected via innerHTML rather than
    // real navigation (same reasoning as loadFixture()'s script re-attach below), so the relative
    // `src` never resolves to a real file. When the fixture is opened for real (as the demo
    // operator does) the photo decodes normally; what this test proves is the *layout* claim: a
    // real box with real dimensions exists for the vision pipeline to route to detection, which is
    // exactly what T-6.13's identical CAPTCHA zero-box lesson required an explicit width/height for.
    const img = document.querySelector('img[alt="Profile photo"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    const box = img.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it('clicking submit (both fields already filled, exactly as the demo starts) reaches the fixture\'s own success state', async () => {
    loadFixture();
    const { nodes, graph, containerResolver } = extract();

    // Both fields already hold real values in the DOM when the demo starts (design.md's "a task
    // that requires the sensitive value" — the agent confirms and submits, it does not need to
    // retype what's already there; the Aadhaar-specific type/rehydrate path is proven separately
    // in privacy.spec.ts's zero-egress test). This test's job is narrower and real-browser-only:
    // does a synthetic click actually reach the fixture's own submit handler and complete the task.
    const registry = new NodeResolutionRegistry();
    const index = registry.observe(graph, containerResolver);

    const submitWire = nodes.find((n) => n.name === 'Sign in' && n.role === 'button')!;
    const submitEl = graph.elements.get(submitWire.id)!;

    const clickPreflight = runPreflight({ op: 'click', node: submitWire.id }, registry, index, containerResolver);
    expect(clickPreflight.ok).toBe(true);
    if (clickPreflight.ok) {
      const clickResult = dispatchClick(submitEl, () => true);
      expect(clickResult.ok).toBe(true);
    }

    expect(document.getElementById('login-form')!.hidden).toBe(true);
    expect(document.getElementById('success')!.hidden).toBe(false);
  });
});
