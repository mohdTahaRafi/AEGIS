import { afterEach, describe, expect, it } from 'vitest';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry, type NodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { NodeResolutionRegistry, runPreflight } from '../../src/content/execute/preflight';
import type { WireAction } from '../../src/shared/messages';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(html: string) {
  document.body.innerHTML = html;
  const identity: NodeIdentityRegistry = createNodeIdentityRegistry();
  const containerResolver = new ContainerResolver();
  const registry = new NodeResolutionRegistry();
  const graph = extractScreenGraph(identity, containerResolver, {});
  const index = registry.observe(graph, containerResolver);
  return { graph, index, registry, containerResolver, identity };
}

describe('runPreflight (design.md §5.9/§5.2 AC)', () => {
  it('resolves and passes for a real, on-screen, matching button', () => {
    const { graph, index, registry, containerResolver } = setup(
      '<button style="position:fixed;top:0;left:0;width:100px;height:30px;">Submit</button>',
    );
    const node = graph.nodes.find((n) => n.name === 'Submit')!;
    const action: WireAction = { op: 'click', node: node.id, expect: { role: 'button', name: 'Submit' } };
    const result = runPreflight(action, registry, index, containerResolver);
    expect(result.ok).toBe(true);
  });

  it('rejects NODE_UNRESOLVED for an id nobody ever assigned', () => {
    const { index, registry, containerResolver } = setup('<button>Submit</button>');
    const action: WireAction = { op: 'click', node: 'n-does-not-exist' };
    expect(runPreflight(action, registry, index, containerResolver)).toEqual({ ok: false, reason: 'NODE_UNRESOLVED' });
  });

  it('rejects FACET_ROLE when expect.role no longer matches', () => {
    const { graph, index, registry, containerResolver } = setup('<button>Submit</button>');
    const node = graph.nodes.find((n) => n.name === 'Submit')!;
    const action: WireAction = { op: 'click', node: node.id, expect: { role: 'textbox' } };
    expect(runPreflight(action, registry, index, containerResolver)).toEqual({ ok: false, reason: 'FACET_ROLE' });
  });

  it('rejects FACET_NAME when expect.name no longer matches', () => {
    const { graph, index, registry, containerResolver } = setup('<button>Submit</button>');
    const node = graph.nodes.find((n) => n.name === 'Submit')!;
    const action: WireAction = { op: 'click', node: node.id, expect: { name: 'Cancel' } };
    expect(runPreflight(action, registry, index, containerResolver)).toEqual({ ok: false, reason: 'FACET_NAME' });
  });

  it('rejects HIT_TEST_FAILED for a click target hidden under a transparent overlay (AC-5 / clickjacking guard)', () => {
    const { graph, index, registry, containerResolver } = setup(`
      <div style="position:relative;width:200px;height:100px;">
        <button id="target" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:100px;">Submit</button>
        <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:100px;"></div>
      </div>
    `);
    const node = graph.nodes.find((n) => n.name === 'Submit')!;
    const action: WireAction = { op: 'click', node: node.id };
    expect(runPreflight(action, registry, index, containerResolver)).toEqual({ ok: false, reason: 'HIT_TEST_FAILED' });
  });

  it('rejects DISABLED for typing into a disabled field', () => {
    const { graph, index, registry, containerResolver } = setup('<input id="i" type="text" disabled>');
    const node = graph.nodes.find((n) => n.field?.inputType === 'text')!;
    const action: WireAction = { op: 'type', node: node.id, text: 'hi' };
    expect(runPreflight(action, registry, index, containerResolver)).toEqual({ ok: false, reason: 'DISABLED' });
  });

  it('does not hit-test a type action (only pointer ops need the clickjacking guard)', () => {
    const { graph, index, registry, containerResolver } = setup(`
      <div style="position:relative;width:200px;height:40px;">
        <input id="i" type="text" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:40px;">
        <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:40px;"></div>
      </div>
    `);
    const node = graph.nodes.find((n) => n.field?.inputType === 'text')!;
    const action: WireAction = { op: 'type', node: node.id, text: 'hi' };
    const result = runPreflight(action, registry, index, containerResolver);
    expect(result.ok).toBe(true);
  });

  it('a node replaced by an identical one still resolves (T-2.12 AC, exercised through preflight)', () => {
    const { graph, registry, containerResolver, identity } = setup('<button id="a">Delete</button>');
    const originalId = graph.nodes.find((n) => n.name === 'Delete')!.id;

    document.body.innerHTML = '<button id="a">Delete</button>'; // remove original, insert identical
    const secondGraph = extractScreenGraph(identity, containerResolver, {});
    const secondIndex = registry.observe(secondGraph, containerResolver);
    // The identity registry reuses the old id for an unambiguous identical replacement.
    expect(secondGraph.nodes.find((n) => n.name === 'Delete')!.id).toBe(originalId);

    const action: WireAction = { op: 'click', node: originalId };
    expect(runPreflight(action, registry, secondIndex, containerResolver).ok).toBe(true);
  });

  it('rejects NODE_VOLATILE for a target the live isVolatile predicate flags (T-6.7, design.md §5.5)', () => {
    const { graph, index, registry, containerResolver } = setup('<button>Submit</button>');
    const node = graph.nodes.find((n) => n.name === 'Submit')!;
    const action: WireAction = { op: 'click', node: node.id };
    const result = runPreflight(action, registry, index, containerResolver, () => true);
    expect(result).toEqual({ ok: false, reason: 'NODE_VOLATILE' });
  });

  it("allows typing into a live editor (Gmail's message body keeps changing), still refuses clicking it", () => {
    const { graph, index, registry, containerResolver } = setup('<div contenteditable="true" role="textbox" aria-label="Message Body" style="width:300px;height:80px"></div>');
    const node = graph.nodes.find((n) => n.name === 'Message Body')!;
    expect(runPreflight({ op: 'type', node: node.id, text: 'hi' }, registry, index, containerResolver, () => true).ok).toBe(true);
    expect(runPreflight({ op: 'click', node: node.id }, registry, index, containerResolver, () => true)).toEqual({ ok: false, reason: 'NODE_VOLATILE' });
  });

  it('a scroll action (no resolved node id) is never subject to the volatile check', () => {
    const { index, registry, containerResolver } = setup('<div></div>');
    const action: WireAction = { op: 'scroll', direction: 'down' };
    const result = runPreflight(action, registry, index, containerResolver, () => true);
    expect(result.ok).toBe(true);
  });
});
