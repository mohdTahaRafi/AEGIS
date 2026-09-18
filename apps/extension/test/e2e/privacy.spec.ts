// phase_3_privacy_core.md §12's milestone / T-3.35-3.38 — end-to-end, in a real browser, against
// the real profile-aadhaar.html fixture. This is the strongest available proof for AC-2, AC-6,
// AC-11 and the zero-egress claim in this sandboxed environment: real DOM extraction (Channel D +
// the protected-value rule), real Channel T recognizers, real fusion, a real vault, and the real
// guard, all wired together exactly as `host/session.ts` wires them — just without a live gateway
// round trip (that half is proven separately: server/gateway/tests + test/unit/session.spec.ts's
// fakes cover the orchestration; this file covers "does the privacy pipeline actually redact/
// block/resolve on a real page").

import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it, afterEach } from 'vitest';
import fixtureHtml from '../fixtures/profile-aadhaar.html?raw';
import { dispatchType } from '../../src/content/execute/dispatch';
import { NodeResolutionRegistry, runPreflight } from '../../src/content/execute/preflight';
import { extractScreenGraph, type ExtractedGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { extractTextRuns } from '../../src/content/detect/spans';
import { resolveRehydration } from '../../src/host/actions/rehydrate';
import { buildSanitizedContext } from '../../src/host/privacy/context/builder';
import { GuardBlockedError, guard } from '../../src/host/privacy/guard/guard';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode, WireTextRun } from '../../src/shared/messages';

const RAW_AADHAAR = '234567890124';
const RAW_PASSWORD = 'hunter2-correct-battery';
const ORIGIN = 'origin:test-fixture';

afterEach(() => {
  document.body.innerHTML = '';
});

function loadFixture(): void {
  const bodyMatch = fixtureHtml.match(/<body>([\s\S]*)<\/body>/);
  document.body.innerHTML = bodyMatch![1]!;
}

function extract(): { nodes: WireScreenNode[]; textRuns: WireTextRun[]; graph: ExtractedGraph; containerResolver: ContainerResolver } {
  const identity = createNodeIdentityRegistry();
  const containerResolver = new ContainerResolver();
  const graph = extractScreenGraph(identity, containerResolver, {});
  const nodes = graph.nodes.map(({ key: _key, ...wire }) => wire);
  const viewport = { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight };
  const textRuns = extractTextRuns(document.body, viewport);
  return { nodes, textRuns, graph, containerResolver };
}

function buildCtx(vault: Vault, nodes: WireScreenNode[], textRuns: WireTextRun[], task = 'log in and submit the form') {
  return buildSanitizedContext({
    stepId: 's-1',
    task,
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
    pageCategory: 'gov',
    pageTitle: 'Citizen Profile',
    nodes,
    removed: [],
    textRuns,
    history: [],
    clientTiming: {},
    vault,
    policy: defaultPolicy,
    originKey: ORIGIN,
  });
}

describe('AC-2 — no Aadhaar number and no password character in any outbound payload', () => {
  it('the real fixture, fully extracted and sanitized, contains neither raw value anywhere', async () => {
    loadFixture();
    const { nodes, textRuns } = extract();
    const vault = new Vault();
    const context = buildCtx(vault, nodes, textRuns);

    const bytes = JSON.stringify(context);
    expect(bytes).not.toContain(RAW_AADHAAR);
    expect(bytes).not.toContain('23456789 0124'.replace(' ', '')); // ungrouped, redundant guard
    expect(bytes).not.toContain(RAW_PASSWORD);

    // The password field never had its value read at all (T-3.9) — presence-only, with a length.
    // (The fixture's <label for="password"> also produces a "Password"-named generic node — this
    // must specifically be the textbox, or `.value` would be looking at the wrong node.)
    const passwordNode = context.nodes.find((n) => n.name === 'Password' && n.role === 'textbox')!;
    expect(passwordNode.value).toEqual({ kind: 'presence', entity: 'PASSWORD', len: RAW_PASSWORD.length });

    // The Aadhaar line became a typed placeholder in the outgoing text.
    const aadhaarLine = context.text.find((t) => t.text.includes('Aadhaar on record'))!;
    expect(aadhaarLine.text).toMatch(/⟪AADHAAR#\d+⟫/);

    // An independent scan (the guard) reports zero leaks — it doesn't throw.
    await expect(guard(context, defaultPolicy, vault)).resolves.not.toThrow();
  });
});

describe('AC-6 — forcing a miss causes the guard to block; nothing is sent', () => {
  it('a value that reached the vault but slipped past substitution is blocked (VAULT_LEAK)', async () => {
    loadFixture();
    const { nodes, textRuns } = extract();
    const vault = new Vault();
    const context = buildCtx(vault, nodes, textRuns);

    // Simulates a substitution-pass bug: the Aadhaar number was detected and minted (so the vault
    // knows it) but a second occurrence of the raw value made it into the payload unredacted —
    // exactly what design.md §7.6 step 3 exists to catch.
    const sabotaged = { ...context, task: `${context.task} note: ${RAW_AADHAAR}` };

    let error: unknown;
    try {
      await guard(sabotaged, defaultPolicy, vault);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('VAULT_LEAK');
  });

  it('a value no channel ever detected is caught by the independent pattern re-sweep (PATTERN)', async () => {
    loadFixture();
    // Remove the Aadhaar line from the DOM entirely (not just post-hoc filtering) so NEITHER the
    // text-run walk NOR an ancestor's accessible-name fallback can see it — nothing detects or
    // mints it — then plant the raw value somewhere the substitution pass never walks (design.md's
    // "part of the page the substitution pass does not walk"), simulated by splicing it into the
    // built context afterwards.
    document.getElementById('aadhaar-line')!.remove();
    const { nodes, textRuns } = extract();
    const vault = new Vault();
    const context = buildCtx(vault, nodes, textRuns);
    const sabotaged = { ...context, task: `${context.task} the number is ${RAW_AADHAAR}` };

    let error: unknown;
    try {
      await guard(sabotaged, defaultPolicy, vault);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardBlockedError);
    expect((error as GuardBlockedError).rule).toBe('PATTERN');
  });
});

describe('AC-11 — hard negatives are never redacted', () => {
  it('a tracking number and an order number, both digit-shaped like sensitive values, pass through unredacted', () => {
    loadFixture();
    const { nodes, textRuns } = extract();
    const vault = new Vault();
    const context = buildCtx(vault, nodes, textRuns);

    const trackingLine = context.text.find((t) => t.text.includes('Tracking number'))!;
    const orderLine = context.text.find((t) => t.text.includes('Order #'))!;
    expect(trackingLine.text).toBe('Tracking number: 234567890128');
    expect(orderLine.text).toBe('Order #1234567890123456');
    expect(context.redactions.some((r) => r.entity === 'AADHAAR' && r.confidence < 0.5)).toBe(false);
  });
});

describe('Zero-egress completion (T-3.38)', () => {
  it('resolves the Aadhaar ref locally, into the real DOM field, after confirmation — and the next observation still shows only the ref', () => {
    loadFixture();
    const { nodes, textRuns, graph, containerResolver } = extract();
    const vault = new Vault();
    const firstContext = buildCtx(vault, nodes, textRuns);

    const aadhaarLine = firstContext.text.find((t) => t.text.includes('Aadhaar on record'))!;
    const ref = aadhaarLine.text.match(/⟪AADHAAR#\d+⟫/)![0];

    // The model's plan: type(confirm-aadhaar, ref=⟪AADHAAR#n⟫). Reuses the SAME graph/
    // containerResolver `extract()` just produced — a second, independent `extractScreenGraph`
    // call would assign different (randomly generated) node ids via its own identity registry,
    // making `targetWireNode.id` meaningless to a freshly built resolution index.
    const registry = new NodeResolutionRegistry();
    const index = registry.observe(graph, containerResolver);
    const targetWireNode = nodes.find((n) => n.name === 'Aadhaar number' && n.role === 'textbox')!;
    const targetElement = graph.elements.get(targetWireNode.id)!;

    const resolved = resolveRehydration(vault, defaultPolicy, ref, { originKey: ORIGIN, confirmed: true, targetNode: targetWireNode });
    // The vault stores the value exactly as first captured (design.md §3.4's `value: string`) —
    // here that's the grouped "2345 6789 0124" as it appears in the fixture's prose line, not a
    // digits-only normalization (`normalized` is the digits-only form, used only for matching).
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.replace(/\s+/g, '')).toBe(RAW_AADHAAR);

    const preflight = runPreflight({ op: 'type', node: targetWireNode.id, text: resolved.value }, registry, index, containerResolver);
    expect(preflight.ok).toBe(true);
    if (preflight.ok) {
      const dispatchResult = dispatchType(targetElement, resolved.value, { willMoveFocusNext: false });
      expect(dispatchResult.ok).toBe(true);
    }

    expect((targetElement as HTMLInputElement).value.replace(/\s+/g, '')).toBe(RAW_AADHAAR);

    // The next observation: the field now holds the real value, but re-sanitizing it maps back to
    // the SAME ref (design.md's "same value → same ref"), so the server still only ever sees
    // ⟪AADHAAR#n⟫ — never the real number, in either direction.
    const { nodes: nodesAfter, textRuns: textRunsAfter } = extract();
    const secondContext = buildCtx(vault, nodesAfter, textRunsAfter);
    const bytes = JSON.stringify(secondContext);
    expect(bytes).not.toContain(RAW_AADHAAR);
    const confirmNode = secondContext.nodes.find((n) => n.name === 'Aadhaar number' && n.role === 'textbox')!;
    expect(confirmNode.value).toMatchObject({ kind: 'placeholder', ref });
  });
});
